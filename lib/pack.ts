// Pkt-line framing, packfile codec, and side-band demuxing.
// The suite's git client speaks exactly this; every byte is checked
// against SHA-1, so the codec must be exact.
import { deflateSync, inflateSync } from 'node:zlib';
import { sha1Hex } from './util.ts';
import { CODE_TYPE, TYPE_CODE, type GitObj, type ObjType, hashObject } from './gitobj.ts';

export const PKT_MAX = 65520;
export const PKT_PAYLOAD_MAX = 65516;

/** Encode one pkt-line: 4 ASCII hex length (incl. header) + payload. */
export function pktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  if (len > PKT_MAX) throw new Error(`pkt-line too large: ${len}`);
  const head = Buffer.alloc(4);
  head.write(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_END = Buffer.from('0002', 'ascii');

/** Parse a pkt-line stream into items: {line} for data, {flush}, {delim}, {end}. */
export type PktItem = { kind: 'line'; data: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'end' };

export function parsePktLines(buf: Buffer): PktItem[] {
  const items: PktItem[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const lenHex = buf.toString('ascii', off, off + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(lenHex)) throw new Error(`bad pkt-line header ${JSON.stringify(lenHex)}`);
    const len = parseInt(lenHex, 16);
    if (len === 0) {
      items.push({ kind: 'flush' });
      off += 4;
      continue;
    }
    if (len === 1) {
      items.push({ kind: 'delim' });
      off += 4;
      continue;
    }
    if (len === 2) {
      items.push({ kind: 'end' });
      off += 4;
      continue;
    }
    if (len === 3) throw new Error('pkt-line 0003 is invalid');
    if (len > PKT_MAX) throw new Error(`pkt-line too large: ${len}`);
    if (off + len > buf.length) throw new Error('truncated pkt-line stream');
    items.push({ kind: 'line', data: buf.subarray(off + 4, off + len) });
    off += len;
  }
  if (off !== buf.length) throw new Error('trailing bytes after pkt-line stream');
  return items;
}

/** Split a raw receive-pack body into the pkt-line command block and the pack bytes after the flush. */
export function splitPackBody(buf: Buffer): { commands: Buffer; pack: Buffer } {
  let off = 0;
  while (off + 4 <= buf.length) {
    const lenHex = buf.toString('ascii', off, off + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(lenHex)) break;
    const len = parseInt(lenHex, 16);
    if (len === 0) {
      off += 4;
      break;
    }
    if (len < 4 || len > PKT_MAX || off + len > buf.length) break;
    off += len;
  }
  return { commands: buf.subarray(0, off), pack: buf.subarray(off) };
}

// ---------------------------------------------------------------- packfile

interface PackEntry {
  type: ObjType;
  data: Buffer;
}

/** Build a v2 packfile from plain objects (no deltas), sorted by oid. */
export function buildPack(objects: Map<string, GitObj>, oids: string[]): Buffer {
  const sorted = [...oids].sort();
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(sorted.length, 8);
  parts.push(header);
  for (const oid of sorted) {
    const obj = objects.get(oid);
    if (!obj) continue;
    parts.push(encodePackEntry(obj.type, obj.data));
  }
  const withoutTrailer = Buffer.concat(parts);
  const trailer = Buffer.from(sha1Hex(withoutTrailer), 'hex');
  return Buffer.concat([withoutTrailer, trailer]);
}

function encodePackEntry(type: ObjType, data: Buffer): Buffer {
  const typeCode = TYPE_CODE[type];
  const compressed = deflateSync(data);
  const size = data.length;
  // varint header: type in bits 4-6, low 4 bits of size, then 7 bits per byte.
  const headerBytes: number[] = [];
  let first = (typeCode << 4) | (size & 0x0f);
  let rest = size >> 4;
  if (rest > 0) first |= 0x80;
  headerBytes.push(first);
  while (rest > 0) {
    let b = rest & 0x7f;
    rest >>= 7;
    if (rest > 0) b |= 0x80;
    headerBytes.push(b);
  }
  return Buffer.concat([Buffer.from(headerBytes), compressed]);
}

/** Parse a packfile. Plain entries resolve directly; OFS/REF deltas are applied. */
export function parsePack(buf: Buffer, externalObjects?: Map<string, GitObj>): Map<string, GitObj> {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'PACK') throw new Error('not a PACK file');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const trailer = buf.subarray(buf.length - 20);
  const expect = Buffer.from(sha1Hex(buf.subarray(0, buf.length - 20)), 'hex');
  if (!trailer.equals(expect)) throw new Error('pack trailer checksum mismatch');
  const out = new Map<string, GitObj>();
  // First pass: read entries, keep deltas for a second pass.
  interface RawEntry {
    offset: number;
    type: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
  }
  const raw: RawEntry[] = [];
  let off = 12;
  for (let i = 0; i < count; i += 1) {
    const entryOffset = off;
    let b = buf[off];
    off += 1;
    const type = (b >> 4) & 0x07;
    let size = b & 0x0f;
    let shift = 4;
    while (b & 0x80) {
      b = buf[off];
      off += 1;
      size |= (b & 0x7f) << shift;
      shift += 7;
    }
    let baseOffset: number | undefined;
    let baseOid: string | undefined;
    if (type === 6) {
      // OFS_DELTA: offset varint, value = b&0x7f; while cont: value = ((value+1)*128) + (b&0x7f)
      let v = buf[off] & 0x7f;
      let cont = buf[off] & 0x80;
      off += 1;
      while (cont) {
        const nb = buf[off];
        off += 1;
        v = ((v + 1) * 128) + (nb & 0x7f);
        cont = nb & 0x80;
      }
      baseOffset = entryOffset - v;
    } else if (type === 7) {
      baseOid = buf.subarray(off, off + 20).toString('hex');
      off += 20;
    }
    // The zlib stream: inflate from off; find its consumed length by trial.
    const { data, consumed } = inflateAt(buf, off, size);
    off += consumed;
    raw.push({ offset: entryOffset, type, data, baseOffset, baseOid });
  }
  if (off !== buf.length - 20) throw new Error('pack has stray bytes before the trailer');
  // Resolve plain entries first.
  const byOffset = new Map<number, RawEntry>();
  for (const r of raw) byOffset.set(r.offset, r);
  const resolved = new Map<number, GitObj>();
  const resolve = (r: RawEntry, depth: number): GitObj => {
    if (depth > 100) throw new Error('delta cycle or too deep');
    const hit = resolved.get(r.offset);
    if (hit) return hit;
    let obj: GitObj;
    if (r.type >= 1 && r.type <= 4) {
      obj = { type: CODE_TYPE[r.type], data: r.data };
    } else if (r.type === 6 || r.type === 7) {
      let base: GitObj | undefined;
      if (r.type === 6) {
        const baseRaw = byOffset.get(r.baseOffset!);
        if (!baseRaw) throw new Error('OFS_DELTA base outside the pack');
        base = resolve(baseRaw, depth + 1);
      } else {
        const baseRaw = raw.find((x) => hashObject(CODE_TYPE[x.type] ?? 'blob', x.data) === r.baseOid);
        if (baseRaw) base = resolve(baseRaw, depth + 1);
        else if (externalObjects) base = externalObjects.get(r.baseOid!);
        if (!base) throw new Error('REF_DELTA base not found');
      }
      const data = applyDelta(base.data, r.data);
      obj = { type: base.type, data };
    } else {
      throw new Error(`unknown pack entry type ${r.type}`);
    }
    resolved.set(r.offset, obj);
    return obj;
  };
  for (const r of raw) {
    const obj = resolve(r, 0);
    out.set(hashObject(obj.type, obj.data), obj);
  }
  if (out.size !== count) throw new Error('pack entry count mismatch after resolve');
  return out;
}

