// REST v3: repositories, branches, commits, contents, labels, issues,
// comments, pull requests. Shapes follow specs/rest.md; extra fields are
// tolerated by the suite, missing required ones are not.
import { ApiError, Store, notFound, unprocessable, type Issue, type Pull, type Repo } from './store.ts';
import { VIEWER_LOGIN } from './util.ts';

export interface RestResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export interface RestContext {
  store: Store;
  host: string;
  query: URLSearchParams;
  body: unknown;
}

function repoShape(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: 1000 },
    private: repo.isPrivate,
    default_branch: repo.defaultBranch,
    description: repo.description,
  };
}

function issueShape(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.number,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name, color: repo.labels.get(name)?.color ?? 'ededed' })),
  };
}

function pullShape(repo: Repo, pull: Pull): Record<string, unknown> {
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  return {
    id: pull.number,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: headSha },
    base: { ref: pull.baseRef, sha: baseSha },
  };
}

function asObject(body: unknown): Record<string, unknown> {
  if (body !== null && typeof body === 'object' && !Array.isArray(body)) return body as Record<string, unknown>;
  throw new ApiError(400, 'Request body must be a JSON object');
}

function asString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw unprocessable(`Field ${field} must be a string`);
  return value;
}

function paginate<T>(items: T[], ctx: RestContext, basePath: string): { page: T[]; link: string | null } {
  const perPageRaw = parseInt(ctx.query.get('per_page') ?? '30', 10);
  const perPage = Number.isFinite(perPageRaw) ? Math.max(1, Math.min(100, perPageRaw)) : 30;
  const pageRaw = parseInt(ctx.query.get('page') ?? '1', 10);
  const page = Number.isFinite(pageRaw) ? Math.max(1, pageRaw) : 1;
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  let link: string | null = null;
  if (start + perPage < items.length) {
    const params = new URLSearchParams(ctx.query);
    params.set('per_page', String(perPage));
    params.set('page', String(page + 1));
    link = `<http://${ctx.host}${basePath}?${params.toString()}>; rel="next"`;
  }
  return { page: slice, link };
}

function withLink(res: RestResponse, link: string | null): RestResponse {
  if (link) return { ...res, headers: { ...(res.headers ?? {}), link } };
  return res;
}

function requireRepo(ctx: RestContext, owner: string, name: string): Repo {
  const repo = ctx.store.getRepo(owner, name);
  if (!repo) throw notFound('Repository not found');
  return repo;
}

