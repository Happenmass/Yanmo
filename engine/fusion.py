"""Build the text model's inputs from speech candidates and nearby context."""


def build_polish_payload(request):
    """Keep all per-request data after the fixed ASR post-processing prompt."""
    if request.get('user_text'):
        originals = [{'engine_name': '用户编辑正文', 'transcript': request['user_text']}]
    else:
        originals = request.get('asr_results') or [{'transcript': request.get('text', '')}]
    return {
        'INSTRUCTION': request.get('instruction', ''),
        'AUDIO_CONTEXT': {
            'key_terms': request.get('key_terms', []),
            'application': {'categories': [request.get('category', 'general')], 'name': request.get('application', '言墨')},
            'background_screen_text': request.get('background_screen_text', []),
        },
        'context': {
            'text_before_cursor': (request.get('before') or '')[-300:],
            'text_after_cursor': (request.get('after') or '')[:300],
        },
        'ASR_RESULTS': [
            {'engine_name': item.get('engine_name') or f'ASR {index + 1}', 'transcript': item['transcript']}
            for index, item in enumerate(originals)
        ],
    }


def build_fusion_payload(request, task, target=None):
    originals = request.get('asr_results') or [{'transcript': request.get('text', '')}]
    candidates = [{'id': chr(65 + index), 'transcript': item['transcript'],
                   **({'language': item['language']} if item.get('language') else {})} for index, item in enumerate(originals)]
    payload = {
        'TASK': task,
        'STYLE': request.get('instruction', '忠实保留语气，仅清理无意义填充、重复和标点。'),
        'ASR_RESULTS': candidates,
        'SOURCE_LANGUAGES': list(dict.fromkeys(item['language'] for item in candidates if item.get('language'))) if not request.get('user_text') else [],
        'CONTEXT': {'application': request.get('application', '言墨'), 'category': request.get('category', 'general'),
                    'key_terms': request.get('key_terms', []), 'term_notes': request.get('term_notes', []),
                    'lexicon': request.get('lexicon', []), 'before': (request.get('before') or '')[-300:], 'after': (request.get('after') or '')[:300]},
    }
    if task == 'verbatim':
        payload['STYLE'] = '保留口头表达、语气、填充词和改口，只纠正有依据的识别差异；数字根据实际语义采用自然写法。'
    if request.get('user_text'):
        payload['USER_TEXT'] = request['user_text']
    if target:
        payload['TARGET_LANGUAGE'] = target
    payload['NUMBER_STYLE'] = 'Choose natural number spelling by actual meaning. Prefer Arabic digits for precise amounts and measurements (e.g. 100元). Preserve idioms, fixed phrases, approximate or indefinite expressions and natural grammatical articles.'
    return payload
