// MCP: JSON-RPC 2.0 over Streamable HTTP at POST /mcp.
// Speaks revision 2026-07-28 (server/discover) and the legacy handshake
// revisions (initialize + notifications/initialized). The six tools act on
// the same store as REST, so objects created here read back over /api/v3.
import { ApiError, Store, notFound } from './store.ts';
import { VIEWER_LOGIN } from './util.ts';

export interface McpResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

const SERVER_NAME = 'makefun-forge';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SESSION_ID = 'session-1';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description?: string }>;
    required?: string[];
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository for the viewer.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
        body: { type: 'string', description: 'The pull request body.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

/** Normalize a property name the way the suite does: lowercase, strip non-alphanumerics. */
function norm(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

const SYNONYMS: Record<string, string[]> = {
  owner: ['owner', 'owner_login', 'org', 'organization', 'user', 'user_login', 'login', 'account', 'namespace', 'owner_name'],
  repo: ['repo', 'repository', 'repository_name', 'repo_name', 'repo_slug', 'project', 'project_name'],
  title: ['title', 'issue_title', 'pr_title', 'pull_request_title', 'subject'],
  body: ['body', 'issue_body', 'description', 'content', 'text', 'comment'],
  head: ['head', 'head_ref', 'head_branch', 'pull_request_head', 'pr_head', 'source', 'source_ref', 'source_branch', 'from', 'from_branch', 'branch'],
  base: ['base', 'base_ref', 'base_branch', 'pull_request_base', 'pr_base', 'target', 'target_ref', 'target_branch', 'into', 'into_branch'],
  pull_number: ['pull_number', 'pull_request_number', 'pr_number', 'number', 'issue_number', 'index'],
  name: ['name', 'repo', 'repository', 'repository_name', 'repo_name'],
  description: ['description', 'about', 'summary', 'body'],
  private: ['private', 'is_private'],
  state: ['state', 'status'],
};

/** Pick a logical argument from the call's arguments, trying synonyms. */
function pickArg(args: Record<string, unknown>, logical: string): unknown {
  const names = SYNONYMS[logical] ?? [logical];
  for (const n of names) {
    if (args[n] !== undefined) return args[n];
  }
  // Fall back to a normalized-name scan.
  for (const [key, value] of Object.entries(args)) {
    if (names.some((n) => norm(n) === norm(key))) return value;
  }
  return undefined;
}

/** Split owner/repo from the call's arguments, honouring full_name. */
function pickOwnerRepo(args: Record<string, unknown>): { owner: string; repo: string } {
  let owner = pickArg(args, 'owner');
  let repo = pickArg(args, 'repo');
  if ((owner === undefined || repo === undefined) && typeof args.full_name === 'string') {
    const [o, r] = (args.full_name as string).split('/');
    if (owner === undefined) owner = o;
    if (repo === undefined) repo = r;
  }
  return { owner: owner === undefined ? '' : String(owner), repo: repo === undefined ? '' : String(repo) };
}

function toolResult(summary: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(summary) }],
    structuredContent: summary,
  };
}