export function handleRest(method: string, path: string, ctx: RestContext): RestResponse | null {
  const seg = path.split('/').filter((s) => s.length > 0).map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
  if (seg[0] !== 'api' || seg[1] !== 'v3') return null;
  const rest = seg.slice(2);

  // GET /api/v3/meta
  if (rest.length === 1 && rest[0] === 'meta' && method === 'GET') {
    return { status: 200, body: { installed_version: '1.0.0' } };
  }

  // /api/v3/user/repos
  if (rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
    if (method === 'POST') {
      const b = asObject(ctx.body);
      const name = asString(b.name, 'name');
      if (name.length === 0) throw unprocessable('Repository name must not be empty');
      const repo = ctx.store.createRepo(
        name,
        typeof b.description === 'string' ? b.description : '',
        b.private === true,
      );
      return { status: 201, body: repoShape(repo) };
    }
    if (method === 'GET') {
      const all = ctx.store.listRepos().map((r) => repoShape(r));
      const { page, link } = paginate(all, ctx, '/api/v3/user/repos');
      return withLink({ status: 200, body: page }, link);
    }
    return null;
  }

  // /api/v3/repos/{owner}/{repo}[...]
  if (rest.length >= 3 && rest[0] === 'repos') {
    const owner = rest[1];
    const name = rest[2];
    const tail = rest.slice(3);
    const repo = requireRepo(ctx, owner, name);

    if (tail.length === 0) {
      if (method === 'GET') return { status: 200, body: repoShape(repo) };
      if (method === 'PATCH') {
        const b = asObject(ctx.body);
        if (typeof b.description === 'string') repo.description = b.description;
        return { status: 200, body: repoShape(repo) };
      }
      if (method === 'DELETE') {
        ctx.store.deleteRepo(owner, name);
        return { status: 204, body: null };
      }
      return null;
    }

    // git/refs
    if (tail.length === 2 && tail[0] === 'git' && tail[1] === 'refs' && method === 'POST') {
      const b = asObject(ctx.body);
      const ref = asString(b.ref, 'ref');
      const sha = asString(b.sha, 'sha');
      const created = ctx.store.createRef(repo, ref, sha);
      return { status: 201, body: { ref: created.ref, object: { sha: created.sha } } };
    }

    // branches
    if (tail.length === 1 && tail[0] === 'branches' && method === 'GET') {
      return {
        status: 200,
        body: ctx.store.listBranches(repo).map((b) => ({ name: b.name, commit: { sha: b.sha } })),
      };
    }

    // commits
    if (tail.length === 1 && tail[0] === 'commits' && method === 'GET') {
      const sha = ctx.query.get('sha') ?? undefined;
      return {
        status: 200,
        body: ctx.store.listCommits(repo, sha).map((c) => ({ sha: c.sha, commit: { message: c.message } })),
      };
    }

    // contents/{path...}
    if (tail[0] === 'contents') {
      const filePath = tail.slice(1).join('/');
      if (method === 'PUT') {
        const b = asObject(ctx.body);
        const message = asString(b.message, 'message');
        const contentB64 = asString(b.content, 'content');
        let content: Buffer;
        try {
          content = Buffer.from(contentB64, 'base64');
        } catch {
          throw new ApiError(400, 'content is not valid base64');
        }
        const branch = typeof b.branch === 'string' ? b.branch : undefined;
        if (typeof b.sha === 'string') {
          const current = ctx.store.blobShaAt(repo, filePath, branch);
          if (current !== b.sha) throw new ApiError(409, 'stale sha');
        }
        const result = ctx.store.putContents(repo, filePath, content, message, branch);
        return {
          status: result.created ? 201 : 200,
          body: {
            content: { name: filePath.split('/').pop() ?? filePath, path: filePath, sha: result.blobSha, size: content.length, encoding: 'base64' },
            commit: { sha: result.commitSha, message },
          },
        };
      }
      if (method === 'GET') {
        const ref = ctx.query.get('ref') ?? undefined;
        const found = ctx.store.getContents(repo, filePath, ref);
        if (!found) throw notFound('Not Found');
        if (found.kind === 'file') {
          return {
            status: 200,
            body: {
              type: 'file',
              encoding: 'base64',
              content: found.content.toString('base64'),
              sha: found.sha,
              size: found.size,
            },
          };
        }
        return { status: 200, body: found.entries };
      }
      if (method === 'DELETE') {
        const b = asObject(ctx.body);
        const message = asString(b.message, 'message');
        const branch = typeof b.branch === 'string' ? b.branch : undefined;
        if (typeof b.sha === 'string') {
          const current = ctx.store.blobShaAt(repo, filePath, branch);
          if (current !== b.sha) throw new ApiError(409, 'stale sha');
        }
        const result = ctx.store.deleteContents(repo, filePath, message, branch);
        if (!result) throw notFound('Not Found');
        return { status: 200, body: { commit: { sha: result.commitSha } } };
      }
      return null;
    }

    // labels
    if (tail.length === 1 && tail[0] === 'labels' && method === 'POST') {
      const b = asObject(ctx.body);
      const label = ctx.store.createLabel(repo, asString(b.name, 'name'), typeof b.color === 'string' ? b.color : 'ededed');
      return { status: 201, body: { name: label.name, color: label.color } };
    }

    // issues
    if (tail[0] === 'issues') {
      if (tail.length === 1) {
        if (method === 'POST') {
          const b = asObject(ctx.body);
          const title = asString(b.title, 'title');
          const bodyText = typeof b.body === 'string' ? b.body : '';
          const labels = Array.isArray(b.labels) ? b.labels.filter((x): x is string => typeof x === 'string') : [];
          const issue = ctx.store.createIssue(repo, title, bodyText, labels);
          return { status: 201, body: issueShape(repo, issue) };
        }
        if (method === 'GET') {
          const state = ctx.query.get('state') ?? undefined;
          const sort = ctx.query.get('sort') ?? undefined;
          const direction = ctx.query.get('direction') ?? undefined;
          const all = ctx.store.listIssues(repo, state, sort, direction).map((i) => issueShape(repo, i));
          const { page, link } = paginate(all, ctx, `/api/v3/repos/${owner}/${name}/issues`);
          return withLink({ status: 200, body: page }, link);
        }
        return null;
      }
      const num = parseInt(tail[1], 10);
      if (!Number.isFinite(num)) throw notFound('Not Found');
      if (tail.length === 2) {
        if (method === 'GET') {
          const issue = ctx.store.getIssue(repo, num);
          if (!issue) throw notFound('Issue not found');
          return { status: 200, body: issueShape(repo, issue) };
        }
        if (method === 'PATCH') {
          const b = asObject(ctx.body);
          const state = b.state === 'closed' ? 'closed' : b.state === 'open' ? 'open' : null;
          if (state === null) throw unprocessable('state must be open or closed');
          const issue = ctx.store.patchIssue(repo, num, state);
          return { status: 200, body: issueShape(repo, issue) };
        }
        return null;
      }
      if (tail.length === 3 && tail[2] === 'comments') {
        if (method === 'POST') {
          const b = asObject(ctx.body);
          const comment = ctx.store.addComment(repo, num, asString(b.body, 'body'));
          return { status: 201, body: { id: comment.id, body: comment.body } };
        }
        if (method === 'GET') {
          const issue = ctx.store.getIssue(repo, num);
          if (!issue) throw notFound('Issue not found');
          return { status: 200, body: issue.comments.map((c) => ({ id: c.id, body: c.body })) };
        }
        return null;
      }
      return null;
    }

    // pulls
    if (tail[0] === 'pulls') {
      if (tail.length === 1) {
        if (method === 'POST') {
          const b = asObject(ctx.body);
          const pull = ctx.store.createPull(
            repo,
            asString(b.head, 'head'),
            asString(b.base, 'base'),
            asString(b.title, 'title'),
            typeof b.body === 'string' ? b.body : '',
          );
          return { status: 201, body: pullShape(repo, pull) };
        }
        if (method === 'GET') {
          const state = ctx.query.get('state') ?? undefined;
          const all = ctx.store.listPulls(repo, state).map((p) => pullShape(repo, p));
          const { page, link } = paginate(all, ctx, `/api/v3/repos/${owner}/${name}/pulls`);
          return withLink({ status: 200, body: page }, link);
        }
        return null;
      }
      const num = parseInt(tail[1], 10);
      if (!Number.isFinite(num)) throw notFound('Not Found');
      if (tail.length === 2 && method === 'GET') {
        const pull = ctx.store.getPull(repo, num);
        if (!pull) throw notFound('Pull request not found');
        return { status: 200, body: pullShape(repo, pull) };
      }
      if (tail.length === 3 && tail[2] === 'files' && method === 'GET') {
        const pull = ctx.store.getPull(repo, num);
        if (!pull) throw notFound('Pull request not found');
        return { status: 200, body: ctx.store.pullFiles(repo, pull) };
      }
      if (tail.length === 3 && tail[2] === 'merge' && method === 'PUT') {
        const pull = ctx.store.getPull(repo, num);
        if (!pull) throw notFound('Pull request not found');
        const result = ctx.store.mergePull(repo, pull);
        return { status: 200, body: { merged: result.merged, sha: result.sha, message: result.message } };
      }
      return null;
    }
  }

  return null;
}

export { VIEWER_LOGIN };
