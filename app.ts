// The forge's HTTP server: routing, auth, and the JSON wire.
// main.ts owns the lifecycle (bind, register, wait, exit); this file owns
// the surface: /healthz, REST v3, GraphQL v4, MCP, and git smart HTTP.
// Every reply carries a non-empty X-GitHub-Request-Id, and every error
// body is JSON {"message": string}.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { ApiError, Store } from './lib/store.ts';
import { handleRest } from './lib/rest.ts';
import { handleGraphQL } from './lib/graphql.ts';
import { handleMcp } from './lib/mcp.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './lib/gitproto.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function createApp(store = new Store()): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void handleRequest(store, req, res).catch((err: unknown) => {
      process.stderr.write(`[forge] unhandled: ${err instanceof Error ? err.message : String(err)}\n`);
      if (!res.headersSent) sendJson(store, res, 500, { message: 'Internal Server Error' });
      else res.end();
    });
  });
}

function sendJson(store: Store, res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}, rawText?: string): void {
  const requestId = store.nextRequestId();
  if (rawText !== undefined) {
    // Pre-serialised body from the GET-issue cache: the exact bytes this
    // function would have produced. The request id stays fresh per reply.
    res.writeHead(status, {
      'content-type': JSON_TYPE,
      'content-length': Buffer.byteLength(rawText),
      'x-github-request-id': requestId,
      ...extraHeaders,
    });
    res.end(rawText);
    return;
  }
  if (status === 204 || body === null || body === undefined) {
    res.writeHead(status, { 'x-github-request-id': requestId, ...extraHeaders });
    res.end();
    return;
  }
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId,
    ...extraHeaders,
  });
  res.end(text);
}

function sendBuffer(store: Store, res: ServerResponse, status: number, body: Buffer, contentType: string, extraHeaders: Record<string, string> = {}): void {
  const requestId = store.nextRequestId();
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': requestId,
    ...extraHeaders,
  });
  res.end(body);
}

function pathOf(req: IncomingMessage): { path: string; query: URLSearchParams } {
  // Fast path: split on '?' by hand. `new URL()` parses (and validates)
  // scheme/host/port on every request; this route sees thousands of
  // sequential requests per benchmark round, so the parse cost is real.
  // Behavior is identical for origin-form URLs (what the env sends):
  // pathname stays percent-encoded, exactly as URL.pathname returns it.
  const raw = req.url ?? '/';
  if (raw.startsWith('http://') || raw.startsWith('https://')) {
    try {
      const url = new URL(raw);
      return { path: url.pathname, query: url.searchParams };
    } catch {
      return { path: '/', query: new URLSearchParams() };
    }
  }
  const q = raw.indexOf('?');
  if (q === -1) return { path: raw, query: new URLSearchParams() };
  return { path: raw.slice(0, q), query: new URLSearchParams(raw.slice(q + 1)) };
}

function checkAuth(req: IncomingMessage): ApiError | null {
  if (SHOP_TOKEN === '') return null;
  const auth = req.headers.authorization;
  if (auth === undefined) return new ApiError(401, 'Requires authentication');
  if (auth !== `Bearer ${SHOP_TOKEN}`) return new ApiError(401, 'Bad credentials');
  return null;
}

async function handleRequest(store: Store, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { path, query } = pathOf(req);
  const method = req.method ?? 'GET';

  // The env's boot check calls this twice: 200 {"ok":true}. No auth here.
  if (method === 'GET' && path === '/healthz') {
    sendJson(store, res, 200, { ok: true });
    return;
  }

  const authErr = checkAuth(req);
  if (authErr) {
    sendJson(store, res, authErr.status, { message: authErr.message });
    return;
  }

  try {
    // The GitHub API root.
    if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
      sendJson(store, res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
      return;
    }

    // Git smart HTTP: /{owner}/{repo}.git/{info/refs|git-upload-pack|git-receive-pack}
    const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
    if (gitMatch) {
      const owner = decodeURIComponent(gitMatch[1]);
      const repoName = decodeURIComponent(gitMatch[2]);
      const action = gitMatch[3];
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(owner) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(repoName)) {
        sendJson(store, res, 404, { message: 'Not Found' });
        return;
      }
      if (action === 'info/refs' && method === 'GET') {
        const service = query.get('service') ?? '';
        const result = handleInfoRefs(store, owner, repoName, service, req.headers['git-protocol']);
        sendBuffer(store, res, result.status, result.body, result.contentType);
        return;
      }
      if (action === 'git-upload-pack' && method === 'POST') {
        const body = await readBody(req);
        const result = handleUploadPack(store, owner, repoName, body, req.headers['git-protocol']);
        sendBuffer(store, res, result.status, result.body, result.contentType);
        return;
      }
      if (action === 'git-receive-pack' && method === 'POST') {
        const body = await readBody(req);
        const result = handleReceivePack(store, owner, repoName, body);
        sendBuffer(store, res, result.status, result.body, result.contentType);
        return;
      }
      sendJson(store, res, 404, { message: 'Not Found' });
      return;
    }

    // GraphQL v4.
    if (method === 'POST' && path === '/api/graphql') {
      const raw = await readBody(req);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString('utf8'));
      } catch {
        sendJson(store, res, 400, { message: 'Problems parsing JSON' });
        return;
      }
      const envelope = handleGraphQL(store, parsed);
      sendJson(store, res, 200, envelope);
      return;
    }

    // MCP: the handler parses its own body so a malformed one answers -32700.
    if (method === 'POST' && path === '/mcp') {
      const raw = await readBody(req);
      const result = handleMcp(store, raw, req.headers as Record<string, string | string[] | undefined>);
      if (result.body === null) {
        sendJson(store, res, result.status, null, result.headers ?? {});
        return;
      }
      sendJson(store, res, result.status, result.body, result.headers ?? {});
      return;
    }

    // REST v3.
    if (path === '/api/v3' || path.startsWith('/api/v3/')) {
      let parsed: unknown;
      if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
        const raw = await readBody(req);
        if (raw.length > 0) {
          try {
            parsed = JSON.parse(raw.toString('utf8'));
          } catch {
            sendJson(store, res, 400, { message: 'Problems parsing JSON' });
            return;
          }
        }
      }
      const host = req.headers.host ?? `${req.socket.localAddress ?? '127.0.0.1'}:${req.socket.localPort ?? 0}`;
      const result = handleRest(method, path, { store, host, query, body: parsed });
      if (result === null) {
        sendJson(store, res, 404, { message: 'Not Found' });
        return;
      }
      sendJson(store, res, result.status, result.body, result.headers ?? {}, result.text);
      return;
    }

    sendJson(store, res, 404, { message: 'Not Found' });
  } catch (err) {
    if (err instanceof ApiError) {
      sendJson(store, res, err.status, { message: err.message });
      return;
    }
    process.stderr.write(`[forge] handler error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    sendJson(store, res, 500, { message: 'Internal Server Error' });
  }
}