function toolError(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const key = norm(name);
  const tool = TOOLS.find((t) => norm(t.name) === key || key.endsWith(norm(t.name)));
  if (!tool) throw new ApiError(-32601, `Method not found: ${name}`);
  switch (tool.name) {
    case 'create_repo': {
      const repoName = pickArg(args, 'name');
      if (typeof repoName !== 'string' || repoName.length === 0) return toolError('Missing required argument: name');
      const description = pickArg(args, 'description');
      const isPrivate = pickArg(args, 'private');
      try {
        const repo = store.createRepo(repoName, typeof description === 'string' ? description : '', isPrivate === true);
        return toolResult({ id: repo.id, name: repo.name, full_name: `${repo.owner}/${repo.name}`, owner: repo.owner, private: repo.isPrivate, description: repo.description, default_branch: repo.defaultBranch });
      } catch (err) {
        return toolError(err instanceof Error ? err.message : String(err));
      }
    }
    case 'get_repo': {
      const { owner, repo } = pickOwnerRepo(args);
      if (!owner || !repo) return toolError('Missing required argument: owner or repo');
      const found = store.getRepo(owner, repo);
      if (!found) return toolError(`Repository not found: ${owner}/${repo}`);
      return toolResult({ id: found.id, name: found.name, full_name: `${found.owner}/${found.name}`, owner: found.owner, private: found.isPrivate, description: found.description, default_branch: found.defaultBranch });
    }
    case 'create_issue': {
      const { owner, repo } = pickOwnerRepo(args);
      const title = pickArg(args, 'title');
      if (!owner || !repo) return toolError('Missing required argument: owner or repo');
      if (typeof title !== 'string' || title.length === 0) return toolError('Missing required argument: title');
      const found = store.getRepo(owner, repo);
      if (!found) return toolError(`Repository not found: ${owner}/${repo}`);
      const body = pickArg(args, 'body');
      const issue = store.createIssue(found, title, typeof body === 'string' ? body : '', []);
      return toolResult({ id: issue.number, number: issue.number, title: issue.title, body: issue.body, state: issue.state });
    }
    case 'list_issues': {
      const { owner, repo } = pickOwnerRepo(args);
      if (!owner || !repo) return toolError('Missing required argument: owner or repo');
      const found = store.getRepo(owner, repo);
      if (!found) return toolError(`Repository not found: ${owner}/${repo}`);
      const state = pickArg(args, 'state');
      const issues = store.listIssues(found, typeof state === 'string' ? state : undefined, undefined, undefined);
      return toolResult({ issues: issues.map((i) => ({ id: i.number, number: i.number, title: i.title, body: i.body, state: i.state })) });
    }
    case 'create_pull_request': {
      const { owner, repo } = pickOwnerRepo(args);
      const title = pickArg(args, 'title');
      const head = pickArg(args, 'head');
      const base = pickArg(args, 'base');
      if (!owner || !repo) return toolError('Missing required argument: owner or repo');
      if (typeof title !== 'string' || title.length === 0) return toolError('Missing required argument: title');
      if (typeof head !== 'string' || head.length === 0) return toolError('Missing required argument: head');
      if (typeof base !== 'string' || base.length === 0) return toolError('Missing required argument: base');
      const found = store.getRepo(owner, repo);
      if (!found) return toolError(`Repository not found: ${owner}/${repo}`);
      const body = pickArg(args, 'body');
      try {
        const pull = store.createPull(found, head, base, title, typeof body === 'string' ? body : '');
        return toolResult({ id: pull.number, number: pull.number, title: pull.title, body: pull.body, state: pull.state, head: pull.headRef, base: pull.baseRef });
      } catch (err) {
        return toolError(err instanceof Error ? err.message : String(err));
      }
    }
    case 'merge_pull_request': {
      const { owner, repo } = pickOwnerRepo(args);
      const num = pickArg(args, 'pull_number');
      if (!owner || !repo) return toolError('Missing required argument: owner or repo');
      if (num === undefined) return toolError('Missing required argument: pull_number');
      const found = store.getRepo(owner, repo);
      if (!found) return toolError(`Repository not found: ${owner}/${repo}`);
      const pull = store.getPull(found, Number(num));
      if (!pull) return toolError(`Pull request not found: ${num}`);
      try {
        const result = store.mergePull(found, pull);
        return toolResult({ number: pull.number, merged: result.merged, sha: result.sha, state: pull.state });
      } catch (err) {
        return toolError(err instanceof Error ? err.message : String(err));
      }
    }
    default:
      throw new ApiError(-32601, `Method not found: ${name}`);
  }
}

interface RpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

function rpcError(id: string | number | null, code: number, message: string, data?: unknown): Record<string, unknown> {
  const err: Record<string, unknown> = { code, message };
  if (data !== undefined) err.data = data;
  return { jsonrpc: '2.0', id, error: err };
}

