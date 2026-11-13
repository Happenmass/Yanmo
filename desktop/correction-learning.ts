/** Conservative local word extraction. No inference request or replacement rule. */
const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
const han = /^\p{Script=Han}+$/u;
const word = /^[\p{L}\p{M}][\p{L}\p{M}\p{N}'’_-]*$/u;
const surnames = new Set('赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜戚谢邹喻柏水窦章云苏潘葛奚范彭郎鲁韦昌马苗凤花方俞任袁柳鲍史唐费廉岑薛雷贺倪汤滕殷罗毕郝邬安常乐于时傅皮卞齐康伍余元卜顾孟平黄和穆萧尹姚邵汪祁毛禹狄米贝明臧计伏成戴谈宋茅庞熊纪舒屈项祝董梁杜阮蓝闵席季麻强贾路娄危江童颜郭梅盛林钟徐邱骆高夏蔡田樊胡凌霍虞万支柯管卢莫经房裘缪解应宗丁宣邓单洪包左石崔吉龚程邢裴陆荣翁荀羊惠甄曲封芮储靳段富巫乌焦巴弓牧隗山谷车侯全秋仲伊宫宁仇祖武符刘景詹束龙叶幸司韶郜黎蓟薄印宿白怀蒲台鄂索咸籍赖卓蔺屠蒙池乔阴胥能苍双闻莘党翟谭贡劳逄姬申扶堵冉宰郦雍桑桂濮牛寿通边扈燕冀郏浦尚农温别庄晏柴瞿阎连茹习艾鱼容向古易慎廖庾终暨居衡步都耿满弘匡文寇广阙东欧利师巩聂晁勾敖融冷辛阚简饶曾沙鞠丰巢关蒯相查游权盖益桓公');
const grammatical = new Set(['的', '了', '是', '在', '和', '与', '或', '我', '你', '他', '她', '它', '这', '那', '把', '被', '不', '没', '要', '有', '就', '也', '都', '很', '吗', '呢']);
type Edit = { a: number; b: number; removed: string; added: string };

function edits(a: string, b: string): Edit[] {
  // Bound the LCS table even when an application exposes an enormous editor.
  if (a.length > 2000 || b.length > 4000) return [];
  const width = b.length + 1, table = new Uint16Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--)
    table[i * width + j] = a[i] === b[j] ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
  const result: Edit[] = [];
  let i = 0, j = 0, edit: Edit | undefined;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { if (edit) result.push(edit); edit = undefined; i++; j++; }
    else {
      edit ??= { a: i, b: j, removed: '', added: '' };
      if (i < a.length && (j === b.length || table[(i + 1) * width + j] >= table[i * width + j + 1])) edit.removed += a[i++];
      else edit.added += b[j++];
    }
  }
  if (edit) result.push(edit);
  return result;
}

function wordRange(text: string, start: number, end: number): [number, number] | undefined {
  const parts = [...segmenter.segment(text)];
  let first = parts.findIndex(p => p.index <= start && p.index + p.segment.length > start);
  let last = parts.findIndex(p => p.index < end && p.index + p.segment.length >= end);
  if (first < 0 || last < first || parts.slice(first, last + 1).some(p => !p.isWordLike)) return;
  // ICU splits unfamiliar Chinese names into singleton characters. Join only a
  // short adjacent run; never expand across normal multi-character words.
  const singleton = (i: number) => !!parts[i] && parts[i].segment.length === 1 && han.test(parts[i].segment) && !grammatical.has(parts[i].segment);
  if (singleton(first) && singleton(last)) {
    // Preserve an unfamiliar name's surname, without joining a preceding verb
    // that ICU may also split into individual characters (e.g. 抄 / 送).
    const surname = [first - 1, first - 2].find(i => i >= 0 && singleton(i) && surnames.has(parts[i].segment) && parts.slice(i, first).every(p => p.segment.length === 1));
    if (surname !== undefined) first = surname;
    if (surnames.has(parts[first].segment)) while (last - first < 2 && singleton(last + 1)) last++;
    else {
      let left = first, right = last;
      while (singleton(left - 1)) left--;
      while (singleton(right + 1)) right++;
      if (right - left < 3) { first = left; last = right; }
    }
  }
  return [parts[first].index, parts[last].index + parts[last].segment.length];
}

export function correctedTerms(original: string, final: string): string[] {
  if (!original || original === final) return [];
  const changes = edits(original, final), terms = new Set<string>();
  // Large rewrites are not spelling corrections.
  if (changes.reduce((n, e) => n + e.removed.length, 0) > 24) return [];
  for (const e of changes) {
    const latinInterior = (text: string, position: number) => /[A-Za-z]/.test(text[position - 1] || '') && /[A-Za-z]/.test(text[position] || '');
    const insertion = !e.removed && /^[A-Za-z]{1,3}$/.test(e.added) &&
      (latinInterior(original, e.a) || (e.added === original[e.a - 1] && /[A-Za-z]/.test(original[e.a - 2] || '')));
    const deletion = !e.added && /^[A-Za-z]{1,3}$/.test(e.removed) && latinInterior(final, e.b);
    if (!insertion && !deletion && (!e.removed || !e.added)) continue;
    if (e.removed.length > 12 || e.added.length > 24 || (e.removed && !word.test(e.removed)) || (e.added && !word.test(e.added))) continue;
    const oldRange = wordRange(original, insertion ? e.a - 1 : e.a, insertion ? e.a : e.a + e.removed.length);
    const newRange = wordRange(final, deletion ? e.b - 1 : e.b, deletion ? e.b : e.b + e.added.length);
    if (!oldRange || !newRange) continue;
    const old = original.slice(...oldRange), term = final.slice(...newRange);
    if (old === term || !word.test(term) || term.length < 2 || term.length > 24 || grammatical.has(old) || grammatical.has(term)) continue;
    // A Han word changed into Latin is often an uncommitted pinyin composition.
    if (/\p{Script=Han}/u.test(old) && !/\p{Script=Han}/u.test(term)) continue;
    if (han.test(term) && term.length > 6) continue;
    // Do not learn a phrase spanning several normal words.
    const normalWords = [...segmenter.segment(term)].filter(p => p.isWordLike && p.segment.length > 1);
    if (normalWords.length > 1) continue;
    terms.add(term);
  }
  return [...terms];
}
