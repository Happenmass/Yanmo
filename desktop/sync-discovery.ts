import dgram from 'node:dgram';
import type { AcpmDiscovery } from './acpm';
import { checkAcpmURL } from './shared';

export const ACPM_MDNS_SERVICE_TYPE = '_acpm._tcp.local';
const MDNS_MULTICAST_ADDR = '224.0.0.251';
const MDNS_PORT = 5353;

const DNS_TYPE_A = 1;
const DNS_TYPE_PTR = 12;
const DNS_TYPE_TXT = 16;
const DNS_TYPE_SRV = 33;
const DNS_CLASS_IN = 1;

export interface ParsedAcpmTxt {
  version: string;
  hubInstanceId: string;
  serverPubkeyFp: string;
  syncEnabled: boolean;
  apiPrefix: string;
  raw: Record<string, string>;
}

export interface DiscoveredAcpmHub {
  serviceName: string;
  host: string;
  addresses: string[];
  port: number;
  hubInstanceId: string;
  serverPubkeyFp: string;
  syncEnabled: boolean;
  apiPrefix: string;
  txt: Record<string, string>;
}

export interface KnownHub {
  hubInstanceId: string;
  hubName: string;
  serverPubkey: string;
  serverPubkeyFp: string;
  lastKnownUrl?: string;
  manualRemoteUrl?: string;
  pairedAtMs: number;
  lastSeenAtMs?: number;
}

export interface MatchKnownHubsResult {
  matched: { known: KnownHub; discovered: DiscoveredAcpmHub }[];
  spoofed: { known: KnownHub; discovered: DiscoveredAcpmHub }[];
  unknown: DiscoveredAcpmHub[];
}

export interface MdnsBrowser {
  discover(timeoutMs?: number): Promise<DiscoveredAcpmHub[]>;
}

export function parseAcpmTxtRecord(txt: Record<string, string>): ParsedAcpmTxt | null {
  const version = txt.v?.trim();
  const hubInstanceId = txt.id?.trim();
  const serverPubkeyFp = txt.fp?.trim().toLowerCase();
  if (version !== '1' || !hubInstanceId || !serverPubkeyFp || !/^[0-9a-f]{16}$/.test(serverPubkeyFp)) {
    return null;
  }
  const apiRaw = txt.api?.trim() || '/v1';
  const apiPrefix = apiRaw.startsWith('/') ? apiRaw : `/${apiRaw}`;
  return {
    version,
    hubInstanceId,
    serverPubkeyFp,
    syncEnabled: txt.sync?.trim() === '1',
    apiPrefix,
    raw: { ...txt },
  };
}

function encodeDnsName(name: string): Buffer {
  const clean = name.replace(/\.+$/, '');
  if (!clean) return Buffer.from([0]);
  const labels = clean.split('.');
  const parts: Buffer[] = [];
  for (const label of labels) {
    const raw = Buffer.from(label, 'utf8');
    if (raw.length === 0 || raw.length > 63) {
      throw new Error(`DNS 标签长度无效: ${label}`);
    }
    parts.push(Buffer.from([raw.length]), raw);
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

function decodeDnsName(buf: Buffer, startOffset: number): { name: string; nextOffset: number } | null {
  const labels: string[] = [];
  let offset = startOffset;
  let endOffset = -1;
  let jumps = 0;

  while (offset < buf.length) {
    const len = buf[offset];
    if (len === 0) {
      if (endOffset === -1) endOffset = offset + 1;
      return { name: labels.join('.'), nextOffset: endOffset };
    }
    if ((len & 0xc0) === 0xc0) {
      if (offset + 1 >= buf.length) return null;
      const pointer = ((len & 0x3f) << 8) | buf[offset + 1];
      if (pointer >= buf.length || jumps >= 32) return null;
      if (endOffset === -1) endOffset = offset + 2;
      offset = pointer;
      jumps++;
      continue;
    }
    if ((len & 0xc0) !== 0) return null;
    offset += 1;
    if (offset + len > buf.length) return null;
    labels.push(buf.subarray(offset, offset + len).toString('utf8'));
    offset += len;
  }
  return null;
}

function normalizeDnsName(name: string): string {
  return name.trim().replace(/\.+$/, '').toLowerCase();
}

export function encodeMdnsPtrQuery(serviceType = ACPM_MDNS_SERVICE_TYPE): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0, 0); // ID
  header.writeUInt16BE(0, 2); // Standard query
  header.writeUInt16BE(1, 4); // QDCOUNT = 1
  const qname = encodeDnsName(serviceType);
  const footer = Buffer.alloc(4);
  footer.writeUInt16BE(DNS_TYPE_PTR, 0);
  footer.writeUInt16BE(DNS_CLASS_IN, 2);
  return Buffer.concat([header, qname, footer]);
}

