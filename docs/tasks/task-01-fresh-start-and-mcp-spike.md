# Task 01: fresh start and MCP spike

*Brief v1, Oct 21, 2026. Paste this whole file into Claude Code or Codex, run from a clone of `github.com/marcusschimizzi/nacre`. Marcus reviews the PR.*

## Context
Nacre v3 is a ground-up reboot of Marcus's personal AI memory platform: **one memory shared by all his agents**. Slice 1 lets you tell Claude Code a fact and get it back in Grok Bot, with its quote and a link. This task is **slice 1, task 1**. It replaces the v2 code with a clean v3 scaffold and proves that a remote MCP server works with the clients we care about. Nothing else in slice 1 is in scope.

**Read first** (Marcus puts these files in the working tree; commit them under `docs/` in this PR):
- `docs/slice-1-spec.md`: the build spec. Read §3 Architecture, §8.1 (MCP connector), §9.1 (Grok Bot connector), §12.1–12.2 (hosting and stack), §15 (task list) and §16 (risks).
- `docs/design.md`: the overall design. Skim the Bottom line and §17 (roadmap).
- `docs/tasks/task-01-fresh-start-and-mcp-spike.md` (this file) and `docs/tasks/README.md` (the workflow).

If this brief and the spec disagree, follow the spec and say so in the PR.

## What to do

### 1. Preserve v2, then start fresh
- Before removing anything, tag the current `main` as **`v2-final`** and push the tag. Also push a **`v2`** branch from the same commit. Check that both exist on the remote.
- Work on a new branch, `task-01-fresh-start` (see README for naming). Don't force-push `main`, and don't delete or rewrite any other branch or tag. The open v2 branches stay as they are.
- Remove the v2 code, docs, and config: `packages/`, `data/`, `research/`, `test/`, the old `docs/*.md`, `CLAUDE.md`, `ARCHITECTURE.md`, `CONCEPT.md`, and the old build config. **Keep `LICENSE`** (Apache-2.0). Replace `README.md` with a short v3 README: what Nacre is, its status, how to run it locally, and links to `docs/`. Fix the package metadata to point at `github.com/marcusschimizzi/nacre`.

### 2. v3 scaffold (spec §12.2)
- TypeScript on Node (current LTS), ESM, strict `tsconfig`. Pick one package manager and pin it.
- Layout that matches the spec's **`api` + `worker`** design, both built from one image. For example: `src/api/` (Hono app: `/mcp`, `/healthz`, later `/v1/*` and the web app), `src/worker/` (a placeholder loop that logs and exits cleanly on SIGTERM), `src/shared/`, `migrations/` (an empty dir for hand-written dbmate `.sql` files, with a README line), and `test/`. Your choice of a single package or workspaces; keep it simple.
- Dependencies limited to what this task needs: `@modelcontextprotocol/sdk`, `hono` (plus its Node server adapter), `zod`, `pino`, Vitest, and a linter/formatter. Biome is fine; it's what v2 used. No database client yet, beyond a note on where it goes.
- Scripts: `dev`, `build`, `start:api`, `start:worker`, `test`, `lint`, `typecheck`.
- CI (GitHub Actions): install, lint, typecheck and test on every PR.
- **Railway-ready start config**, not deployed: a Dockerfile or Railpack/Nixpacks config plus `railway.json` (or a documented equivalent). It should cover the api start command, the worker start command, the `PORT` env var, and a `/healthz` health check. Document the expected env vars in `.env.example` with no real values.

