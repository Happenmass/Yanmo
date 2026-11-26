# `acpm-desktop` 跨端发现与同步端点改造任务说明

版本：`v1.0` · 日期：`2026-11-25` · 对应协议：[言墨 × AcpmRuntime 跨端加密同步与发现协议](acpm-sync-protocol.md)。

本文面向 `acpm-desktop`（`acpmd`）侧开发与联调，列出**逐字节对齐**言墨桌面端 Phase 1 已实现代码（[acpm.ts](../../desktop/acpm.ts)、[sync-crypto.ts](../../desktop/sync-crypto.ts)、[sync-discovery.ts](../../desktop/sync-discovery.ts)、[sync-pairing.ts](../../desktop/sync-pairing.ts)）所需的全部服务端改造任务。

---

## 0. 改造目标与分期边界

| 阶段 | 本次是否必做 | 范围 |
| --- | --- | --- |
| **Phase 1（联调门槛）** | **必做** | 持久化 `hub_instance_id` 与 Ed25519 服务端密钥；扩展 `runtime.json`；`_acpm._tcp.local.` mDNS 广播；`paired_devices` 表与内存配对会话；PoP 请求验签 + 响应签名；Phase 1 的 8 个 HTTP 端点 |
| **Phase 2（增量密文同步）** | 预告（建议同步建表） | `sync_records` 表与 `GET/POST /v1/sync/vaults/{vault_id}/changes`（按 `version_hlc` 字典序幂等比较并推进 `seq`） |
| **Phase 3（大附件仓）** | 预告（建议同步建表） | `sync_blobs` 表与 `HEAD/PUT/GET /v1/sync/vaults/{vault_id}/blobs/{blob_id}` |

**核心约束**：
1. **零明文知识**：`acpm-desktop` 永不持有 `root_seed`、`owner_privkey`、`data_enc_key` 或 `key_mac_key`，也不解析言墨词库与文稿明文。
2. **本机零回归**：本机通过 `runtime.json` 读取 `http_base_url` 与 `Authorization: Bearer <token>` 发起的现有推理请求（`/healthz`、`/v1/models`、`/v1/models/prewarm`、`/v1/audio/vad`、`/v1/audio/transcriptions`、`/v1/chat/completions`）必须 **100% 保持向后兼容**。

---

## Task 1：持久化 Hub 身份与 `runtime.json` 扩展

