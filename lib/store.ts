// The in-memory store: one Store for the whole process, shared by REST,
// GraphQL, MCP and git. Every resource the suite names lives here.
// Repos are keyed by owner/name; the only owner that ever exists is the
// scenario viewer (adaiversen), so any other owner is a 404.
import { gitIdent, isoNow, VIEWER_LOGIN, ZERO_OID, isHex40 } from './util.ts';
import {
  buildCommit,
  buildTreesFromPaths,
  collectReachable,
  findMergeBase,
  flattenTree,
  hashObject,
  isAncestor,
  parseCommit,
  parseTree,
  type GitObj,
} from './gitobj.ts';

export interface Comment {
  id: number;
  body: string;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
}

export interface Label {
  name: string;
  color: string;
}

export interface Pull {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  objects: Map<string, GitObj>;
  refs: Map<string, string>;
  issues: Issue[];
  pulls: Pull[];
  labels: Map<string, Label>;
  nextIssue: number;
  nextPull: number;
  nextComment: number;
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function notFound(message = 'Not Found'): ApiError {
  return new ApiError(404, message);
}

export function conflict(message: string): ApiError {
  return new ApiError(409, message);
}

export function unprocessable(message: string): ApiError {
  return new ApiError(422, message);
}

export class Store {
  repos = new Map<string, Repo>();
  reqCounter = 0;
  nextRepoId = 5000;

  nextRequestId(): string {
    this.reqCounter += 1;
    return `req-${this.reqCounter}`;
  }

  private key(owner: string, name: string): string {
    return `${owner.toLowerCase()}/${name}`;
  }