### 3. Hello-world MCP spike
- A **remote MCP server over Streamable HTTP at `/mcp`**, mounted in the Hono app, with **one trivial tool** (e.g. `ping` → `{ "pong": true, "server_time": "..." }` or `echo`).
- **Bearer-token check** on `/mcp`: `Authorization: Bearer <token>` compared in constant time against a token from an env var (e.g. `NACRE_DEV_TOKEN`). Missing or wrong → `401` with a `WWW-Authenticate: Bearer` header. Never log the token. The real token table comes in task 3.
- **`GET /healthz`**: no auth, returns `200` and a tiny JSON body (service, version, commit if available).
- **Scripted SDK-client test over real HTTP**: start the server on a random port in Vitest, then connect with the SDK's Streamable HTTP client. Assert three things: `initialize` succeeds, `tools/list` shows the tool, and `tools/call` returns the expected result. Add negative tests: no token or a wrong token gives 401, and `/healthz` works without auth.
- **Protocol investigation.** The MCP spec's 2026-07-28 revision made the Streamable HTTP transport **stateless**, and clients may still be on older revisions. Find out, from the SDK source and changelog and the current spec, how the installed SDK handles this. Questions to answer:
  - Which protocol versions it negotiates.
  - Whether it needs a session id, or can run stateless.
  - Whether it still needs GET/SSE support for older clients.
  - What a server must do so both new and older clients connect.

  Configure the server so **both Claude Code and a generic remote MCP client (the Grok Bot connector)** can connect. If one of them can't, say so precisely in the doc rather than working around it in ways that weaken auth.
- **Write `docs/spike-mcp.md`** covering:
  - SDK version, the protocol versions seen, stateless vs. session mode, and the decision taken.
  - What Claude Code negotiated.
  - **User-level Claude Code setup:** `claude mcp add --transport http nacre --scope user <url>/mcp --header 'Authorization: Bearer ${NACRE_TOKEN}'` and `claude mcp get nacre`. Note how the token reaches the header (spec §8.1), and where user-level config lives (`~/.claude.json` for MCP servers, `~/.claude/settings.json` for hooks). Verify these paths against current Claude Code docs.
  - **Grok Bot connector setup** (spec §9.1): URL plus a bearer header, and what a remote client needs from the server.
  - Open issues and anything the spec should change.

## Out of scope
- The rest of slice 1: migrations, the DB schema, ingest, the worker logic, the real tools (`remember`, `recall`, `get_provenance`), the web app, and hooks.
- Deploying, or touching Railway in any way. Marcus resets the existing Nacre project himself at build time.
- DNS for `nacre.so`.
- **Any secret in the repo**, including the history: no real tokens, keys, or `.env`. A dev token lives only in your shell env or an untracked `.env`.

## Done when (list each check and its result in the PR description)
- [ ] `v2-final` tag and `v2` branch exist on GitHub at the old `main` commit.
- [ ] Clean v3 tree: v2 code removed, `LICENSE` kept, new README, and `docs/` holding `slice-1-spec.md`, `design.md`, `tasks/` and `spike-mcp.md`.
- [ ] `test`, `lint` and `typecheck` pass locally and in CI.
- [ ] The SDK-client test passes over HTTP (initialize, list, call, 401 cases, healthz).
- [ ] Manual local check: `curl` to `/healthz` returns 200, and `curl` to `/mcp` with no token returns 401. A scripted SDK call with the token lists and calls the tool. Paste the redacted output.
- [ ] **Claude Code connects locally**: added at user scope against `http://localhost:<port>/mcp`, `claude mcp get nacre` shows it connected, and the tool runs once from a session.
- [ ] Generic-client compatibility shown, e.g. with the MCP Inspector or a plain SDK client using another protocol version, and recorded in `docs/spike-mcp.md`. If Grok Bot needs a public URL, write down what to test once it's deployed.
- [ ] Start config and `.env.example` present; no secrets anywhere (`git log -p | grep -i` for token and key patterns comes back clean).
- [ ] PR opened from `task-01-fresh-start` to `main`, titled **"Task 01: fresh start and MCP spike"**, with a description that follows `docs/tasks/README.md`.

## Conventions
- Commits: Conventional Commits (`chore:`, `feat(api):`, `test:`, `docs:`), small and readable. The removal of v2 is its own commit, so review stays sane.
- PR: one task per PR. In the description, name the task, summarize the change, list every acceptance check with pass or fail plus evidence, add "Deviations from the brief/spec", and end with "Open questions for Marcus". Don't merge; Marcus reviews.