/** Inflate a zlib stream starting at off; returns the data and bytes consumed.
 * Fast path: one inflateSync with { info: true }. Node's inflate stops at
 * the stream end and ignores trailing bytes (the next pack entry), and the
 * engine reports exactly how many compressed bytes it consumed — so there
 * is no binary search and no throw-driven probing. The old binary search
 * stays as a fallback for runtimes without the info option. */
function inflateAt(buf: Buffer, off: number, expectedSize: number): { data: Buffer; consumed: number } {
  try {
    const res = inflateSync(buf.subarray(off), { info: true }) as unknown as {
      buffer?: Buffer;
      engine?: { bytesWritten?: number };
    };
    const data = res ? res.buffer : undefined;
    const consumed = res && res.engine ? res.engine.bytesWritten : undefined;
    if (Buffer.isBuffer(data) && typeof consumed === 'number' && Number.isFinite(consumed) && consumed > 0) {
      if (data.length !== expectedSize) throw new Error('could not inflate pack entry');
      return { data, consumed };
    }
  } catch (err) {
    if (err instanceof Error && err.message === 'could not inflate pack entry') throw err;
    // Truncated or corrupt stream: fall through to the binary search,
    // which throws 'could not inflate pack entry' when nothing matches.
  }
  // Fallback: binary-search the consumed length; inflateSync throws on truncation.
  let lo = 1;
  let hi = buf.length - off;
  let found: { data: Buffer; consumed: number } | null = null;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    try {
      const data = inflateSync(buf.subarray(off, off + mid));
      if (data.length === expectedSize) {
        found = { data, consumed: mid };
        hi = mid - 1;
      } else if (data.length < expectedSize) {
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    } catch {
      lo = mid + 1;
    }
  }
  if (!found) throw new Error('could not inflate pack entry');
  return found;
}