function buildRr(owner: string, type: number, ttl: number, rdata: Buffer): Buffer {
  const nameBuf = encodeDnsName(owner);
  const meta = Buffer.alloc(10);
  meta.writeUInt16BE(type, 0);
  meta.writeUInt16BE(DNS_CLASS_IN, 2);
  meta.writeUInt32BE(ttl, 4);
  meta.writeUInt16BE(rdata.length, 8);
  return Buffer.concat([nameBuf, meta, rdata]);
}

export function encodeMdnsServiceResponse(hub: DiscoveredAcpmHub, ttl = 120): Buffer {
  const fqInstance = hub.serviceName.endsWith(`.${ACPM_MDNS_SERVICE_TYPE}`)
    ? hub.serviceName
    : `${hub.serviceName}.${ACPM_MDNS_SERVICE_TYPE}`;
  const host = hub.host.endsWith('.local') ? hub.host : `${hub.host}.local`;

  const ptrRdata = encodeDnsName(fqInstance);
  const ptrRr = buildRr(ACPM_MDNS_SERVICE_TYPE, DNS_TYPE_PTR, ttl, ptrRdata);

  const srvHead = Buffer.alloc(6);
  srvHead.writeUInt16BE(0, 0);
  srvHead.writeUInt16BE(0, 2);
  srvHead.writeUInt16BE(hub.port, 4);
  const srvRr = buildRr(fqInstance, DNS_TYPE_SRV, ttl, Buffer.concat([srvHead, encodeDnsName(host)]));

  const txtEntries: Record<string, string> = {
    v: '1',
    id: hub.hubInstanceId,
    fp: hub.serverPubkeyFp,
    sync: hub.syncEnabled ? '1' : '0',
    api: hub.apiPrefix || '/v1',
    ...hub.txt,
  };
  const txtParts = Object.entries(txtEntries).map(([k, v]) => {
    const raw = Buffer.from(`${k}=${v}`, 'utf8');
    return Buffer.concat([Buffer.from([raw.length]), raw]);
  });
  const txtRr = buildRr(fqInstance, DNS_TYPE_TXT, ttl, txtParts.length ? Buffer.concat(txtParts) : Buffer.from([0]));

  const aRrs: Buffer[] = [];
  for (const addr of hub.addresses) {
    const parts = addr.split('.');
    if (parts.length === 4 && parts.every(p => /^\d{1,3}$/.test(p) && Number(p) <= 255)) {
      aRrs.push(buildRr(host, DNS_TYPE_A, ttl, Buffer.from(parts.map(Number))));
    }
  }

  const header = Buffer.alloc(12);
  header.writeUInt16BE(0, 0);
  header.writeUInt16BE(0x8400, 2); // Standard query response, authoritative
  header.writeUInt16BE(1, 6); // ANCOUNT (PTR)
  header.writeUInt16BE(2 + aRrs.length, 10); // ARCOUNT (SRV + TXT + A...)
  return Buffer.concat([header, ptrRr, srvRr, txtRr, ...aRrs]);
}

