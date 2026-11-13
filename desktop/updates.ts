import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import { access, copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);
const repository = 'Happenmass/Yanmo';
const releaseAPI = 'https://api.github.com/repos/' + repository + '/releases/latest';
const stableVersion = /^v?(\d+)\.(\d+)\.(\d+)$/;
const maxDownloadBytes = 2 * 1024 ** 3;
export class UpdateError extends Error {}

interface Update {
  version: string;
  url: string;
  sha256: string;
  size: number;
}

export async function findUpdate(current: string, fetcher: typeof fetch): Promise<Update | undefined> {
  const response = await fetcher(releaseAPI, {
    headers: { Accept: 'application/vnd.github+json' }, credentials: 'omit',
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new UpdateError('暂时无法检查 GitHub 上的版本，请稍后再试。');
  const release: { tag_name: string; draft: boolean; prerelease: boolean; assets: {
    name: string; state: string; browser_download_url: string; digest: string; size: number;
  }[] } = await response.json();
  const latest = stableVersion.exec(release?.tag_name);
  const installed = stableVersion.exec(current);
  if (!latest || !installed || release.draft || release.prerelease) throw new UpdateError('GitHub 返回的版本信息无效。');
  const difference = latest.slice(1).map((part, index) => Number(part) - Number(installed[index + 1])).find(Boolean);
  if (difference === undefined || difference < 0) return;

  const version = latest.slice(1).join('.');
  const name = 'Yanmo-' + version + '-mac-arm64.zip';
  const url = 'https://github.com/' + repository + '/releases/download/v' + version + '/' + name;
  const asset = Array.isArray(release.assets) && release.assets.find(item => item.name === name && item.state === 'uploaded');
  if (!asset || asset.browser_download_url !== url || !/^sha256:[a-f0-9]{64}$/.test(asset.digest)
      || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > maxDownloadBytes) {
    throw new UpdateError('该版本暂时没有可校验的 Mac 安装包。');
  }
  return { version, url, sha256: asset.digest.slice(7), size: asset.size };
}

export async function stageUpdate(bundle: string, installer: string, update: Update, fetcher: typeof fetch, progress: (percent: number) => void) {
  await access(dirname(bundle), constants.W_OK).catch(() => {
    throw new UpdateError('无法更新当前位置的言墨。请把应用移到可写的「应用程序」目录再试。');
  });
  const staging = await mkdtemp(join(dirname(bundle), '.yanmo-update-'));
  try {
    const archive = join(staging, 'update.zip');
    const signal = AbortSignal.timeout(20 * 60 * 1000);
    const response = await fetcher(update.url, { credentials: 'omit', signal });
    if (!response.ok || !response.body) throw new UpdateError('下载安装包失败，请稍后再试。');
    const sha256 = createHash('sha256');
    let received = 0;
    let percent = -1;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        received += chunk.length;
        if (received > update.size) return done(new UpdateError('安装包大小不匹配。'));
        sha256.update(chunk);
        const next = Math.floor(received * 100 / update.size);
        if (next !== percent) { percent = next; progress(percent); }
        done(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), meter, createWriteStream(archive, { flags: 'wx', mode: 0o600 }), { signal });
    if (received !== update.size || sha256.digest('hex') !== update.sha256) throw new UpdateError('安装包校验失败，请重新下载。');

    const extracted = join(staging, 'extracted');
    await run('/usr/bin/ditto', ['-x', '-k', archive, extracted]);
    const candidates = (await readdir(extracted, { withFileTypes: true })).filter(entry => entry.isDirectory() && entry.name.endsWith('.app'));
    if (candidates.length !== 1 || candidates[0].name !== '言墨.app') throw new UpdateError('安装包内没有找到言墨。');
    const replacement = join(extracted, candidates[0].name);
    const info = join(replacement, 'Contents/Info.plist');
    const { stdout } = await run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', info]);
    if (stdout.trim() !== update.version) throw new UpdateError('安装包版本不匹配。');
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '-R=identifier "org.yanmo.desktop"', replacement])
      .catch(() => { throw new UpdateError('安装包签名校验失败。'); });
    await rm(archive);
    const helper = join(staging, 'install.sh');
    await copyFile(installer, helper);
    return { staging, helper, replacement };
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export async function installOnExit(bundle: string, update: Awaited<ReturnType<typeof stageUpdate>>) {
  const child = spawn('/bin/bash', [update.helper, String(process.pid), bundle, update.replacement, update.staging], {
    cwd: dirname(bundle), detached: true, stdio: 'ignore',
  });
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  child.unref();
}
