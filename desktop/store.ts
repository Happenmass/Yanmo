import { mkdirSync, readFileSync, existsSync, renameSync, writeFileSync, copyFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { Library, Settings, cocoaNow, validateSettings } from './shared';

export function parseLibrary(value: unknown): Library {
  const library = value as Library;
  if (!library || !Array.isArray(library.manuscripts) || !Array.isArray(library.lexicon)) throw new Error('文稿库格式无效。');
  const ids = new Set<string>();
  for (const item of library.manuscripts) {
    if (typeof item.id !== 'string' || ids.has(item.id) || !Number.isFinite(item.date) || !Number.isFinite(item.seconds) || item.seconds < 0 || typeof item.text !== 'string' || typeof item.original !== 'string' || typeof item.application !== 'string' || typeof item.polished !== 'boolean') throw new Error('文稿库中存在无效内容。');
    ids.add(item.id);
    if (item.asrResults !== undefined && (!Array.isArray(item.asrResults) || item.asrResults.some(result => !result || typeof result.engine_name !== 'string' || typeof result.transcript !== 'string' || (result.language != null && typeof result.language !== 'string')))) throw new Error('文稿的识别对照格式无效。');
  }
  for (const item of library.lexicon) if (typeof item.id !== 'string' || typeof item.term !== 'string' || typeof item.hint !== 'string' || (item.aliases !== undefined && (!Array.isArray(item.aliases) || item.aliases.some(alias => typeof alias !== 'string')))) throw new Error('词库格式无效。');
  return library;
}
export class LibraryStore {
  readonly directory: string;
  error = '';
  library: Library = { manuscripts: [], lexicon: [] };
  settings: Settings;
  constructor(directory: string, defaults: Settings, legacyLibrary?: string) {
    this.directory = directory; this.settings = defaults;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    try {
      const settingsPath = join(directory, 'settings.json');
      if (existsSync(settingsPath)) {
        this.settings = { ...defaults, ...JSON.parse(readFileSync(settingsPath, 'utf8')) };
        validateSettings(this.settings);
      } else if (!legacyLibrary || !existsSync(legacyLibrary)) this.settings = { ...defaults, onboarded: false };
      const path = join(directory, 'library.json');
      if (existsSync(path)) this.library = parseLibrary(JSON.parse(readFileSync(path, 'utf8')));
      else if (legacyLibrary && existsSync(legacyLibrary)) {
        this.library = parseLibrary(JSON.parse(readFileSync(legacyLibrary, 'utf8')));
        const backup = join(directory, 'library-v0.3-backup.json');
        if (!existsSync(backup)) { copyFileSync(legacyLibrary, backup); chmodSync(backup, 0o600); }
        this.persist();
      }
    } catch { this.error = '本机数据读取或迁移失败，原文件已保留，已暂停覆盖保存。请检查言墨数据目录。'; }
  }
  persist() {
    if (this.error) throw new Error(this.error);
    parseLibrary(this.library); validateSettings(this.settings);
    for (const [file, value] of [['library.json', this.library], ['settings.json', this.settings]] as const) {
      const path = join(this.directory, file); const temporary = path + '.tmp';
      writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 }); renameSync(temporary, path);
    }
  }
  prune() {
    if (this.settings.retention) this.library.manuscripts = this.library.manuscripts.filter(item => item.date >= cocoaNow() - this.settings.retention * 86400);
  }
}