function parseTxtRdata(rdata: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let offset = 0;
  while (offset < rdata.length) {
    const len = rdata[offset];
    offset += 1;
    if (offset + len > rdata.length) break;
    const entry = rdata.subarray(offset, offset + len).toString('utf8');
    offset += len;
    const eq = entry.indexOf('=');
    if (eq > 0) {
      out[entry.slice(0, eq)] = entry.slice(eq + 1);
    }
  }
  return out;
}

export function parseMdnsPacket(buf: Buffer): DiscoveredAcpmHub[] {
  if (buf.length < 12) return [];
  const qdCount = buf.readUInt16BE(4);
  const anCount = buf.readUInt16BE(6);
  const nsCount = buf.readUInt16BE(8);
  const arCount = buf.readUInt16BE(10);

  let offset = 12;
  for (let i = 0; i < qdCount; i++) {
    const qname = decodeDnsName(buf, offset);
    if (!qname || qname.nextOffset + 4 > buf.length) return [];
    offset = qname.nextOffset + 4;
  }

  const ptrTargets = new Set<string>();
  const srvs = new Map<string, { target: string; port: number }>();
  const txts = new Map<string, Record<string, string>>();
  const ipv4ByHost = new Map<string, string[]>();

  const rrCount = anCount + nsCount + arCount;
  for (let i = 0; i < rrCount; i++) {
    const owner = decodeDnsName(buf, offset);
    if (!owner || owner.nextOffset + 10 > buf.length) break;
    const type = buf.readUInt16BE(owner.nextOffset);
    const rdLength = buf.readUInt16BE(owner.nextOffset + 8);
    const rdataStart = owner.nextOffset + 10;
    const rdataEnd = rdataStart + rdLength;
    if (rdataEnd > buf.length) break;

    const ownerNorm = normalizeDnsName(owner.name);
    const rdata = buf.subarray(rdataStart, rdataEnd);

    if (type === DNS_TYPE_PTR && ownerNorm === ACPM_MDNS_SERVICE_TYPE) {
      const target = decodeDnsName(buf, rdataStart);
      if (target) ptrTargets.add(normalizeDnsName(target.name));
    } else if (type === DNS_TYPE_SRV && rdLength >= 6) {
      const port = rdata.readUInt16BE(4);
      const target = decodeDnsName(buf, rdataStart + 6);
      if (target && port > 0) {
        srvs.set(ownerNorm, { target: normalizeDnsName(target.name), port });
      }
    } else if (type === DNS_TYPE_TXT) {
      const parsed = parseTxtRdata(rdata);
      txts.set(ownerNorm, { ...(txts.get(ownerNorm) ?? {}), ...parsed });
    } else if (type === DNS_TYPE_A && rdLength === 4) {
      const ip = `${rdata[0]}.${rdata[1]}.${rdata[2]}.${rdata[3]}`;
      const list = ipv4ByHost.get(ownerNorm) ?? [];
      if (!list.includes(ip)) list.push(ip);
      ipv4ByHost.set(ownerNorm, list);
    }

    offset = rdataEnd;
  }

  const instances = new Set<string>(ptrTargets);
  for (const owner of srvs.keys()) {
    if (owner.endsWith(`.${ACPM_MDNS_SERVICE_TYPE}`)) instances.add(owner);
  }

  const hubs: DiscoveredAcpmHub[] = [];
  for (const instance of instances) {
    const srv = srvs.get(instance);
    const rawTxt = txts.get(instance);
    if (!srv || !rawTxt) continue;
    const parsedTxt = parseAcpmTxtRecord(rawTxt);
    if (!parsedTxt) continue;
    const suffix = `.${ACPM_MDNS_SERVICE_TYPE}`;
    const serviceName = instance.endsWith(suffix) ? instance.slice(0, -suffix.length) : instance;
    hubs.push({
      serviceName,
      host: srv.target,
      addresses: ipv4ByHost.get(srv.target) ?? [],
      port: srv.port,
      hubInstanceId: parsedTxt.hubInstanceId,
      serverPubkeyFp: parsedTxt.serverPubkeyFp,
      syncEnabled: parsedTxt.syncEnabled,
      apiPrefix: parsedTxt.apiPrefix,
      txt: parsedTxt.raw,
    });
  }
  return hubs;
}