function rpcResult(id: string | number | null, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

/** Handle one POST /mcp body. `headers` are the request's headers (lowercase keys). */
export function handleMcp(store: Store, rawBody: Buffer, headers: Record<string, string | string[] | undefined>): McpResponse {
  let req: RpcRequest;
  try {
    req = JSON.parse(rawBody.toString('utf8')) as RpcRequest;
  } catch {
    return { status: 400, body: rpcError(null, -32700, 'Parse error') };
  }
  if (req === null || typeof req !== 'object' || Array.isArray(req)) {
    return { status: 400, body: rpcError(null, -32600, 'Invalid Request') };
  }
  const id = req.id === undefined ? null : req.id;
  const isNotification = req.id === undefined;
  const method = typeof req.method === 'string' ? req.method : '';
  const params = (req.params ?? {}) as Record<string, unknown>;
  const meta = (params._meta ?? {}) as Record<string, unknown>;
  const metaVersion = typeof meta['io.modelcontextprotocol/protocolVersion'] === 'string' ? (meta['io.modelcontextprotocol/protocolVersion'] as string) : null;
  const headerVersion = typeof headers['mcp-protocol-version'] === 'string' ? (headers['mcp-protocol-version'] as string) : null;

  // Version negotiation: a header/meta mismatch is -32020; an unknown
  // version is -32022 with the supported list.
  if (method !== 'notifications/initialized' && metaVersion && headerVersion && metaVersion !== headerVersion) {
    return { status: 200, body: rpcError(id, -32020, 'MCP-Protocol-Version header does not match the requested protocol version') };
  }
  const requestedVersion = metaVersion ?? headerVersion ?? (typeof params.protocolVersion === 'string' ? (params.protocolVersion as string) : null);
  if (requestedVersion && !SUPPORTED_VERSIONS.includes(requestedVersion)) {
    return { status: 200, body: rpcError(id, -32022, `Unsupported protocol version: ${requestedVersion}`, { supported: SUPPORTED_VERSIONS }) };
  }

  if (method === 'notifications/initialized') {
    return { status: 202, body: null };
  }

  if (method === 'initialize') {
    const version = requestedVersion ?? '2026-07-28';
    return {
      status: 200,
      body: rpcResult(id, {
        protocolVersion: version,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      }),
      headers: { 'mcp-session-id': SESSION_ID },
    };
  }

  if (method === 'server/discover') {
    // A pre-2026-07-28 client is in the handshake era: discover is not a
    // method there, and the client treats -32601 as a pass.
    if (requestedVersion && requestedVersion !== '2026-07-28') {
      return { status: 200, body: rpcError(id, -32601, 'Method not found: server/discover') };
    }
    return {
      status: 200,
      body: rpcResult(id, {
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions: 'A GitHub-compatible git forge: create repos, issues and pull requests over the same store as REST.',
      }),
    };
  }

  if (method === 'tools/list') {
    return { status: 200, body: rpcResult(id, { tools: TOOLS }) };
  }

  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    if (!name) {
      return { status: 200, body: rpcError(id, -32602, 'Missing tool name') };
    }
    const key = norm(name);
    const known = TOOLS.some((t) => norm(t.name) === key || key.endsWith(norm(t.name)));
    if (!known) {
      return { status: 200, body: rpcError(id, -32601, `Method not found: ${name}`) };
    }
    // A tools/call with no arguments at all, on a tool that requires them,
    // answers isError rather than throwing.
    try {
      const result = callTool(store, name, args);
      return { status: 200, body: rpcResult(id, result) };
    } catch (err) {
      if (err instanceof ApiError && err.status === -32601) {
        return { status: 200, body: rpcError(id, -32601, err.message) };
      }
      return { status: 200, body: rpcResult(id, toolError(err instanceof Error ? err.message : String(err))) };
    }
  }

  if (method === 'ping') {
    return { status: 200, body: rpcResult(id, {}) };
  }

  if (isNotification) {
    return { status: 202, body: null };
  }
  return { status: 200, body: rpcError(id, -32601, `Method not found: ${method}`) };
}

export { VIEWER_LOGIN };
