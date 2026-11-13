#!/usr/bin/env python3
"""Summarize private paired polish evaluations without exporting real speech."""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import statistics


def load(path, fallback=None):
    return json.loads(path.read_text()) if path.exists() else fallback


def writing_summary(rows):
    preferences = Counter()
    grades = {v: [] for v in ['baseline', 'candidate']}
    for row in rows:
        winners = {row['mapping'][label] for label in row['grades']['best']}
        preferences['tie' if len(winners) > 1 else next(iter(winners))] += 1
        for label, grade in row['grades']['candidates'].items():
            grades[row['mapping'][label]].append(grade)
    return {'judged_pairs': len(rows), 'machine_preferences': dict(preferences),
            'uncertain_pairs': sum(bool(r['grades'].get('uncertain')) for r in rows),
            'variants': {v: {
                'writing_means': {key: round(statistics.mean(g[key] for g in entries), 3)
                                  for key in ['concise', 'clear', 'organization', 'ready']},
                'machine_material_error_cases': sum(not g['intent_ok'] or bool(g['material_errors']) for g in entries),
                'machine_material_error_items': sum(len(g['material_errors']) for g in entries),
            } for v, entries in grades.items() if entries}}


def fence(value):
    import re
    length = max([len(x) for x in re.findall(r'`+', value)] + [2]) + 1
    marker = '`' * max(3, length)
    return marker + 'text\n' + value + '\n' + marker


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    out = args.out.expanduser().resolve()
    root = Path(__file__).resolve().parent.parent
    if out.is_relative_to(root):
        raise ValueError('Private reports must remain outside the repository')
    cases = load(out / 'cases.json')['cases']
    case_by = {c['id']: c for c in cases}
    frozen = load(out / 'frozen.json')
    judgments = load(out / 'judgments.json', [])
    valid_judgments = [r for r in judgments if r.get('grades')]
    summary = {'date': '2026-11-10', 'generation': {}, 'evaluation': {}, 'by_category': {},
               'historical_existing_splits': {}, 'method_limits': [
                   'Historical samples were evaluated in earlier work; they are reused, not a new independent holdout.',
                   'Synthetic cases are targeted boundary probes, not an estimate of daily accuracy.',
                   'DeepSeek generates and judges online outputs; anonymous labels do not eliminate model-family bias.',
                   'Typeless history is a style reference, not an error-free transcription ground truth.',
                   'Cached ASR text is replayed; the microphone, ASR, focus capture and paste pipeline are not retested.',
                   'Machine material-error flags require review and are not confirmed factual-error rates.']}
    all_records = {}
    for provider in ['online', 'local']:
        records = load(out / (provider + '-results.json'), [])
        all_records[provider] = {(r['id'], r['variant']): r for r in records}
        summary['generation'][provider] = {}
        for variant in ['baseline', 'candidate']:
            rows = [r for r in records if r['variant'] == variant]
            good = [r for r in rows if r.get('text') and r.get('finish_reason') == 'stop' and not r.get('error') and not r.get('error_type')]
            summary['generation'][provider][variant] = {
                'recorded': len(rows), 'successful': len(good), 'failed': len(rows) - len(good),
                'median_seconds': round(statistics.median(r['seconds'] for r in good), 3) if good else None,
                'p95_seconds': round(sorted(r['seconds'] for r in good)[max(0, (95 * len(good) + 99) // 100 - 1)], 3) if good else None,
                'max_seconds': round(max(r['seconds'] for r in good), 3) if good else None,
                'retried_requests': sum(r.get('attempts', 1) > 1 for r in rows),
                'mean_output_characters': round(statistics.mean(len(r['text']) for r in good), 2) if good else None,
                'literal_warning_cases': sum(bool(r.get('literal_warnings')) for r in good),
                'model_body_unchanged': all(r.get('model_body_unchanged') for r in good),
                'prompt_tokens_total': sum(r.get('usage', {}).get('prompt_tokens', 0) for r in good),
                'completion_tokens_total': sum(r.get('usage', {}).get('completion_tokens', 0) for r in good),
            }
        for kind in ['historical', 'synthetic']:
            selected = [r for r in valid_judgments if r['provider'] == provider and r['kind'] == kind]
            if selected:
                summary['evaluation'][provider + '_' + kind] = writing_summary(selected)
        categories = sorted({r['category'] for r in valid_judgments if r['provider'] == provider})
        for category in categories:
            rows = [r for r in valid_judgments if r['provider'] == provider and r['category'] == category]
            summary['by_category'][provider + '_' + category] = writing_summary(rows)
    for split in ['dev', 'known-validation', 'fresh']:
        rows = [r for r in valid_judgments if r['provider'] == 'online' and case_by[r['id']]['split'] == split]
        if rows:
            summary['historical_existing_splits'][split] = writing_summary(rows)
    position = load(out / 'position-checks.json', [])
    original_by = {(r['provider'], r['id']): r for r in valid_judgments}
    compared = []
    for row in position:
        old = original_by.get((row['provider'], row['id']))
        if old and row.get('grades'):
            previous = {old['mapping'][x] for x in old['grades']['best']}
            reversed_best = {row['mapping'][x] for x in row['grades']['best']}
            compared.append(previous == reversed_best)
    summary['position_check'] = {'compared': len(compared), 'same_preference': sum(compared),
                                 'changed_preference': len(compared) - sum(compared)}
    verification = {'candidate_file_sha256': hashlib.sha256((out / 'candidate.txt').read_bytes()).hexdigest(),
                    'candidate_matches_frozen': hashlib.sha256((out / 'candidate.txt').read_bytes()).hexdigest() == frozen['candidate_sha256'],
                    'protected_files': {path: hashlib.sha256(Path(path).read_bytes()).hexdigest() == digest
                                        for path, digest in frozen['protected_before'].items()}}
    verification['running_app_and_active_source_untouched'] = all(verification['protected_files'].values())
    summary['verification'] = verification
    (out / 'summary.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2) + '\n')
    (out / 'summary.json').chmod(0o600)
    lines = ['# 自然整理候选配对评测（2026-11-10）', '',
             '固定同一模型与请求参数，只替换system提示词。基线为当前polish.txt；候选为独立候选文件。', '',
             '历史口述与逐条输出仅留本机用户数据目录。下文含私人材料，不进入Git。', '',
             '## 汇总', '', '```json', json.dumps(summary, ensure_ascii=False, indent=2), '```', '',
             '## 逐条对照', '']
    for case in cases:
        lines += ['### ' + case['id'] + ' · ' + case['kind'] + ' · ' + case['category'], '']
        if case.get('expected'):
            lines += ['预先固定的语义预期：' + case['expected'], '']
        request = case['request']
        source = request.get('user_text') or '\n'.join(x['transcript'] for x in request.get('asr_results', [])) or request.get('text', '')
        lines += ['输入：', '', fence(source), '']
        if case.get('reference'):
            lines += ['Typeless历史参考（非真值）：', '', fence(case['reference']), '']
        for provider in ['online', 'local']:
            for variant in ['baseline', 'candidate']:
                row = all_records[provider].get((case['id'], variant))
                if row:
                    lines += [provider + ' / ' + variant + '：', '', fence(row.get('text', '<failed>')), '']
                    if row.get('literal_warnings'):
                        lines += ['字面检查警报（需语义复核）：' + ', '.join(row['literal_warnings']), '']
            judged = next((r for r in valid_judgments if r['provider'] == provider and r['id'] == case['id']), None)
            if judged:
                winners = [judged['mapping'][x] for x in judged['grades']['best']]
                lines += [provider + ' 机器偏好：' + '/'.join(winners), '']
                for label, grade in judged['grades']['candidates'].items():
                    lines += [judged['mapping'][label] + '：' + grade.get('notes', ''), '']
                    for issue in grade['material_errors']:
                        lines += ['- 机器内容警报：' + json.dumps(issue, ensure_ascii=False)]
                if judged['grades'].get('uncertain'):
                    lines += ['', '无法确认的歧义：' + judged['grades']['uncertain'], '']
    (out / 'report.md').write_text('\n'.join(lines) + '\n')
    (out / 'report.md').chmod(0o600)
    print(json.dumps({'judged_pairs': len(valid_judgments), 'groups': summary['evaluation'],
                      'protected_files_unchanged': verification['running_app_and_active_source_untouched']}, ensure_ascii=False))


if __name__ == '__main__':
    main()