  createRepo(name: string, description: string, isPrivate: boolean): Repo {
    const key = this.key(VIEWER_LOGIN, name);
    const existing = this.repos.get(key);
    if (existing) throw unprocessable('Repository already exists');
    const repo: Repo = {
      id: this.nextRepoId,
      owner: VIEWER_LOGIN,
      name,
      description,
      isPrivate,
      defaultBranch: 'main',
      objects: new Map(),
      refs: new Map(),
      issues: [],
      pulls: [],
      labels: new Map(),
      nextIssue: 1,
      nextPull: 1,
      nextComment: 1,
    };
    this.nextRepoId += 1;
    this.repos.set(key, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  listRepos(): Repo[] {
    return [...this.repos.values()];
  }

  /** Resolve a branch name, a full ref, or a commit oid to a commit oid. */
  resolveRef(repo: Repo, refish: string | undefined): string | undefined {
    if (!refish) return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    if (refish.startsWith('refs/')) return repo.refs.get(refish);
    const branch = repo.refs.get(`refs/heads/${refish}`);
    if (branch) return branch;
    if (isHex40(refish) && repo.objects.has(refish)) return refish;
    return undefined;
  }

  treeOfCommit(repo: Repo, commitOid: string): string | undefined {
    const obj = repo.objects.get(commitOid);
    if (!obj || obj.type !== 'commit') return undefined;
    return parseCommit(obj.data).tree;
  }

  // ---------------------------------------------------------------- contents

  putContents(
    repo: Repo,
    path: string,
    content: Buffer,
    message: string,
    branch?: string,
  ): { blobSha: string; commitSha: string; created: boolean } {
    const ref = `refs/heads/${branch ?? repo.defaultBranch}`;
    const tip = repo.refs.get(ref);
    const files = tip ? flattenTree(repo.objects, this.treeOfCommit(repo, tip) ?? '') : new Map<string, string>();
    const created = !files.has(path);
    const blobSha = hashObject('blob', content);
    repo.objects.set(blobSha, { type: 'blob', data: content });
    files.set(path, blobSha);
    const { trees, rootOid } = buildTreesFromPaths(files);
    for (const [oid, buf] of trees) repo.objects.set(oid, { type: 'tree', data: buf });
    const ident = gitIdent();
    const commitData = buildCommit(rootOid, tip ? [tip] : [], ident, ident, message);
    const commitSha = hashObject('commit', commitData);
    repo.objects.set(commitSha, { type: 'commit', data: commitData });
    repo.refs.set(ref, commitSha);
    return { blobSha, commitSha, created };
  }

  /** The current blob sha at a path on a branch tip, or undefined. */
  blobShaAt(repo: Repo, path: string, branch?: string): string | undefined {
    const tip = repo.refs.get(`refs/heads/${branch ?? repo.defaultBranch}`);
    if (!tip) return undefined;
    const tree = this.treeOfCommit(repo, tip);
    if (!tree) return undefined;
    return flattenTree(repo.objects, tree).get(path);
  }

  getContents(
    repo: Repo,
    path: string,
    refish?: string,
  ): { kind: 'file'; content: Buffer; sha: string; size: number } | { kind: 'dir'; entries: Array<{ type: string; name: string; path: string; sha: string }> } | null {
    const tip = this.resolveRef(repo, refish);
    if (!tip) return null;
    const treeOid = this.treeOfCommit(repo, tip);
    if (!treeOid) return null;
    if (path === '') {
      const entries = this.dirEntries(repo, treeOid, '');
      return { kind: 'dir', entries };
    }
    const parts = path.split('/');
    let current = treeOid;
    for (let i = 0; i < parts.length; i += 1) {
      const obj = repo.objects.get(current);
      if (!obj || obj.type !== 'tree') return null;
      const entry = parseTree(obj.data).find((e) => e.name === parts[i]);
      if (!entry) return null;
      if (i === parts.length - 1) {
        if (entry.mode === '40000') {
          return { kind: 'dir', entries: this.dirEntries(repo, entry.oid, path) };
        }
        const blob = repo.objects.get(entry.oid);
        if (!blob || blob.type !== 'blob') return null;
        return { kind: 'file', content: blob.data, sha: entry.oid, size: blob.data.length };
      }
      current = entry.oid;
    }
    return null;
  }

  private dirEntries(repo: Repo, treeOid: string, prefix: string): Array<{ type: string; name: string; path: string; sha: string }> {
    const obj = repo.objects.get(treeOid);
    if (!obj || obj.type !== 'tree') return [];
    return parseTree(obj.data).map((e) => ({
      type: e.mode === '40000' ? 'dir' : 'file',
      name: e.name,
      path: prefix ? `${prefix}/${e.name}` : e.name,
      sha: e.oid,
    }));
  }

  deleteContents(repo: Repo, path: string, message: string, branch?: string): { commitSha: string } | null {
    const ref = `refs/heads/${branch ?? repo.defaultBranch}`;
    const tip = repo.refs.get(ref);
    if (!tip) return null;
    const tree = this.treeOfCommit(repo, tip);
    if (!tree) return null;
    const files = flattenTree(repo.objects, tree);
    if (!files.has(path)) return null;
    files.delete(path);
    const { trees, rootOid } = buildTreesFromPaths(files);
    for (const [oid, buf] of trees) repo.objects.set(oid, { type: 'tree', data: buf });
    const ident = gitIdent();
    const commitData = buildCommit(rootOid, [tip], ident, ident, message);
    const commitSha = hashObject('commit', commitData);
    repo.objects.set(commitSha, { type: 'commit', data: commitData });
    repo.refs.set(ref, commitSha);
    return { commitSha };
  }

  // ---------------------------------------------------------------- branches / commits / refs

  listBranches(repo: Repo): Array<{ name: string; sha: string }> {
    const out: Array<{ name: string; sha: string }> = [];
    for (const [ref, sha] of repo.refs) {
      if (ref.startsWith('refs/heads/')) out.push({ name: ref.slice('refs/heads/'.length), sha });
    }
    out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return out;
  }

  listCommits(repo: Repo, refish?: string): Array<{ sha: string; message: string }> {
    const tip = this.resolveRef(repo, refish);
    if (!tip) return [];
    const out: Array<{ sha: string; message: string }> = [];
    const seen = new Set<string>();
    const queue = [tip];
    while (queue.length > 0) {
      const oid = queue.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      const c = parseCommit(obj.data);
      // The stored commit object ends its message with "\n" (git
      // convention, added by buildCommit); the REST API reports the
      // message exactly as submitted, without that trailing newline.
      const message = c.message.endsWith('\n') ? c.message.slice(0, -1) : c.message;
      out.push({ sha: oid, message });
      for (const p of c.parents) queue.push(p);
    }
    return out;
  }

  createRef(repo: Repo, ref: string, sha: string): { ref: string; sha: string } {
    if (!isHex40(sha) || !repo.objects.has(sha)) throw unprocessable('Object does not exist');
    if (repo.refs.has(ref)) throw unprocessable('Reference already exists');
    repo.refs.set(ref, sha);
    return { ref, sha };
  }

  // ---------------------------------------------------------------- labels / issues

  createLabel(repo: Repo, name: string, color: string): Label {
    const label: Label = { name, color };
    repo.labels.set(name, label);
    return label;
  }

  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
    for (const name of labels) {
      if (!repo.labels.has(name)) throw unprocessable(`Label does not exist: ${name}`);
    }
    const issue: Issue = {
      number: repo.nextIssue,
      title,
      body,
      state: 'open',
      labels: [...labels],
      comments: [],
    };
    repo.nextIssue += 1;
    repo.issues.push(issue);
    return issue;
  }

  getIssue(repo: Repo, number: number): Issue | undefined {
    return repo.issues.find((i) => i.number === number);
  }

  listIssues(repo: Repo, state?: string, sort?: string, direction?: string): Issue[] {
    let out = [...repo.issues];
    if (state === 'open') out = out.filter((i) => i.state === 'open');
    else if (state === 'closed') out = out.filter((i) => i.state === 'closed');
    const dir = direction === 'desc' ? -1 : 1;
    if (sort === 'created' || sort === undefined) out.sort((a, b) => (a.number - b.number) * dir);
    return out;
  }

  patchIssue(repo: Repo, number: number, state: 'open' | 'closed'): Issue {
    const issue = this.getIssue(repo, number);
    if (!issue) throw notFound('Issue not found');
    issue.state = state;
    return issue;
  }

  addComment(repo: Repo, number: number, body: string): Comment {
    const issue = this.getIssue(repo, number);
    if (!issue) throw notFound('Issue not found');
    const comment: Comment = { id: repo.nextComment, body };
    repo.nextComment += 1;
    issue.comments.push(comment);
    return comment;
  }

  // ---------------------------------------------------------------- pulls

  createPull(repo: Repo, head: string, base: string, title: string, body: string): Pull {
    const headSha = repo.refs.get(`refs/heads/${head}`);
    const baseSha = repo.refs.get(`refs/heads/${base}`);
    if (!headSha || !baseSha) throw notFound('Head or base branch not found');
    const pull: Pull = {
      number: repo.nextPull,
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef: head,
      baseRef: base,
      headSha,
      baseSha,
    };
    repo.nextPull += 1;
    repo.pulls.push(pull);
    return pull;
  }

  getPull(repo: Repo, number: number): Pull | undefined {
    return repo.pulls.find((p) => p.number === number);
  }

  listPulls(repo: Repo, state?: string): Pull[] {
    if (state === 'all') return [...repo.pulls];
    if (state === 'closed') return repo.pulls.filter((p) => p.state === 'closed');
    return repo.pulls.filter((p) => p.state === 'open');
  }

  private lineCount(data: Buffer): number {
    if (data.length === 0) return 0;
    let n = 0;
    for (let i = 0; i < data.length; i += 1) if (data[i] === 0x0a) n += 1;
    return n === 0 ? 1 : n;
  }

  pullFiles(repo: Repo, pull: Pull): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> {
    const headTree = this.treeOfCommit(repo, pull.headSha);
    const baseTree = this.treeOfCommit(repo, pull.baseSha);
    const headFiles = headTree ? flattenTree(repo.objects, headTree) : new Map<string, string>();
    const baseFiles = baseTree ? flattenTree(repo.objects, baseTree) : new Map<string, string>();
    const out: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> = [];
    const names = new Set([...headFiles.keys(), ...baseFiles.keys()]);
    for (const name of [...names].sort()) {
      const h = headFiles.get(name);
      const b = baseFiles.get(name);
      if (h && !b) {
        const data = repo.objects.get(h)?.data ?? Buffer.alloc(0);
        const additions = this.lineCount(data);
        out.push({ filename: name, status: 'added', additions, deletions: 0, changes: additions });
      } else if (!h && b) {
        const data = repo.objects.get(b)?.data ?? Buffer.alloc(0);
        const deletions = this.lineCount(data);
        out.push({ filename: name, status: 'removed', additions: 0, deletions, changes: deletions });
      } else if (h && b && h !== b) {
        const hd = repo.objects.get(h)?.data ?? Buffer.alloc(0);
        const bd = repo.objects.get(b)?.data ?? Buffer.alloc(0);
        const additions = this.lineCount(hd);
        const deletions = this.lineCount(bd);
        out.push({ filename: name, status: 'modified', additions, deletions, changes: additions + deletions });
      }
    }
    return out;
  }

  /** A pull is conflicted when head and the current base both changed the
   *  same path differently since the merge base. */
  pullConflicted(repo: Repo, pull: Pull): boolean | null {
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
    if (!baseTip) return null;
    const mergeBase = findMergeBase(repo.objects, pull.headSha, baseTip) ?? pull.baseSha;
    const baseTree = this.treeOfCommit(repo, mergeBase);
    const headTree = this.treeOfCommit(repo, pull.headSha);
    const currentTree = this.treeOfCommit(repo, baseTip);
    if (!baseTree || !headTree || !currentTree) return null;
    const baseFiles = flattenTree(repo.objects, baseTree);
    const headFiles = flattenTree(repo.objects, headTree);
    const currentFiles = flattenTree(repo.objects, currentTree);
    const names = new Set([...headFiles.keys(), ...baseFiles.keys(), ...currentFiles.keys()]);
    for (const name of names) {
      const b = baseFiles.get(name);
      const h = headFiles.get(name);
      const c = currentFiles.get(name);
      if (h === b) continue;
      if (c === b) continue;
      if (h === c) continue;
      return true;
    }
    return false;
  }

  mergePull(repo: Repo, pull: Pull): { sha: string; merged: boolean; message: string } {
    if (pull.state !== 'open') throw new ApiError(405, 'Pull request is not open');
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
    if (!baseTip) throw notFound('Base branch not found');
    if (this.pullConflicted(repo, pull)) throw new ApiError(405, 'Merge conflict');
    const mergeBase = findMergeBase(repo.objects, pull.headSha, baseTip) ?? pull.baseSha;
    const baseTree = this.treeOfCommit(repo, mergeBase);
    const headTree = this.treeOfCommit(repo, pull.headSha);
    const currentTree = this.treeOfCommit(repo, baseTip);
    if (!baseTree || !headTree || !currentTree) throw notFound('Missing tree');
    const baseFiles = flattenTree(repo.objects, baseTree);
    const headFiles = flattenTree(repo.objects, headTree);
    const currentFiles = flattenTree(repo.objects, currentTree);
    const mergedFiles = new Map(currentFiles);
    for (const [name, h] of headFiles) {
      if (baseFiles.get(name) !== h) mergedFiles.set(name, h);
    }
    for (const name of baseFiles.keys()) {
      // Deleted on head: drop it when the current base has not changed it.
      if (!headFiles.has(name) && currentFiles.get(name) === baseFiles.get(name)) mergedFiles.delete(name);
    }
    const { trees, rootOid } = buildTreesFromPaths(mergedFiles);
    for (const [oid, buf] of trees) repo.objects.set(oid, { type: 'tree', data: buf });
    const ident = gitIdent();
    const commitData = buildCommit(rootOid, [baseTip], ident, ident, pull.title);
    const sha = hashObject('commit', commitData);
    repo.objects.set(sha, { type: 'commit', data: commitData });
    repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = isoNow();
    pull.mergeCommitSha = sha;
    return { sha, merged: true, message: `Merged pull request #${pull.number}` };
  }

  /** True when newSha is a fast-forward from oldSha (or old is the zero oid). */
  isFastForward(repo: Repo, oldSha: string, newSha: string): boolean {
    if (oldSha === ZERO_OID) return true;
    return isAncestor(repo.objects, oldSha, newSha);
  }

  reachableFrom(repo: Repo, tips: string[]): Set<string> {
    return collectReachable(repo.objects, tips);
  }
}
