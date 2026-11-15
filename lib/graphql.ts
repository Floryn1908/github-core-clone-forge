// GraphQL v4: a hand-rolled parser and executor for the documents gh and
// github-mcp-server actually send. No GraphQL library exists server-side;
// the suite's documents are a fixed, small set, so the parser covers
// queries, mutations, variables, enums, inline input objects, lists,
// aliases, inline fragments, named fragments, and __type introspection.
import { ApiError, Store, notFound, type Issue, type Pull, type Repo } from './store.ts';
import { VIEWER_LOGIN, b64url, unb64url } from './util.ts';

// ---------------------------------------------------------------- lexer

type Token =
  | { kind: 'punct'; value: string }
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number };

function lex(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}():[]!=$'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1];
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else out += esc;
          j += 2;
        } else {
          out += input[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      if (input[j] === '-') j += 1;
      let isFloat = false;
      while (j < input.length && /[0-9.]/.test(input[j])) {
        if (input[j] === '.') isFloat = true;
        j += 1;
      }
      const text = input.slice(i, j);
      tokens.push(isFloat ? { kind: 'float', value: parseFloat(text) } : { kind: 'int', value: parseInt(text, 10) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < input.length && /[A-Za-z0-9_]/.test(input[j])) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

// ---------------------------------------------------------------- AST

type Value =
  | { kind: 'var'; name: string }
  | { kind: 'enum'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: Record<string, Value> };

interface FieldNode {
  alias: string | null;
  name: string;
  args: Record<string, Value>;
  selection: FieldNode[];
  fragmentType: string | null;
  isFragment: boolean;
}

interface Operation {
  kind: 'query' | 'mutation';
  name: string | null;
  variables: Record<string, { defaultValue?: Value }>;
  selection: FieldNode[];
}

interface Document {
  operations: Operation[];
  fragments: Record<string, FieldNode[]>;
}

class Parser {
  private pos = 0;
  private tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }
  private next(): Token {
    const t = this.tokens[this.pos];
    if (!t) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return t;
  }
  private expectPunct(value: string): void {
    const t = this.next();
    if (t.kind !== 'punct' || t.value !== value) throw new Error(`expected ${value}, got ${JSON.stringify(t)}`);
  }
  private acceptPunct(value: string): boolean {
    const t = this.peek();
    if (t && t.kind === 'punct' && t.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }
  private expectName(): string {
    const t = this.next();
    if (t.kind !== 'name') throw new Error(`expected a name, got ${JSON.stringify(t)}`);
    return t.value;
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments: Record<string, FieldNode[]> = {};
    while (this.pos < this.tokens.length) {
      const t = this.peek();
      if (t?.kind === 'punct' && t.value === '{') {
        operations.push({ kind: 'query', name: null, variables: {}, selection: this.parseSelectionSet() });
        continue;
      }
      if (t?.kind === 'name' && (t.value === 'query' || t.value === 'mutation')) {
        const kind = t.value as 'query' | 'mutation';
        this.next();
        let name: string | null = null;
        const nextTok = this.peek();
        if (nextTok?.kind === 'name') name = this.next().value as string;
        const variables = this.parseVariableDefinitions();
        const selection = this.parseSelectionSet();
        operations.push({ kind, name, variables, selection });
        continue;
      }
      if (t?.kind === 'name' && t.value === 'fragment') {
        this.next();
        const fragName = this.expectName();
        const onTok = this.expectName();
        if (onTok !== 'on') throw new Error('expected "on" in fragment definition');
        this.expectName(); // type condition (unused; fragments are expanded inline)
        fragments[fragName] = this.parseSelectionSet();
        continue;
      }
      throw new Error(`unexpected token ${JSON.stringify(t)} at top level`);
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): Record<string, { defaultValue?: Value }> {
    const out: Record<string, { defaultValue?: Value }> = {};
    if (!this.acceptPunct('(')) return out;
    while (!this.acceptPunct(')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      this.parseType();
      if (this.acceptPunct('=')) out[name] = { defaultValue: this.parseValue() };
      else out[name] = {};
    }
    return out;
  }

  private parseType(): void {
    if (this.acceptPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.acceptPunct('!');
  }

  private parseSelectionSet(): FieldNode[] {
    this.expectPunct('{');
    const fields: FieldNode[] = [];
    while (!this.acceptPunct('}')) {
      fields.push(this.parseField());
    }
    return fields;
  }

  private parseField(): FieldNode {
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '...') {
      this.next();
      const t = this.peek();
      if (t?.kind === 'name' && t.value === 'on') {
        this.next();
        const typeName = this.expectName();
        const selection = this.parseSelectionSet();
        return { alias: null, name: '', args: {}, selection, fragmentType: typeName, isFragment: true };
      }
      if (t?.kind === 'name') {
        const fragName = this.next().value as string;
        return { alias: null, name: fragName, args: {}, selection: [], fragmentType: null, isFragment: true };
      }
      throw new Error('bad fragment spread');
    }
    const first = this.expectName();
    let alias: string | null = null;
    let name = first;
    if (this.acceptPunct(':')) {
      alias = first;
      name = this.expectName();
    }
    const args = this.parseArguments();
    let selection: FieldNode[] = [];
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '{') {
      selection = this.parseSelectionSet();
    }
    return { alias, name, args, selection, fragmentType: null, isFragment: false };
  }

  private parseArguments(): Record<string, Value> {
    const out: Record<string, Value> = {};
    if (!this.acceptPunct('(')) return out;
    while (!this.acceptPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      out[name] = this.parseValue();
    }
    return out;
  }

  private parseValue(): Value {
    const t = this.next();
    if (t.kind === 'punct' && t.value === '$') return { kind: 'var', name: this.expectName() };
    if (t.kind === 'punct' && t.value === '[') {
      const items: Value[] = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ']')) items.push(this.parseValue());
      this.next();
      return { kind: 'list', items };
    }
    if (t.kind === 'punct' && t.value === '{') {
      const fields: Record<string, Value> = {};
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields[name] = this.parseValue();
      }
      this.next();
      return { kind: 'object', fields };
    }
    if (t.kind === 'string') return { kind: 'string', value: t.value };
    if (t.kind === 'int') return { kind: 'int', value: t.value };
    if (t.kind === 'float') return { kind: 'float', value: t.value };
    if (t.kind === 'name') {
      if (t.value === 'true') return { kind: 'bool', value: true };
      if (t.value === 'false') return { kind: 'bool', value: false };
      if (t.value === 'null') return { kind: 'null' };
      return { kind: 'enum', name: t.value };
    }
    throw new Error(`unexpected value token ${JSON.stringify(t)}`);
  }
}

function resolveValueNode(v: Value, vars: Record<string, unknown>): unknown {
  switch (v.kind) {
    case 'var':
      return vars[v.name];
    case 'enum':
      return v.name;
    case 'string':
    case 'int':
    case 'float':
    case 'bool':
      return v.value;
    case 'null':
      return null;
    case 'list':
      return v.items.map((x) => resolveValueNode(x, vars));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v.fields)) out[k] = resolveValueNode(x, vars);
      return out;
    }
  }
}

