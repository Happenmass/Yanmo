#!/usr/bin/env bash
# Verify Android sync cryptography, HLC, semantic merge, QR pairing, and HTTP PoP
# contract on host JVM against the Desktop TypeScript reference implementation.
set -euo pipefail
cd "$(dirname "$0")/.."
sdk="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-$HOME/Library/Android/sdk}}"
platform="$sdk/platforms/android-36/android.jar"
java_bin="${JAVA_HOME:+$JAVA_HOME/bin/}"
test -f "$platform"

version=0.0.20131108.vaadin1
jar_path="com/vaadin/external/google/android-json/$version/android-json-$version.jar"
json_jar="$HOME/.m2/repository/$jar_path"
test -f "$json_jar" || { echo "Missing $json_jar; run android/check-polish.sh first"; exit 1; }

bcprov_jar="$(find "$HOME/.gradle/caches/modules-2/files-2.1/org.bouncycastle/bcprov-jdk18on/1.79" -name 'bcprov-jdk18on-1.79.jar' | head -n1)"
test -f "$bcprov_jar" || { echo "Missing bcprov-jdk18on-1.79.jar in Gradle cache"; exit 1; }

desktop_repo="${YANMO_DESKTOP_REPO:-/Users/guhappen/code/Yanmo}"
test -f "$desktop_repo/desktop/sync-crypto.ts" || { echo "Missing Desktop repo at $desktop_repo"; exit 1; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

"${java_bin}javac" --release 17 -encoding UTF-8 -classpath "$json_jar:$bcprov_jar:$platform" -d "$work" \
    android/src/main/java/dev/yanmo/ime/{SyncCrypto,SyncHlc,SyncModels,SyncMerge,AcpmSyncClient,SyncPairing,SyncStorage,SyncStore,NsdHubDiscovery,SyncPolicy,SyncJobService,SyncEngine,SyncManager,AdaptiveVad,Lexicon,Polish,Manuscripts,EditorContext,CorrectionWindow,LocalAsr,ScreenCapture,VoiceFailureHistory,VoiceSession}.java \
    android/tools/SyncContract.java

NODE_PATH="$desktop_repo/node_modules" node --import "$desktop_repo/node_modules/tsx/dist/loader.mjs" - "$work" "$desktop_repo" <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const [work, desktopRepo] = process.argv.slice(2);
const cryptoMod = await import(`${desktopRepo}/desktop/sync-crypto.ts`);
const syncEngine = await import(`${desktopRepo}/desktop/sync-engine.ts`);
const syncPairing = await import(`${desktopRepo}/desktop/sync-pairing.ts`);

const rootSeed = Buffer.alloc(32);
for (let i = 0; i < 32; i++) rootSeed[i] = (i * 13 + 7) & 0xff;
const recoveryCode = cryptoMod.encodeRecoveryCode(rootSeed);
const space = cryptoMod.deriveSpaceKeys(rootSeed);
const macDev = cryptoMod.generateDeviceIdentity();

const sampleTerm = '言墨 · Antigravity/IDE';
const sampleGroup = 'ai_tools';
const lexiconRecordKey = cryptoMod.computeLexiconRecordKey(space.keyMacKey, sampleTerm, sampleGroup);
const sampleBlobPlain = Buffer.from('sample-desktop-audio-or-png-payload-123456', 'utf8');
const sampleBlobHash = (await import('node:crypto')).createHash('sha256').update(sampleBlobPlain).digest('hex');
const blobId = cryptoMod.computeBlobId(space.keyMacKey, sampleBlobHash);
const encryptedBlob = syncEngine.encryptSyncBlob(space.dataEncKey, space.vaultId, blobId, sampleBlobPlain);

const desktopCert = cryptoMod.signMembershipCert(space.ownerPrivateKey, {
  version: 1,
  vault_id: space.vaultId,
  device_id: macDev.deviceId,
  device_pubkey: macDev.publicKeyB64,
  platform: 'macos',
  issued_at_ms: 1764000000000,
});

const lexHlc = '001764000001000-0001-' + macDev.deviceId;
const lexCipher = syncEngine.encryptSyncRecord(
  space.dataEncKey,
  space.vaultId,
  'lexicon',
  lexiconRecordKey,
  lexHlc,
  false,
  {
    schema_version: 1,
    local_id: 'desk-term-1',
    term: sampleTerm,
    hint: '跨端热词',
    aliases: ['AGY'],
    removed_aliases: [],
    group: sampleGroup,
    device_counts: { [macDev.deviceId]: 4 },
    last_matched_at_ms: 1764000001000,
    created_at_ms: 1764000000000,
    intent_hlc: lexHlc,
  },
  macDev.deviceId,
);

const msId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const msUnixMs = 1764000002000;
const msCocoaSec = msUnixMs / 1000 - 978307200;
const msHlc = '001764000002000-0000-' + macDev.deviceId;
const msCipher = syncEngine.encryptSyncRecord(
  space.dataEncKey,
  space.vaultId,
  'manuscript',
  msId,
  msHlc,
  false,
  {
    schema_version: 1,
    id: msId,
    date: msCocoaSec,
    occurred_at: new Date(msUnixMs).toISOString(),
    recording_ended_at_ms: null,
    seconds: 4.5,
    application: 'Cursor',
    original: 'mac original',
    asr_results: [{ engine_name: 'qwen3-asr', transcript: 'mac original' }],
    text: 'Mac 整理稿。',
    polished: true,
    user_edited: false,
    delivery_note: null,
    audio_warning: null,
    source_device_id: macDev.deviceId,
    audio_blob: { blob_id: blobId, format: 'flac', size_bytes: sampleBlobPlain.length },
    screenshot_blob: null,
  },
  macDev.deviceId,
);

const inviteHubId = 'hub-1';
const inviteSecret = Buffer.alloc(32, 0x42);
const inviteSeedBox = cryptoMod.sealPairingSeedBox(
  inviteSecret,
  { root_seed_b64: rootSeed.toString('base64url'), vault_id: space.vaultId, owner_pubkey: space.ownerPublicKeyB64 },
  `yanmo-pair-invite-v1|${inviteHubId}`,
);
const inviteQrUri = syncPairing.encodePairingQrUri({
  v: 1,
  mode: 'invite',
  hub_id: inviteHubId,
  fp: '0123456789abcdef',
  addrs: ['192.168.31.10'],
  port: 18790,
  sid: 'sid-invite-1',
  code: '654321',
  sec: inviteSecret.toString('base64url'),
});

const desktopEph = cryptoMod.generateX25519Keypair();
const joinWaitSessionId = 'sid-join-1';

writeFileSync(join(work, 'in.json'), JSON.stringify({
  recovery_code: recoveryCode,
  vault_id: space.vaultId,
  owner_pubkey: space.ownerPublicKeyB64,
  owner_fp: cryptoMod.computePubkeyFingerprint(space.ownerPublicKeyRaw),
  sample_term: sampleTerm,
  sample_group: sampleGroup,
  lexicon_record_key: lexiconRecordKey,
  sample_blob_plain_b64: sampleBlobPlain.toString('base64url'),
  blob_id: blobId,
  encrypted_blob_b64: encryptedBlob.toString('base64url'),
  desktop_cert: desktopCert,
  desktop_lexicon_change: { record_key: lexiconRecordKey, version_hlc: lexHlc, origin_device_id: macDev.deviceId, ciphertext: lexCipher },
  desktop_manuscript_change: { record_key: msId, version_hlc: msHlc, origin_device_id: macDev.deviceId, ciphertext: msCipher },
  manuscript_unix_ms: msUnixMs,
  invite_hub_id: inviteHubId,
  invite_qr_uri: inviteQrUri,
  invite_seed_box: inviteSeedBox,
  desktop_eph_priv_b64: desktopEph.privateKeyRaw.toString('base64url'),
  desktop_eph_pubkey: desktopEph.publicKeyB64,
  join_wait_session_id: joinWaitSessionId,
}, null, 2));
NODE

"${java_bin}java" -classpath "$work:$json_jar:$bcprov_jar:$platform" \
    dev.yanmo.ime.SyncContract "$work/in.json" "$work/out.json"

NODE_PATH="$desktop_repo/node_modules" node --import "$desktop_repo/node_modules/tsx/dist/loader.mjs" - "$work" "$desktop_repo" <<'NODE'
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const [work, desktopRepo] = process.argv.slice(2);
const cryptoMod = await import(`${desktopRepo}/desktop/sync-crypto.ts`);
const syncEngine = await import(`${desktopRepo}/desktop/sync-engine.ts`);

const input = JSON.parse(readFileSync(join(work, 'in.json'), 'utf8'));
const out = JSON.parse(readFileSync(join(work, 'out.json'), 'utf8'));

const rootSeed = cryptoMod.decodeRecoveryCode(input.recovery_code);
const space = cryptoMod.deriveSpaceKeys(rootSeed);
assert.equal(out.vault_id, space.vaultId);

// Verify Android-signed membership cert in Node TS
assert.equal(cryptoMod.verifyMembershipCert(space.ownerPublicKey, out.android_cert), true);

// Decrypt Android manuscript envelope & check Cocoa timestamp roundtrip
const decMs = syncEngine.decryptSyncRecord(space.dataEncKey, space.vaultId, {
  collection: 'manuscript',
  record_key: out.android_manuscript_record_key,
  version_hlc: out.android_manuscript_hlc,
  origin_device_id: out.android_manuscript_origin,
  deleted: false,
  ciphertext: out.android_manuscript_ciphertext,
});
assert.equal(decMs.original, '安卓原话');
assert.equal(decMs.text, '安卓整理正文。');
assert.equal(decMs.polished, true);
assert.equal(decMs.application, 'com.tencent.mm');
assert.equal(decMs.seconds, 3.25);
assert.ok(Math.abs((decMs.date + 978307200) * 1000 - out.android_manuscript_unix_ms) <= 1);

// Decrypt Android blob
const plainBlob = syncEngine.decryptSyncBlob(
  space.dataEncKey,
  space.vaultId,
  out.android_blob_id,
  Buffer.from(out.android_blob_encrypted_b64, 'base64url'),
);
assert.equal(plainBlob.toString('base64url'), out.android_blob_plain_b64);

// Verify Android PoP headers
const popCheck = cryptoMod.verifyPopHeaders(
  out.android_device_pubkey,
  'POST',
  `/v1/sync/vaults/${space.vaultId}/changes`,
  Buffer.from('{"hello":1}', 'utf8'),
  out.pop_headers,
  { nowMs: out.pop_timestamp },
);
assert.equal(popCheck.ok, true);

// Verify JoinWait X25519 box sealed by Android & opened by Desktop TS
const joinPairKey = cryptoMod.deriveJoinPairKey(
  Buffer.from(input.desktop_eph_priv_b64, 'base64url'),
  out.android_eph_pubkey,
  input.join_wait_session_id,
);
const openedJoinBox = cryptoMod.openPairingSeedBox(
  joinPairKey,
  out.join_wait_seed_box,
  `yanmo-pair-join-v1|${input.join_wait_session_id}`,
);
assert.equal(openedJoinBox.vault_id, space.vaultId);
assert.equal(openedJoinBox.owner_pubkey, space.ownerPublicKeyB64);
assert.equal(openedJoinBox.root_seed_b64, rootSeed.toString('base64url'));
console.log('PASS: Android Java <-> Desktop TS cross-platform crypto, PoP, QR seed-box, semantic merge, and HTTP sync verified');
NODE