/** Apply a git delta stream to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readVarint = (): number => {
    let v = 0;
    let shift = 0;
    for (;;) {
      const b = delta[off];
      off += 1;
      v |= (b & 0x7f) << shift;
      shift += 7;
      if ((b & 0x80) === 0) break;
    }
    return v;
  };
  const sourceSize = readVarint();
  const targetSize = readVarint();
  if (sourceSize !== base.length) throw new Error('delta source size does not match base');
  const parts: Buffer[] = [];
  let produced = 0;
  while (off < delta.length) {
    const op = delta[off];
    off += 1;
    if (op & 0x80) {
      let cpOff = 0;
      let cpSize = 0;
      for (let i = 0; i < 4; i += 1) {
        if (op & (1 << i)) {
          cpOff |= delta[off] << (8 * i);
          off += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if (op & (0x10 << i)) {
          cpSize |= delta[off] << (8 * i);
          off += 1;
        }
      }
      if (cpSize === 0) cpSize = 0x10000;
      parts.push(base.subarray(cpOff, cpOff + cpSize));
      produced += cpSize;
    } else if (op !== 0) {
      const len = op & 0x7f;
      parts.push(delta.subarray(off, off + len));
      off += len;
      produced += len;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (produced !== targetSize) throw new Error('delta output size mismatch');
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- side-band

/** Wrap bytes into side-band-64k band-1 pkt-lines (chunk <= 65516 payload). */
export function sidebandData(data: Buffer): Buffer {
  const chunks: Buffer[] = [];
  for (let off = 0; off < data.length; off += PKT_PAYLOAD_MAX - 1) {
    const slice = data.subarray(off, Math.min(data.length, off + PKT_PAYLOAD_MAX - 1));
    chunks.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  if (chunks.length === 0) chunks.push(pktLine(Buffer.from([1])));
  return Buffer.concat(chunks);
}

/** Demux side-band pkt-lines into band -> bytes. Throws on band 3. */
export function demuxSideband(buf: Buffer): Map<number, Buffer> {
  const bands = new Map<number, Buffer[]>();
  for (const item of parsePktLines(buf)) {
    if (item.kind !== 'line') continue;
    if (item.data.length === 0) continue;
    const band = item.data[0];
    if (band === 3) throw new Error(`side-band error: ${item.data.subarray(1).toString('utf8')}`);
    const arr = bands.get(band) ?? [];
    arr.push(item.data.subarray(1));
    bands.set(band, arr);
  }
  const out = new Map<number, Buffer>();
  for (const [band, arr] of bands) out.set(band, Buffer.concat(arr));
  return out;
}