### 1.1 Hub 身份文件持久化
首次启动时，在 `acpm-desktop` 数据目录（如 `~/Library/Application Support/acpm-desktop/` 或 Windows `%LOCALAPPDATA%\acpm-desktop\`）生成并持久化节点身份文件（权限 `0600`，重启后保持不变）：

- `hub_instance_id`：UUIDv4 小写字符串（如 `3c8e2a10-4b5d-4f6a-9c8d-1234567890ab`）。
- `server_keypair`：Ed25519 密钥对（保存 32 字节私钥种子）。
- `server_pubkey`：裸 32 字节 Ed25519 公钥的 **无填充 Base64URL** 编码（43 字符）。
- `server_pubkey_fp`：`SHA256(raw_32B_server_pubkey)` 取前 8 字节转 **16 位小写十六进制**：
  ```text
  server_pubkey_fp = hex_lower(SHA256(raw_32B_server_pubkey)[0..8])
  ```

### 1.2 扩展 `runtime.json`
在保留现有字段不变的前提下，新增以下两个可选字段（见 [acpm.ts](../../desktop/acpm.ts#L11-L24)）：

```json
{
  "version": 1,
  "pid": 12345,
  "started_at": "2026-11-25T05:00:00Z",
  "http_base_url": "http://127.0.0.1:18790",
  "native_ipc_path": "...",
  "token": "...",
  "platform": "darwin-arm64",
  "capabilities": ["llm", "asr", "tts", "vad"],
  "mdns_hostname": "acpm-mac.local",
  "mdns_base_url": "http://acpm-mac.local:18790",
  "hub_instance_id": "3c8e2a10-4b5d-4f6a-9c8d-1234567890ab",
  "server_pubkey_fp": "9f4a1c8e2b7d0341"
}
```

---

## Task 2：mDNS（DNS-SD）服务广播

当用户允许局域网发现/同步服务监听非回环地址时，`acpm-desktop` 注册标准 DNS-SD 服务（对齐 [sync-discovery.ts](../../desktop/sync-discovery.ts#L1-L70)）：

- **服务类型**：`_acpm._tcp.local.`
- **实例名称**：`acpm-<hostname>-<hub_instance_id前4位>`（仅保留合法主机名字符，如 `acpm-macstudio-3c8e`）
- **端口**：实际 HTTP 监听端口（默认 `18790`）
- **SRV / A 记录**：解析到本机有效局域网 IPv4 地址及 `.local` 主机名
- **TXT 记录（全部字段均为 ASCII 字符串）**：

| Key | 必需 | 取值规则 | 说明 |
| --- | --- | --- | --- |
| `v` | 是 | 固定 `"1"` | 发现协议版本 |
| `id` | 是 | `<hub_instance_id>` | 与 `/v1/hub/identity` 返回完全一致 |
| `fp` | 是 | `<server_pubkey_fp>` | 16 位小写十六进制 |
| `sync` | 是 | `"1"` 或 `"0"` | 开启言墨密文同步仓为 `"1"`，仅推理为 `"0"` |
| `api` | 是 | `"/v1"` | API 路径前缀 |

> **禁止事项**：TXT 记录内严禁写入系统用户名、机器用户账号、`vault_id`、Bearer Token 或任何密钥。

---

## Task 3：SQLite 存储与内存会话状态

### 3.1 Phase 1 必建 SQLite 表（数据库文件权限 `0600`）

```sql
CREATE TABLE IF NOT EXISTS vault_owners (
  vault_id TEXT PRIMARY KEY,
  owner_pubkey TEXT NOT NULL,            -- 裸 32B Ed25519 公钥（Base64URL 无填充）
  created_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS paired_devices (
  device_id TEXT PRIMARY KEY,
  device_pubkey TEXT NOT NULL,           -- 裸 32B Ed25519 公钥（Base64URL 无填充）
  device_name TEXT NOT NULL,
  platform TEXT NOT NULL CHECK(platform IN ('macos', 'windows', 'android')),
  scopes_json TEXT NOT NULL,             -- JSON 数组，如 '["inference","yanmo.sync"]'
  vault_id TEXT,                         -- 仅拥有 yanmo.sync 时非空
  membership_cert_json TEXT,             -- 已验签的 SignedMembershipCert 原文 JSON
  paired_at_ms INTEGER NOT NULL,
  last_seen_at_ms INTEGER,
  revoked_at_ms INTEGER                  -- 非空表示已吊销
);
CREATE INDEX IF NOT EXISTS idx_paired_devices_vault ON paired_devices(vault_id);
```

### 3.2 内存态数据结构（重启即清理，不写盘）

1. **`pairing_sessions`（配对信箱）**：
   - 键：`session_id`（建议 `pair_<16位随机hex>`）。
   - 值：`mode`（`"inviter"` \| `"join_wait"`）、`status`（`"waiting"` \| `"fulfilled"`）、`acpm_pair_code`（8 位高熵随机数字字符串）、`expires_at_ms`（`now + 180_000`）、`failed_attempts`（初始 `0`，累计错误 **5 次立即删除会话**）、`scopes`、`vault_id`、`encrypted_seed_box`、`joiner_eph_pubkey`、`sender_eph_pubkey`。
   - 定期及按请求惰性清理过期会话。
2. **`seen_nonces`（PoP 防重放缓存）**：
   - 键：`(device_id, nonce)`；值：`seen_at_ms`。
   - 保留窗口至少 `150_000` ms（覆盖 PoP ±120 秒时间窗边界）。

### 3.3 Phase 2 / Phase 3 预留表（建议同一迁移脚本预先建立）

```sql
CREATE TABLE IF NOT EXISTS sync_records (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  vault_id TEXT NOT NULL,
  collection TEXT NOT NULL CHECK(collection IN ('lexicon', 'manuscript')),
  record_key TEXT NOT NULL,
  version_hlc TEXT NOT NULL,
  origin_device_id TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  ciphertext BLOB NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  UNIQUE(vault_id, collection, record_key)
);
CREATE INDEX IF NOT EXISTS idx_sync_records_vault_seq ON sync_records(vault_id, seq);

CREATE TABLE IF NOT EXISTS sync_blobs (
  vault_id TEXT NOT NULL,
  blob_id TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  ciphertext BLOB NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (vault_id, blob_id)
);
```

---

## Task 4：双向鉴权中间件（Bearer 兼容 + PoP 验签 + 响应签名）

所有错误响应统一沿用既有 `AcpmError` 结构（见 [acpm.ts](../../desktop/acpm.ts#L298-L319)）：

```json
{
  "error": {
    "code": "UNAUTHORIZED",
    "message": "可读中文或英文错误说明",
    "request_id": "req_...",
    "stage": "SYNC_ADMISSION",
    "detail": "REPLAY_NONCE",
    "native_code": null,
    "elapsed_ms": 1,
    "retryable": false
  }
}
```

### 4.1 入站鉴权分流

1. **通道 A（本机回环兼容）**：
   - 请求携带 `Authorization: Bearer <runtime_token>` 且匹配当前 `runtime.json` token → 视为 `is_local = true`，直接放行本机全权限操作（推理 + 本地配对/设备管理）。
2. **通道 B（远程/同步 PoP 验签，对齐 [sync-crypto.ts](../../desktop/sync-crypto.ts#L343-L413)）**：
   - 必须同时提供以下 4 个请求头：
     - `X-Acpm-Device`: `<device_id>`
     - `X-Acpm-Timestamp`: `<10~16位 Unix 毫秒时间戳字符串>`
     - `X-Acpm-Nonce`: `<随机 Base64URL 字符串>`
     - `X-Acpm-Signature`: `<Base64URL(64B Ed25519 签名)>`
   - 构造待签名原文（严格 UTF-8 换行拼接，无末尾换行）：
     ```text
     <METHOD_UPPER>\n<PATH_AND_QUERY>\n<sha256_hex_lower(raw_request_body)>\n<X-Acpm-Timestamp>\n<X-Acpm-Nonce>
     ```
     - 无请求体时 `raw_request_body` 为空字节串，其 SHA-256 为 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`。
     - `multipart/form-data`（例如远程语音识别 `/v1/audio/transcriptions`）必须对**原始 HTTP 请求体字节**做 SHA-256，因此路由读取完整 body 字节后再交由 multipart 解析器解析。
   - 按顺序校验：
     1. 查询 `paired_devices`：找不到返回 `401 UNAUTHORIZED`；`revoked_at_ms IS NOT NULL` 返回 `403 FORBIDDEN`。
     2. 校验 `|now_ms - timestamp_ms| <= 120000`，超时返回 `401 UNAUTHORIZED`（`detail: "TIMESTAMP_SKEW_EXCEEDED"`）。
     3. 校验 `(device_id, nonce)` 未出现在 `seen_nonces` 中，重复则返回 `401 UNAUTHORIZED`（`detail: "REPLAY_NONCE"`），通过后写入 `seen_nonces`。
     4. 用 `device_pubkey` 校验 `X-Acpm-Signature`；失败返回 `401 UNAUTHORIZED`（`detail: "INVALID_SIGNATURE"`）。
     5. 更新 `paired_devices.last_seen_at_ms = now_ms`。
     6. **Scope 与空间隔离校验**：
        - 所有现有推理端点（`/v1/models`、`/v1/models/prewarm`、`/v1/audio/vad`、`/v1/audio/transcriptions`、`/v1/chat/completions`）：PoP 调用时必须包含 `"inference"` scope，否则 `403 FORBIDDEN`。
        - 所有同步端点（`/v1/sync/vaults/{vault_id}/*`）：PoP 调用时必须包含 `"yanmo.sync"` scope，且 `device.vault_id === path.vault_id`，否则 `403 FORBIDDEN`。

### 4.2 出站服务端响应签名（客户端强校验）

对齐 [sync-crypto.ts](../../desktop/sync-crypto.ts#L415-L444) 与 [acpm.ts](../../desktop/acpm.ts#L480-L502)：

在所有 `2xx` JSON 响应中附加以下两个响应头：
- `X-Acpm-Server-Timestamp`: `<Unix 毫秒时间戳字符串>`
- `X-Acpm-Server-Signature`: `<Base64URL(Ed25519_Sign(server_privkey, resp_signing_string))>`

其中 `resp_signing_string` 构造规则为：
```text
<client_ref>\n<X-Acpm-Server-Timestamp>\n<sha256_hex_lower(raw_response_body)>
```
**`client_ref` 取值优先级（务必严格一致）**：
1. `GET /v1/hub/identity`：取 Query 参数 `nonce`（若未传则回退请求头 `X-AI-Request-Id`）。
2. PoP 鉴权请求：取请求头 `X-Acpm-Nonce`。
3. 本机 Bearer 请求：取请求头 `X-AI-Request-Id`。

---

## Task 5：Phase 1 全部 8 个 HTTP 端点详细规格

### 端点 1：`GET /v1/hub/identity?nonce=<base64url>`
- **鉴权**：免鉴权（允许新设备配对前核验身份）。
- **响应（`200 OK`，必须附带响应签名头，`client_ref = query.nonce`）**：
  ```json
  {
    "hub_instance_id": "3c8e2a10-4b5d-4f6a-9c8d-1234567890ab",
    "server_pubkey": "<base64url(32B Ed25519 pubkey)>",
    "server_pubkey_fp": "9f4a1c8e2b7d0341",
    "capabilities": ["inference", "yanmo.sync"],
    "sync_protocol_version": 1
  }
  ```

### 端点 2：`POST /v1/sync/vaults/register`
- **鉴权**：通道 A（本机 Bearer）**或** 通道 B（已配对设备 PoP，不要求已有 `yanmo.sync` scope，用于新设备完成扫码后激活 `yanmo.sync`）。
- **请求体**：
  ```json
  {
    "vault_id": "m5x3k9q2r7t4v8w6y1z2a3b4c5",
    "owner_pubkey": "<base64url(32B Ed25519 pubkey)>",
    "device_id": "9f2b7d4e-1b2a-4c3d-9e8f-0123456789ab",
    "device_pubkey": "<base64url(32B Ed25519 pubkey)>",
    "device_name": "Gu的 MacBook Pro",
    "platform": "macos",
    "membership_cert": {
      "version": 1,
      "vault_id": "m5x3k9q2r7t4v8w6y1z2a3b4c5",
      "device_id": "9f2b7d4e-1b2a-4c3d-9e8f-0123456789ab",
      "device_pubkey": "<base64url(32B Ed25519 pubkey)>",
      "platform": "macos",
      "issued_at_ms": 1795584800000,
      "owner_signature": "<base64url(64B Ed25519 sig)>"
    }
  }
  ```
- **服务端校验**：
  1. 若 `vault_owners` 中已有该 `vault_id` 且 `owner_pubkey` 不一致 → 返回 `403 FORBIDDEN`（防止抢注）。
  2. 如果是 PoP 调用，必须满足 `auth.device.device_id === req.device_id` → 否则 `403 FORBIDDEN`。
  3. 核验 `membership_cert` 内部 `vault_id`、`device_id`、`device_pubkey` 与请求外层字段一致，且 `version === 1`。
  4. **验证 `owner_signature`**：对以下 6 个字段按**键名 ASCII/UTF-8 字典序、无任何空白**序列化后用 `owner_pubkey` 做 Ed25519 验签（**注意键序**）：
     ```json
     {"device_id":"...","device_pubkey":"...","issued_at_ms":1795584800000,"platform":"macos","vault_id":"...","version":1}
     ```
     验签失败返回 `403 FORBIDDEN`。
  5. 在同一事务内写入 `vault_owners`（`INSERT OR IGNORE`），并在 `paired_devices` 插入或更新该设备（`scopes` 合并加入 `"inference"` 与 `"yanmo.sync"`，设置 `vault_id`、`revoked_at_ms = NULL`）。
- **响应（`200 OK`）**：
  ```json
  {
    "vault_id": "m5x3k9q2r7t4v8w6y1z2a3b4c5",
    "device_id": "9f2b7d4e-1b2a-4c3d-9e8f-0123456789ab",
    "scopes": ["inference", "yanmo.sync"]
  }
  ```

### 端点 3：`POST /v1/pairing/sessions`
- **鉴权**：通道 A（本机 Bearer）或通道 B（PoP）。
- **请求体**：
  - 邀请模式（`mode = "inviter"`）：
    ```json
    {
      "mode": "inviter",
      "scopes": ["inference", "yanmo.sync"],
      "vault_id": "m5x3k9q2r7t4v8w6y1z2a3b4c5",
      "encrypted_seed_box": "<base64url密文信箱（当仅授 inference 时可省略）>"
    }
    ```
  - 等待加入模式（`mode = "join_wait"`）：
    ```json
    {
      "mode": "join_wait",
      "joiner_eph_pubkey": "<base64url(32B X25519 pubkey)>"
    }
    ```
- **行为**：生成唯一 `session_id`、8 位随机数字 `acpm_pair_code`（CSPRNG）、`expires_at_ms = now + 180_000`。
- **响应（`200 OK`）**：
  ```json
  {
    "session_id": "pair_9a8b7c6d5e4f3a2b",
    "acpm_pair_code": "83920417",
    "expires_at_ms": 1795584980000
  }
  ```

### 端点 4：`GET /v1/pairing/sessions/{session_id}`
- **鉴权（二选一）**：
  - **免 PoP 配对码读取**：请求携带 `X-Acpm-Pair-Code` 头（已有手机扫描新电脑待加入二维码时使用）。校验过期（`404 NOT_FOUND`）和配对码（错 5 次删除会话并 `401`/`403`）。
  - **已认证轮询读取**：通道 A（本机 Bearer）或通道 B（PoP）（新电脑轮询自己创建的 `join_wait` 会话）。
- **用后即焚规则**：当 `mode === "join_wait"` 且 `status === "fulfilled"`，且本次请求来自**已认证轮询读取**（即未携带 `X-Acpm-Pair-Code`）时，返回响应后**立即从内存删除该会话**。
- **响应（`200 OK`）**：
  ```json
  {
    "session_id": "pair_9a8b7c6d5e4f3a2b",
    "mode": "join_wait",
    "status": "fulfilled",
    "expires_at_ms": 1795584980000,
    "joiner_eph_pubkey": "<base64url>",
    "sender_eph_pubkey": "<base64url（fulfilled 时返回）>",
    "encrypted_seed_box": "<base64url（fulfilled 时返回）>"
  }
  ```

### 端点 5：`POST /v1/pairing/redeem`
- **鉴权**：免 PoP、免 Bearer（凭 `session_id` + `acpm_pair_code` 鉴权）。
- **请求体**：
  ```json
  {
    "session_id": "pair_9a8b7c6d5e4f3a2b",
    "acpm_pair_code": "83920417",
    "device_id": "a1b2c3d4-...",
    "device_pubkey": "<base64url(32B Ed25519 pubkey)>",
    "device_name": "Gu的 Pixel",
    "platform": "android",
    "sender_eph_pubkey": "<仅 join_wait 模式必填>",
    "encrypted_seed_box": "<仅 join_wait 模式必填>"
  }
  ```
- **状态与权限处理**：
  1. 会话不存在或已过期 → 返回 `404 NOT_FOUND`。
  2. `acpm_pair_code` 不匹配 → `failed_attempts += 1`；若 `< 5` 返回 `401 UNAUTHORIZED`，若 `>= 5` **立即删除会话** 并返回 `403 FORBIDDEN`。
  3. 验证通过后，在 `paired_devices` 登记或更新该设备，**初始仅授予 `scopes = ["inference"]`**（不直接授予 `yanmo.sync`；客户端拿到 `root_seed` 后会立刻用 PoP 携带 `membership_cert` 调 `POST /v1/sync/vaults/register` 激活 `yanmo.sync`）。
  4. 分支处理：
     - **`mode === "inviter"`**：取出 `encrypted_seed_box` 返回，**立即删除该会话（用后即焚）**。
     - **`mode === "join_wait"`**：保存 `sender_eph_pubkey` 和 `encrypted_seed_box`，将 `status` 置为 `"fulfilled"`（保留供新电脑取走后删除）。
- **响应（`200 OK`）**：
  ```json
  {
    "session_id": "pair_9a8b7c6d5e4f3a2b",
    "mode": "inviter",
    "device_id": "a1b2c3d4-...",
    "scopes": ["inference"],
    "encrypted_seed_box": "<inviter 模式有密文时返回>"
  }
  ```

### 端点 6：`GET /v1/devices`
- **鉴权**：通道 A（本机 Bearer）或通道 B（PoP）。
- **隔离规则**：本机 Bearer 返回全表；PoP 调用时若设备绑定了 `vault_id`，仅返回同 `vault_id` 下的设备列表。
- **响应（`200 OK`）**：
  ```json
  {
    "devices": [
      {
        "device_id": "9f2b7d4e-...",
        "device_pubkey": "<base64url>",
        "device_name": "Gu的 MacBook Pro",
        "platform": "macos",
        "scopes": ["inference", "yanmo.sync"],
        "vault_id": "m5x3k9q2...",
        "paired_at_ms": 1795584800000,
        "last_seen_at_ms": 1795584900000,
        "revoked_at_ms": null
      }
    ]
  }
  ```

### 端点 7：`PATCH /v1/devices/{device_id}`
- **鉴权**：通道 A（本机 Bearer）或通道 B（PoP，且与目标设备同 `vault_id`）。
- **请求体**：`{ "device_name"?: string, "scopes"?: ["inference" | "yanmo.sync"] }`
- **响应（`200 OK`）**：返回更新后的单个设备对象（同 `GET /v1/devices` 元素结构）；设备不存在返回 `404 NOT_FOUND`。

### 端点 8：`DELETE /v1/devices/{device_id}`
- **鉴权**：通道 A（本机 Bearer）或通道 B（PoP，且与目标设备同 `vault_id`）。
- **行为**：将 `paired_devices.revoked_at_ms` 设为当前 Unix 毫秒时间戳（软吊销），后续该设备任何 PoP 请求立即被 `403 FORBIDDEN` 拒绝。
- **响应（`200 OK`）**：`{ "device_id": "...", "revoked_at_ms": 1795585000000 }`。

---

## Task 6：Phase 2 / Phase 3 同步仓端点预告（路由与表结构预留）

| 阶段 | 端点 | 鉴权与关键逻辑 |
| --- | --- | --- |
| Phase 2 | `GET /v1/sync/vaults/{vault_id}/changes?since_seq=0&limit=200` | PoP + `yanmo.sync` + `device.vault_id === vault_id`；按 `seq > since_seq` 升序返回（`limit` 上限 `500`）及当前 `latest_seq`、`has_more` |
| Phase 2 | `POST /v1/sync/vaults/{vault_id}/changes` | PoP + `yanmo.sync` + `device.vault_id === vault_id`；单批上限 `200` 条；在 SQLite 事务内按 ASCII 字节序比较 `incoming.version_hlc > existing.version_hlc` 才更新并分配新 `seq`（`applied`），相等或更旧幂等忽略且**不递增 `seq`**（`noop` / `stale`） |
| Phase 3 | `HEAD / PUT / GET /v1/sync/vaults/{vault_id}/blobs/{blob_id}` | PoP + `yanmo.sync` + `device.vault_id === vault_id`；读写 `sync_blobs` 原始加密字节流（`application/octet-stream`） |

---

## Task 7：跨端实现避坑与联调验收清单

### 7.1 最容易出错的 5 个细节
1. **Base64URL 无填充**：所有公钥（`server_pubkey`、`device_pubkey`、`owner_pubkey`、`sender_eph_pubkey`、`joiner_eph_pubkey`）、签名（`X-Acpm-Signature`、`X-Acpm-Server-Signature`、`owner_signature`）与 Nonce 统一使用 **RFC 4648 Base64URL 且不带 `=` 填充**。
2. **Ed25519 裸 32 字节公钥**：JSON 字段与指纹计算均使用裸 32 字节 Ed25519 公钥，不要输出 PEM 或 ASN.1 SPKI/PKCS#8 DER 字节。
3. **`membership_cert` 规范 JSON**：验签字符串只包含 `device_id`、`device_pubkey`、`issued_at_ms`、`platform`、`vault_id`、`version` 这 6 个键，按字典序排列、无空格；`owner_signature` 本身不参与签名原文。
4. **`GET /v1/hub/identity` 的 `client_ref`**：服务端必须使用 URL 查询参数里的 `nonce` 计算 `X-Acpm-Server-Signature`，而不是 `X-AI-Request-Id`。
5. **多端 `join_wait` 会话生命周期**：手机带 `X-Acpm-Pair-Code` 调用 `GET /v1/pairing/sessions/{id}` 时只读取 `joiner_eph_pubkey`，不能销毁会话；只有等到手机 `POST /v1/pairing/redeem` 投递密文并置 `fulfilled` 后，新电脑经本机通道 `GET` 取走密文时才销毁。

### 7.2 联调验收清单（对照言墨端 `sync-hub-mock.ts` 与 `sync-phase1.test.ts`）

- [ ] 启动 `acpm-desktop` 后检查 `runtime.json` 含稳定不变的 `hub_instance_id` 与 16 位小写 hex `server_pubkey_fp`。
- [ ] 在局域网可用 DNS-SD 工具扫描到 `_acpm._tcp.local.`，TXT 含 `v=1`、`id`、`fp`、`sync=1`、`api=/v1`，无敏感字段。
- [ ] 言墨 Mac 调 `syncEnableLocal`（`POST /v1/sync/vaults/register`）成功写入 `vault_owners` 与 `paired_devices`。
- [ ] 言墨 Mac 生成邀请二维码 → 第二端扫码完成 `hubIdentity` 验签 → `redeemPairingSession` → `registerVault` 激活 `yanmo.sync`；同一二维码二次兑换返回 `404`；连续 5 次错码会话作废。
- [ ] 仅授予 `inference` scope 的设备调用 `/v1/models` 返回 `200`，调用 `/v1/sync/vaults/{vault_id}/changes` 返回 `403`。
- [ ] 同一 `X-Acpm-Nonce` 重放返回 `401`；时间差超过 120 秒返回 `401`；调用 `DELETE /v1/devices/{device_id}` 后该设备立即被 `403` 拦截。
- [ ] 第二台电脑发起 `join_wait` → 已绑定手机反向扫码投递加密信箱 → 新电脑取回并激活同一 `vault_id`。