function resolveArgs(args: Record<string, Value>, vars: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) out[k] = resolveValueNode(v, vars);
  return out;
}

// ---------------------------------------------------------------- schema

interface TypeDef {
  kind: 'OBJECT' | 'ENUM';
  fields?: string[];
  values?: string[];
}

const TYPES: Record<string, TypeDef> = {
  Query: { kind: 'OBJECT', fields: ['viewer', 'repository', 'node'] },
  Mutation: { kind: 'OBJECT', fields: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'] },
  User: { kind: 'OBJECT', fields: ['login', 'id'] },
  Repository: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
  },
  Issue: { kind: 'OBJECT', fields: ['id', 'number', 'title', 'state', 'body'] },
  PullRequest: { kind: 'OBJECT', fields: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'] },
  Ref: { kind: 'OBJECT', fields: ['name'] },
  IssueConnection: { kind: 'OBJECT', fields: ['nodes', 'pageInfo'] },
  PullRequestConnection: { kind: 'OBJECT', fields: ['nodes', 'pageInfo'] },
  PullRequestFileConnection: { kind: 'OBJECT', fields: ['nodes', 'pageInfo'] },
  PullRequestFile: { kind: 'OBJECT', fields: ['path'] },
  PageInfo: { kind: 'OBJECT', fields: ['hasNextPage', 'endCursor'] },
  CreateIssuePayload: { kind: 'OBJECT', fields: ['issue'] },
  CloseIssuePayload: { kind: 'OBJECT', fields: ['issue'] },
  CreatePullRequestPayload: { kind: 'OBJECT', fields: ['pullRequest'] },
  MergePullRequestPayload: { kind: 'OBJECT', fields: ['pullRequest'] },
  AddCommentPayload: { kind: 'OBJECT', fields: ['commentEdge'] },
  IssueCommentEdge: { kind: 'OBJECT', fields: ['node'] },
  Comment: { kind: 'OBJECT', fields: ['id', 'body'] },
  __Type: { kind: 'OBJECT', fields: ['name', 'kind', 'fields', 'enumValues'] },
  __Field: { kind: 'OBJECT', fields: ['name'] },
  __EnumValue: { kind: 'OBJECT', fields: ['name'] },
  __Schema: { kind: 'OBJECT', fields: ['types'] },
  IssueState: { kind: 'ENUM', values: ['OPEN', 'CLOSED'] },
  MergeableState: { kind: 'ENUM', values: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  PullRequestState: { kind: 'ENUM', values: ['OPEN', 'CLOSED', 'MERGED'] },
  PullRequestMergeMethod: { kind: 'ENUM', values: ['MERGE', 'SQUASH', 'REBASE'] },
  RepositoryPermission: { kind: 'ENUM', values: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  SearchType: { kind: 'ENUM', values: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'PACKAGE', 'MILESTONE', 'WIKI', 'PROJECT', 'ORGANIZATION', 'TOPIC', 'DISCUSSION_COMMENT', 'PULL_REQUEST'] },
  IssueOrderField: { kind: 'ENUM', values: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  OrderDirection: { kind: 'ENUM', values: ['ASC', 'DESC'] },
};

// ---------------------------------------------------------------- wrappers

interface GqlCtx {
  store: Store;
}

function repoGid(repo: Repo): string {
  return b64url(`repo:${repo.owner}/${repo.name}`);
}
function issueGid(repo: Repo, issue: Issue): string {
  return b64url(`issue:${repo.owner}/${repo.name}:${issue.number}`);
}
function pullGid(repo: Repo, pull: Pull): string {
  return b64url(`pull:${repo.owner}/${repo.name}:${pull.number}`);
}
function userGid(login: string): string {
  return b64url(`user:${login}`);
}

type AnyObj = Record<string, unknown>;

function wrapRepo(repo: Repo): AnyObj {
  return { __type: 'Repository', gid: repoGid(repo), repo };
}
function wrapIssue(repo: Repo, issue: Issue): AnyObj {
  return { __type: 'Issue', gid: issueGid(repo, issue), repo, issue };
}
function wrapPull(repo: Repo, pull: Pull): AnyObj {
  return { __type: 'PullRequest', gid: pullGid(repo, pull), repo, pull };
}

function decodeGid(id: string): { kind: string; owner: string; name: string; number?: number; login?: string } | null {
  try {
    const text = unb64url(id);
    const parts = text.split(':');
    if (parts[0] === 'repo' && parts.length === 2) {
      const [owner, name] = parts[1].split('/');
      return { kind: 'repo', owner, name };
    }
    if ((parts[0] === 'issue' || parts[0] === 'pull') && parts.length === 3) {
      const [owner, name] = parts[1].split('/');
      return { kind: parts[0], owner, name, number: parseInt(parts[2], 10) };
    }
    if (parts[0] === 'user' && parts.length === 2) {
      return { kind: 'user', owner: '', name: '', login: parts[1] };
    }
    if (parts[0] === 'comment' && parts.length === 4) {
      const [owner, name] = parts[1].split('/');
      return { kind: 'comment', owner, name, number: parseInt(parts[2], 10) };
    }
  } catch {
    return null;
  }
  return null;
}

// ---------------------------------------------------------------- resolvers

type Resolver = (source: AnyObj, args: Record<string, unknown>, ctx: GqlCtx) => unknown;

function issueCursor(number: number): string {
  return b64url(`issue:${number}`);
}
function cursorNumber(cursor: unknown): number | null {
  if (typeof cursor !== 'string') return null;
  try {
    const text = unb64url(cursor);
    if (!text.startsWith('issue:')) return null;
    const n = parseInt(text.slice('issue:'.length), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function issueConnection(repo: Repo, args: Record<string, unknown>, ctx: GqlCtx): AnyObj {
  let issues = ctx.store.listIssues(repo, undefined, undefined, undefined);
  const states = args.states as string[] | undefined;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((s) => String(s).toLowerCase()));
    issues = issues.filter((i) => wanted.has(i.state));
  }
  const orderBy = (args.orderBy ?? {}) as { field?: string; direction?: string };
  const dir = orderBy.direction === 'DESC' ? -1 : 1;
  issues = [...issues].sort((a, b) => (a.number - b.number) * dir);
  const afterNum = cursorNumber(args.after);
  if (afterNum !== null) {
    issues = dir === 1 ? issues.filter((i) => i.number > afterNum) : issues.filter((i) => i.number < afterNum);
  }
  const first = typeof args.first === 'number' ? args.first : issues.length;
  const page = issues.slice(0, Math.max(0, first));
  const hasNextPage = issues.length > page.length;
  const endCursor = page.length > 0 ? issueCursor(page[page.length - 1].number) : null;
  return {
    __type: 'IssueConnection',
    nodes: page.map((i) => wrapIssue(repo, i)),
    pageInfo: { __type: 'PageInfo', hasNextPage, endCursor },
  };
}

function pullConnection(repo: Repo, args: Record<string, unknown>, ctx: GqlCtx): AnyObj {
  const pulls = ctx.store.listPulls(repo, undefined);
  const first = typeof args.first === 'number' ? args.first : pulls.length;
  const page = pulls.slice(0, Math.max(0, first));
  return {
    __type: 'PullRequestConnection',
    nodes: page.map((p) => wrapPull(repo, p)),
    pageInfo: { __type: 'PageInfo', hasNextPage: pulls.length > page.length, endCursor: null },
  };
}

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => ({ __type: 'User', login: VIEWER_LOGIN, id: '1000', gid: userGid(VIEWER_LOGIN) }),
    repository: (_s, args, ctx) => {
      const repo = ctx.store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
      return repo ? wrapRepo(repo) : null;
    },
    node: (_s, args, ctx) => {
      const decoded = decodeGid(String(args.id ?? ''));
      if (!decoded) return null;
      if (decoded.kind === 'repo') {
        const repo = ctx.store.getRepo(decoded.owner, decoded.name);
        return repo ? wrapRepo(repo) : null;
      }
      if (decoded.kind === 'issue') {
        const repo = ctx.store.getRepo(decoded.owner, decoded.name);
        const issue = repo ? ctx.store.getIssue(repo, decoded.number ?? 0) : undefined;
        return repo && issue ? wrapIssue(repo, issue) : null;
      }
      if (decoded.kind === 'pull') {
        const repo = ctx.store.getRepo(decoded.owner, decoded.name);
        const pull = repo ? ctx.store.getPull(repo, decoded.number ?? 0) : undefined;
        return repo && pull ? wrapPull(repo, pull) : null;
      }
      if (decoded.kind === 'user') {
        return { __type: 'User', login: decoded.login, id: '1000', gid: userGid(decoded.login ?? '') };
      }
      return null;
    },
  },
  Mutation: {
    createIssue: (_s, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGid(String(input.repositoryId ?? ''));
      if (!decoded || decoded.kind !== 'repo') throw new ApiError(422, 'repositoryId does not name a repository');
      const repo = ctx.store.getRepo(decoded.owner, decoded.name);
      if (!repo) throw notFound('Repository not found');
      const issue = ctx.store.createIssue(repo, String(input.title ?? ''), typeof input.body === 'string' ? input.body : '', []);
      return { __type: 'CreateIssuePayload', issue: wrapIssue(repo, issue) };
    },
    closeIssue: (_s, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGid(String(input.issueId ?? ''));
      if (!decoded || decoded.kind !== 'issue') throw new ApiError(422, 'issueId does not name an issue');
      const repo = ctx.store.getRepo(decoded.owner, decoded.name);
      const issue = repo ? ctx.store.getIssue(repo, decoded.number ?? 0) : undefined;
      if (!repo || !issue) throw notFound('Issue not found');
      ctx.store.patchIssue(repo, issue.number, 'closed');
      return { __type: 'CloseIssuePayload', issue: wrapIssue(repo, issue) };
    },
    createPullRequest: (_s, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGid(String(input.repositoryId ?? ''));
      if (!decoded || decoded.kind !== 'repo') throw new ApiError(422, 'repositoryId does not name a repository');
      const repo = ctx.store.getRepo(decoded.owner, decoded.name);
      if (!repo) throw notFound('Repository not found');
      const pull = ctx.store.createPull(
        repo,
        String(input.headRefName ?? ''),
        String(input.baseRefName ?? ''),
        String(input.title ?? ''),
        typeof input.body === 'string' ? input.body : '',
      );
      return { __type: 'CreatePullRequestPayload', pullRequest: wrapPull(repo, pull) };
    },
    mergePullRequest: (_s, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGid(String(input.pullRequestId ?? ''));
      if (!decoded || decoded.kind !== 'pull') throw new ApiError(422, 'pullRequestId does not name a pull request');
      const repo = ctx.store.getRepo(decoded.owner, decoded.name);
      const pull = repo ? ctx.store.getPull(repo, decoded.number ?? 0) : undefined;
      if (!repo || !pull) throw notFound('Pull request not found');
      ctx.store.mergePull(repo, pull);
      return { __type: 'MergePullRequestPayload', pullRequest: wrapPull(repo, pull) };
    },
    addComment: (_s, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGid(String(input.subjectId ?? ''));
      if (!decoded || decoded.kind !== 'issue') throw new ApiError(422, 'subjectId does not name an issue');
      const repo = ctx.store.getRepo(decoded.owner, decoded.name);
      if (!repo) throw notFound('Repository not found');
      const comment = ctx.store.addComment(repo, decoded.number ?? 0, String(input.body ?? ''));
      return {
        __type: 'AddCommentPayload',
        commentEdge: { __type: 'IssueCommentEdge', node: { __type: 'Comment', id: String(comment.id), body: comment.body } },
      };
    },
  },
  User: {
    login: (s) => s.login as string,
    id: (s) => s.id as string,
  },
  Repository: {
    id: (s) => s.gid as string,
    databaseId: (s) => (s.repo as Repo).id,
    name: (s) => (s.repo as Repo).name,
    nameWithOwner: (s) => `${(s.repo as Repo).owner}/${(s.repo as Repo).name}`,
    owner: (s) => ({ __type: 'User', login: (s.repo as Repo).owner, id: '1000', gid: userGid((s.repo as Repo).owner) }),
    // The default branch is a property of the repo, not of its first commit:
    // an unborn repo still answers its default branch name here.
    defaultBranchRef: (s) => ({ __type: 'Ref', name: (s.repo as Repo).defaultBranch }),
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    issue: (s, args, ctx) => {
      const issue = ctx.store.getIssue(s.repo as Repo, Number(args.number));
      return issue ? wrapIssue(s.repo as Repo, issue) : null;
    },
    issues: (s, args, ctx) => issueConnection(s.repo as Repo, args, ctx),
    pullRequests: (s, args, ctx) => pullConnection(s.repo as Repo, args, ctx),
    pullRequest: (s, args, ctx) => {
      const pull = ctx.store.getPull(s.repo as Repo, Number(args.number));
      return pull ? wrapPull(s.repo as Repo, pull) : null;
    },
  },
  Issue: {
    id: (s) => s.gid as string,
    number: (s) => (s.issue as Issue).number,
    title: (s) => (s.issue as Issue).title,
    state: (s) => (s.issue as Issue).state.toUpperCase(),
    body: (s) => (s.issue as Issue).body,
  },
  PullRequest: {
    id: (s) => s.gid as string,
    number: (s) => (s.pull as Pull).number,
    headRefName: (s) => (s.pull as Pull).headRef,
    baseRefName: (s) => (s.pull as Pull).baseRef,
    mergeable: (s, _a, ctx) => {
      const c = ctx.store.pullConflicted(s.repo as Repo, s.pull as Pull);
      return c === true ? 'CONFLICTING' : c === false ? 'MERGEABLE' : 'UNKNOWN';
    },
    state: (s) => {
      const pull = s.pull as Pull;
      return pull.merged ? 'MERGED' : pull.state.toUpperCase();
    },
    merged: (s) => (s.pull as Pull).merged,
    files: (s, args, ctx) => {
      const files = ctx.store.pullFiles(s.repo as Repo, s.pull as Pull);
      const first = typeof args.first === 'number' ? args.first : 10;
      const page = files.slice(0, Math.max(0, first));
      return {
        __type: 'PullRequestFileConnection',
        nodes: page.map((f) => ({ __type: 'PullRequestFile', path: f.filename })),
        pageInfo: { __type: 'PageInfo', hasNextPage: files.length > page.length, endCursor: null },
      };
    },
  },
  Ref: {
    name: (s) => s.name as string,
  },
  IssueConnection: {
    nodes: (s) => s.nodes as unknown[],
    pageInfo: (s) => s.pageInfo as AnyObj,
  },
  PullRequestConnection: {
    nodes: (s) => s.nodes as unknown[],
    pageInfo: (s) => s.pageInfo as AnyObj,
  },
  PullRequestFileConnection: {
    nodes: (s) => s.nodes as unknown[],
    pageInfo: (s) => s.pageInfo as AnyObj,
  },
  PullRequestFile: {
    path: (s) => s.path as string,
  },
  PageInfo: {
    hasNextPage: (s) => s.hasNextPage as boolean,
    endCursor: (s) => (s.endCursor ?? null) as string | null,
  },
  CreateIssuePayload: { issue: (s) => s.issue as AnyObj },
  CloseIssuePayload: { issue: (s) => s.issue as AnyObj },
  CreatePullRequestPayload: { pullRequest: (s) => s.pullRequest as AnyObj },
  MergePullRequestPayload: { pullRequest: (s) => s.pullRequest as AnyObj },
  AddCommentPayload: { commentEdge: (s) => s.commentEdge as AnyObj },
  IssueCommentEdge: { node: (s) => s.node as AnyObj },
  Comment: {
    id: (s) => s.id as string,
    body: (s) => s.body as string,
  },
  __Type: {
    name: (s) => s.name as string,
    kind: (s) => s.kind as string,
    fields: (s) => (s.fields ?? null) as unknown,
    enumValues: (s) => (s.enumValues ?? null) as unknown,
  },
  __Field: { name: (s) => s.name as string },
  __EnumValue: { name: (s) => s.name as string },
  __Schema: {
    types: () => Object.entries(TYPES).map(([name, def]) => typeInfo(name, def)),
  },
};

function typeInfo(name: string, def: TypeDef): AnyObj {
  return {
    __type: '__Type',
    name,
    kind: def.kind,
    fields: def.kind === 'OBJECT' ? (def.fields ?? []).map((f) => ({ __type: '__Field', name: f })) : null,
    enumValues: def.kind === 'ENUM' ? (def.values ?? []).map((v) => ({ __type: '__EnumValue', name: v })) : null,
  };
}

// ---------------------------------------------------------------- execution

function executeSelection(
  parentType: string,
  source: AnyObj,
  selection: FieldNode[],
  vars: Record<string, unknown>,
  ctx: GqlCtx,
  errors: Array<{ message: string }>,
  fragments: Record<string, FieldNode[]>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of selection) {
    if (field.isFragment) {
      if (field.fragmentType) {
        if (source.__type !== field.fragmentType) continue;
        Object.assign(out, executeSelection(parentType, source, field.selection, vars, ctx, errors, fragments));
      } else if (field.name) {
        const frag = fragments[field.name];
        if (frag) Object.assign(out, executeSelection(parentType, source, frag, vars, ctx, errors, fragments));
      }
      continue;
    }
    const key = field.alias ?? field.name;
    if (field.name === '__typename') {
      out[key] = parentType;
      continue;
    }
    if (field.name === '__type') {
      const args = resolveArgs(field.args, vars);
      const def = TYPES[String(args.name ?? '')];
      out[key] = def ? resolveFieldValue(typeInfo(String(args.name), def), field, vars, ctx, errors, fragments) : null;
      continue;
    }
    if (field.name === '__schema') {
      out[key] = resolveFieldValue({ __type: '__Schema' }, field, vars, ctx, errors, fragments);
      continue;
    }
    const typeDef = TYPES[parentType];
    if (!typeDef || typeDef.kind !== 'OBJECT' || !typeDef.fields?.includes(field.name)) {
      errors.push({ message: `Cannot query field "${field.name}" on type "${parentType}".` });
      out[key] = null;
      continue;
    }
    const resolver = RESOLVERS[parentType]?.[field.name];
    if (!resolver) {
      errors.push({ message: `Cannot query field "${field.name}" on type "${parentType}".` });
      out[key] = null;
      continue;
    }
    const args = resolveArgs(field.args, vars);
    let value: unknown;
    try {
      value = resolver(source, args, ctx);
    } catch (err) {
      errors.push({ message: err instanceof Error ? err.message : String(err) });
      out[key] = null;
      continue;
    }
    out[key] = resolveFieldValue(value, field, vars, ctx, errors, fragments);
  }
  return out;
}

function resolveFieldValue(
  value: unknown,
  field: FieldNode,
  vars: Record<string, unknown>,
  ctx: GqlCtx,
  errors: Array<{ message: string }>,
  fragments: Record<string, FieldNode[]>,
): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    return value.map((v) => resolveFieldValue(v, field, vars, ctx, errors, fragments));
  }
  if (typeof value === 'object') {
    const obj = value as AnyObj;
    const type = typeof obj.__type === 'string' ? obj.__type : null;
    if (!type) return value;
    if (field.selection.length === 0) return value;
    return executeSelection(type, obj, field.selection, vars, ctx, errors, fragments);
  }
  return value;
}

