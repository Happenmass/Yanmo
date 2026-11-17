import { isTermGroup, Term, TermGroup } from './shared';

export const ASR_HOTWORD_LIMIT = 64;
const APPLICATION_QUOTA = 48;
const GLOBAL_QUOTA = 16;

export function termGroup(category?: string): TermGroup {
  return isTermGroup(category) ? category : 'global';
}

export function termKey(text: string) {
  return text.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
}

function rank(a: Term, b: Term) {
  return (b.matchCount ?? 0) - (a.matchCount ?? 0)
    || (b.lastMatchedAt ?? 0) - (a.lastMatchedAt ?? 0)
    || (b.createdAt ?? 0) - (a.createdAt ?? 0);
}

export function scopedTerms(lexicon: Term[], category?: string) {
  const group = termGroup(category);
  const application = group === 'global' ? [] : lexicon.filter(entry => entry.group === group).sort(rank);
  const global = lexicon.filter(entry => termGroup(entry.group) === 'global').sort(rank);
  const seen = new Set<string>();
  const unique = (entries: Term[]) => entries.filter(entry => {
    const key = termKey(entry.term);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  // Resolve duplicates before applying quotas, so the same word cannot take two places.
  return { application: unique(application), global: unique(global) };
}

export function selectASRHotwords({ application, global }: ReturnType<typeof scopedTerms>) {
  const applicationLimit = APPLICATION_QUOTA + Math.max(0, GLOBAL_QUOTA - global.length);
  const groupWords = application.slice(0, applicationLimit);
  const globalWords = global.slice(0, ASR_HOTWORD_LIMIT - groupWords.length);
  return [...groupWords, ...globalWords].map(entry => entry.term);
}

export function matchedTermIDs(entries: Term[], text: string) {
  const body = termKey(text);
  return new Set(entries.filter(entry => {
    const term = termKey(entry.term);
    if (!term) return false;
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const start = /^[a-z0-9_]/.test(term) ? '(?<![a-z0-9_])' : '';
    const end = /[a-z0-9_]$/.test(term) ? '(?![a-z0-9_])' : '';
    return new RegExp(start + escaped + end).test(body);
  }).map(entry => entry.id));
}