export class UdpMdnsBrowser implements MdnsBrowser {
  async discover(timeoutMs = 2500): Promise<DiscoveredAcpmHub[]> {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const found = new Map<string, DiscoveredAcpmHub>();

    return new Promise((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        try {
          socket.close();
        } catch { /* Socket may already be closed. */ }
        resolve([...found.values()]);
      };

      socket.on('error', () => finish());
      socket.on('message', (msg) => {
        for (const hub of parseMdnsPacket(msg)) {
          const prev = found.get(hub.hubInstanceId);
          if (!prev) {
            found.set(hub.hubInstanceId, hub);
          } else {
            const addresses = [...new Set([...prev.addresses, ...hub.addresses])];
            found.set(hub.hubInstanceId, { ...prev, ...hub, addresses });
          }
        }
      });

      socket.bind(0, () => {
        try {
          socket.addMembership(MDNS_MULTICAST_ADDR);
        } catch { /* Multicast membership may be restricted on some interfaces; direct query still runs. */ }
        const query = encodeMdnsPtrQuery();
        socket.send(query, 0, query.length, MDNS_PORT, MDNS_MULTICAST_ADDR, (err) => {
          if (err) finish();
        });
      });

      timer = setTimeout(finish, timeoutMs);
    });
  }
}

export function matchKnownHubs(
  discovered: DiscoveredAcpmHub[],
  knownHubs: KnownHub[],
): MatchKnownHubsResult {
  const byId = new Map(knownHubs.map(hub => [hub.hubInstanceId, hub]));
  const matched: { known: KnownHub; discovered: DiscoveredAcpmHub }[] = [];
  const spoofed: { known: KnownHub; discovered: DiscoveredAcpmHub }[] = [];
  const unknown: DiscoveredAcpmHub[] = [];

  for (const item of discovered) {
    const known = byId.get(item.hubInstanceId);
    if (!known) {
      unknown.push(item);
      continue;
    }
    if (known.serverPubkeyFp.toLowerCase() === item.serverPubkeyFp.toLowerCase()) {
      matched.push({ known, discovered: item });
    } else {
      spoofed.push({ known, discovered: item });
    }
  }
  return { matched, spoofed, unknown };
}

export function resolveHubBaseUrl(
  knownHub: KnownHub,
  options: {
    localDiscovery?: AcpmDiscovery | null;
    discovered?: DiscoveredAcpmHub | null;
  } = {},
): string | null {
  const { localDiscovery, discovered } = options;
  if (localDiscovery?.hub_instance_id && localDiscovery.hub_instance_id === knownHub.hubInstanceId) {
    return localDiscovery.http_base_url;
  }
  if (discovered && discovered.hubInstanceId === knownHub.hubInstanceId
    && discovered.serverPubkeyFp.toLowerCase() === knownHub.serverPubkeyFp.toLowerCase()) {
    const rawHost = discovered.addresses[0] || discovered.host;
    if (rawHost && discovered.port > 0) {
      const hostOrIp = rawHost.includes(':') && !rawHost.startsWith('[') ? `[${rawHost}]` : rawHost;
      const candidate = `http://${hostOrIp}:${discovered.port}`;
      checkAcpmURL(candidate);
      return candidate;
    }
  }
  if (knownHub.manualRemoteUrl?.trim()) {
    const manual = knownHub.manualRemoteUrl.trim().replace(/\/+$/, '');
    checkAcpmURL(manual);
    return manual;
  }
  if (knownHub.lastKnownUrl?.trim()) {
    const last = knownHub.lastKnownUrl.trim().replace(/\/+$/, '');
    checkAcpmURL(last);
    return last;
  }
  return null;
}
