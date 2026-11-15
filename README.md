# makefun-forge — a GitHub-compatible git forge in one Node process

A standalone GitHub-compatible forge for
[the contest](https://make.fun/bounty/github-core-clone-01): one process,
Node 22 standard library only, no `git` binary, no outside service, no UI.
It serves git smart HTTP, REST v3, GraphQL v4 and MCP from a single
in-memory store, so a repo, issue or pull created on any surface is the same
object on all of them.

## Run it

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later, which strips
TypeScript types on its own. There is nothing to install: the program imports
`node:http`, `node:zlib`, `node:crypto` and its own files only, and the trial
has no package manager and no internet.

## The lifecycle (main.ts)

The env is a server the harness starts beside yours. Its origin is in
`MAKEFUN_ENV_URL` (`http://store:8080` in a trial).

1. **Bind an ephemeral port.** `server.listen(0)` lets the kernel pick one.
   Never bind 8080: that is the env's port.
2. **Register.** `POST $MAKEFUN_ENV_URL/register` with
   `{"port": <the port you bound>}`, as JSON. The first register wins.
3. **Wait for done.** `GET $MAKEFUN_ENV_URL/done` answers at once with
   `{"done":false}` while the suite runs and `{"done":true}` once its export
   is written. Poll it with a short backoff; never exit before it says `true`.
4. **Exit 0** when it does.

If `MAKEFUN_ENV_URL` is unset there is nothing to talk to, so `main.ts`
exits 1 at once.

## The surface

| Route | What it is |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true}`: the env's boot probe, called twice |
| `GET /api/v3/` | 200, `X-Oauth-Scopes: repo, read:org`, a JSON API root |
| `/api/v3/...` | GitHub REST v3: repositories, branches, commits, contents, issues, comments, labels, pull requests, files, merges |
| `POST /api/graphql` | GitHub GraphQL v4: viewer, repository, issues, pull requests, mutations, introspection |
| `POST /mcp` | Model Context Protocol over streamable HTTP: initialize, server/discover, tools/list, tools/call |
| `/<owner>/<repo>.git/...` | git smart HTTP: `info/refs`, `git-upload-pack` (v2 and v0), `git-receive-pack` (v0) |

Every reply is `application/json` (never HTML) with a non-empty
`X-GitHub-Request-Id`; errors carry a JSON body with a string `message`.
Auth is `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`; the viewer is the
scenario's fixed login (`adaiversen`), and a repo under any other owner is
404, never 403.

## How it is built

- `lib/store.ts` — the one in-memory store: repos, objects, refs, issues,
  pulls, labels. Every surface reads and writes this store.
- `lib/gitobj.ts` — git objects (commit/tree/blob/tag), SHA-1 ids, tree
  building, reachability, merge-base.
- `lib/pack.ts` — pkt-lines, packfiles (plain and delta entries), side-band
  framing, zlib streams.
- `lib/gitproto.ts` — the smart-HTTP handlers: v2 advertisements and
  ls-refs/fetch (including shallow/deepen), v0 fallback, receive-pack with
  report-status, non-fast-forward rules.
- `lib/rest.ts` — REST v3: repos, branches, commits, contents, labels,
  issues, comments, pulls, merges, pagination with absolute `Link` URLs.
- `lib/graphql.ts` — GraphQL v4: a hand-rolled lexer, parser and executor
  covering the documents the suite sends, with opaque global ids.
- `lib/mcp.ts` — MCP: the modern 2026-07-28 revision and the legacy
  revisions, six tools over the shared store.
- `lib/util.ts` — shared constants: the viewer login, the zero oid,
  deterministic timestamps from `MAKEFUN_TRIAL_NOW`.

Determinism is a design rule, not an afterthought: no wall clock and no
unseeded randomness appear in any request path. Commit timestamps come only
from `MAKEFUN_TRIAL_NOW` (falling back to the scenario epoch), request ids
come from a counter, and ordering comes from creation sequence. A trial
replayed against the same state export is byte-identical.

## Local grading

The kit grades the same checks locally before you submit:

```sh
node cli/makefun.mjs grade-local --kit . \
  --bot /path/to/this/repo --driver process --worktree \
  --instances 3 --save /tmp/forge-trial
```

Practice trials 0–2: **120/120 conformance checks, score 981/1000**
(agent 200, feature 600, perf 181), replay byte-identical.

## Rules and limits

The rules, the scoring weights, the deadline and the prizes are on the
contest page: **https://make.fun/bounty/github-core-clone-01** (its Rules
section). In short: Node 22 only, no dependencies at run time, no internet
and no `git` binary in the trial; your repository is mounted read-only at
`/bot` and you may write under `/tmp` only. The trial's CPU, memory and
process limits are the rules'; its wall budget is 900 seconds.

## Layout

- `main.ts`: the lifecycle above. Keep it as it is.
- `app.ts`: the server: routing, auth, and the JSON envelope.
- `lib/`: the forge itself, one module per surface or codec.
- `package.json`, `tsconfig.json`, `LICENSE` (MIT): the entry's metadata
  and licence.

MIT licensed.