function executeOperation(
  op: Operation,
  variables: Record<string, unknown>,
  ctx: GqlCtx,
  fragments: Record<string, FieldNode[]>,
): { data: Record<string, unknown>; errors?: Array<{ message: string }> } {
  const vars: Record<string, unknown> = {};
  for (const [name, def] of Object.entries(op.variables)) {
    if (variables[name] !== undefined) vars[name] = variables[name];
    else if (def.defaultValue !== undefined) vars[name] = resolveValueNode(def.defaultValue, variables);
    else vars[name] = null;
  }
  for (const [k, v] of Object.entries(variables)) {
    if (!(k in vars)) vars[k] = v;
  }
  const rootType = op.kind === 'mutation' ? 'Mutation' : 'Query';
  const errors: Array<{ message: string }> = [];
  const data = executeSelection(rootType, { __type: rootType }, op.selection, vars, ctx, errors, fragments);
  return errors.length > 0 ? { data, errors } : { data };
}

/** Execute one GraphQL request body. Returns the envelope (or array for a batch). */
export function handleGraphQL(store: Store, body: unknown): unknown {
  const ctx: GqlCtx = { store };
  if (Array.isArray(body)) {
    return body.map((item) => executeOne(item, ctx));
  }
  return executeOne(body, ctx);
}

function executeOne(body: unknown, ctx: GqlCtx): unknown {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { data: null, errors: [{ message: 'Request body must be a JSON object' }] };
  }
  const b = body as Record<string, unknown>;
  const query = b.query;
  if (typeof query !== 'string') {
    return { data: null, errors: [{ message: 'Request must include a query string' }] };
  }
  const variables = (b.variables ?? {}) as Record<string, unknown>;
  const operationName = typeof b.operationName === 'string' ? b.operationName : null;
  let doc: Document;
  try {
    doc = new Parser(lex(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  if (doc.operations.length === 0) {
    return { data: null, errors: [{ message: 'Document contains no operations' }] };
  }
  let op = doc.operations[0];
  if (operationName) {
    const named = doc.operations.find((o) => o.name === operationName);
    if (named) op = named;
  }
  return executeOperation(op!, variables, ctx, doc.fragments);
}
