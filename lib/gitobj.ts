// Git object model: SHA-1 ids, commit/tree/blob/tag encode/decode, trees
// built from flat paths, reachability walks, ancestry and merge-base.
// Everything here is pure and deterministic; the store keeps the bytes.
import { sha1Hex } from './util.ts';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObj {
  type: ObjType;
  data: Buffer;
}

export const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
export const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function hashObject(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}

export function encodeObject(type: ObjType, data: Buffer): Buffer {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return Buffer.concat([header, data]);
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
  extra: string[];
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  const extra: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
    else if (line.length > 0) extra.push(line);
  }
  return { tree, parents, author, committer, message, extra };
}

export function buildCommit(
  tree: string,
  parents: string[],
  author: string,
  committer: string,
  message: string,
  extra: string[] = [],
): Buffer {
  let s = `tree ${tree}\n`;
  for (const p of parents) s += `parent ${p}\n`;
  s += `author ${author}\n`;
  s += `committer ${committer}\n`;
  for (const e of extra) s += `${e}\n`;
  s += `\n${message}`;
  if (!s.endsWith('\n')) s += '\n';
  return Buffer.from(s, 'utf8');
}

export interface TagInfo {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    const nul = data.indexOf(0x00, sp + 1);
    if (sp === -1 || nul === -1 || nul + 21 > data.length) break;
    const mode = data.toString('ascii', off, sp);
    const name = data.toString('utf8', sp + 1, nul);
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    off = nul + 21;
  }
  return entries;
}

/** Git tree order: byte-compare of the name, a directory as name + '/'. */
function gitSortKey(e: TreeEntry): string {
  return e.mode === '40000' ? `${e.name}/` : e.name;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = gitSortKey(a);
    const kb = gitSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/**
 * Build every tree for a flat path -> blob-oid map, bottom-up.
 * Returns all tree buffers by oid plus the root tree oid.
 */
export function buildTreesFromPaths(files: Map<string, string>): { trees: Map<string, Buffer>; rootOid: string } {
  const trees = new Map<string, Buffer>();
  const byDir = new Map<string, Map<string, { mode: string; oid: string }>>();
  for (const [path, oid] of files) {
    const parts = path.split('/');
    const dir = parts.slice(0, -1).join('/');
    const name = parts[parts.length - 1];
    let m = byDir.get(dir);
    if (!m) {
      m = new Map();
      byDir.set(dir, m);
    }
    m.set(name, { mode: '100644', oid });
  }
  const subdirs = new Map<string, string[]>();
  for (const dir of byDir.keys()) {
    if (dir === '') continue;
    const parent = dir.split('/').slice(0, -1).join('/');
    let arr = subdirs.get(parent);
    if (!arr) {
      arr = [];
      subdirs.set(parent, arr);
    }
    arr.push(dir);
  }
  const buildDir = (dir: string): string => {
    const entries: TreeEntry[] = [];
    const filesHere = byDir.get(dir);
    if (filesHere) {
      for (const [name, v] of filesHere) entries.push({ mode: v.mode, name, oid: v.oid });
    }
    for (const sub of subdirs.get(dir) ?? []) {
      const oid = buildDir(sub);
      entries.push({ mode: '40000', name: sub.split('/').pop()!, oid });
    }
    const buf = buildTree(entries);
    const oid = hashObject('tree', buf);
    trees.set(oid, buf);
    return oid;
  };
  const rootOid = buildDir('');
  return { trees, rootOid };
}

/** Flatten a tree to path -> blob oid, skipping gitlinks. */
export function flattenTree(objects: Map<string, GitObj>, treeOid: string, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (oid: string, pre: string): void => {
    const obj = objects.get(oid);
    if (!obj || obj.type !== 'tree') return;
    for (const e of parseTree(obj.data)) {
      const path = pre ? `${pre}/${e.name}` : e.name;
      if (e.mode === '40000') walk(e.oid, path);
      else if (e.mode !== '160000') out.set(path, e.oid);
    }
  };
  walk(treeOid, prefix);
  return out;
}

/** All oids reachable from the tips (commit -> tree + parents, tag -> target). */
export function collectReachable(objects: Map<string, GitObj>, tips: string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = objects.get(oid);
    if (!obj) continue;
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      if (c.tree) stack.push(c.tree);
      for (const p of c.parents) stack.push(p);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) {
        if (e.mode !== '160000') stack.push(e.oid);
      }
    } else if (obj.type === 'tag') {
      const target = parseTag(obj.data).object;
      if (target) stack.push(target);
    }
  }
  return seen;
}

/** True when anc is an ancestor of desc (or equal), walking parents. */
export function isAncestor(objects: Map<string, GitObj>, anc: string, desc: string): boolean {
  if (anc === desc) return true;
  const seen = new Set<string>();
  const stack = [desc];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) {
      if (p === anc) return true;
      stack.push(p);
    }
  }
  return false;
}

/** The nearest common ancestor of a and b, or null. */
export function findMergeBase(objects: Map<string, GitObj>, a: string, b: string): string | null {
  const distA = new Map<string, number>();
  const qa: Array<[string, number]> = [[a, 0]];
  while (qa.length > 0) {
    const [oid, d] = qa.shift()!;
    if (distA.has(oid)) continue;
    distA.set(oid, d);
    const obj = objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) qa.push([p, d + 1]);
  }
  let best: string | null = null;
  let bestScore = Infinity;
  const seenB = new Set<string>();
  const qb: Array<[string, number]> = [[b, 0]];
  while (qb.length > 0) {
    const [oid, d] = qb.shift()!;
    if (seenB.has(oid)) continue;
    seenB.add(oid);
    if (distA.has(oid)) {
      const score = (distA.get(oid) ?? 0) + d;
      if (score < bestScore) {
        bestScore = score;
        best = oid;
      }
    }
    const obj = objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) qb.push([p, d + 1]);
  }
  return best;
}
