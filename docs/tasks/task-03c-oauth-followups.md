# Task 3c: OAuth follow-ups from the live test

*Brief v1, Oct 24, 2026. Written after the task 3b live test (PR #26, merged Oct 24), from Marcus's decisions on that PR's open questions. Paste this whole file into Claude Code or Codex, run from an up-to-date clone of `github.com/marcusschimizzi/nacre` (`main` at or after `18a075c`, the task 3b merge). Marcus reviews the PR.*

## Context
Task 3b shipped a minimal OAuth 2.1 server for MCP (`src/api/oauth/`, `src/shared/oauth.ts`, `src/shared/tokens.ts`). The live test on Oct 24 (PR #26, "Live results") showed:
- **grok.com** registered dynamically (`client_name` `Grok`, redirect `https://grok.com/connectors-oauth-exchange-code/`). **Cursor** did too, three times in two seconds (`client_name` `Cursor`, redirects `https://www.cursor.com/agents/mcp/oauth/callback` and `http://localhost:8787/callback`). Both use MCP protocol `2025-11-25`, and both are public clients with `authorization_code` and `refresh_token` grants.
- Revoking a grant worked end to end: the access token got 401, the refresh got `invalid_grant`, and the client reopened consent.
- **Reconnect gap:** Marcus approved Cursor as `grok-bot`, revoked it, and reconnected through the same `client_id`. The consent page preselects by the slug of `client_name` (`cursor`), so it defaulted to creating a new `cursor` agent. Spec §9.3 says a reconnect "lands on its own agent", which is only true when the agent id equals the slug.
- **Logging gap:** `mcp_method` in the request log comes only from the `Mcp-Method` header, which `2025-11-25` clients don't send, so the log can't tell `tools/call` from `tools/list` for Grok or Cursor.
- **No refresh happened** during the test, so there is no data on parallel refreshes yet.

Marcus's decisions (PR #26): keep Deny requiring the password; keep the absolute 30-day refresh lifetime; no `agent_create` activity kind; **add a short reuse grace window (about 10 seconds)**; **add a redirect-host allow-list**.

**This task adds no migration and no Railway variable.** `nacre_app` already has `SELECT` on `oauth_clients`, `oauth_auth_codes` and `agent_tokens`. If you think it needs a migration or a variable, stop and say why in the PR.

**Read first:** `docs/slice-1-spec.md` §9.3 and §14 A17; `docs/tasks/task-03b-oauth.md`; PR #26's description ("Live results", "Decisions"); `src/shared/oauth.ts`, `src/api/oauth/routes.tsx`, `src/api/app.ts`, `test/oauth.test.ts`, `test/oauth-unit.test.ts`. Prior art for the grace window: Copal, `~/dev/copal/apps/api/src/oauth/tokens.ts` (`REUSE_GRACE_MS`).

## What to do

### 1. Redirect-host allow-list
- `https` redirect URIs are accepted only when the URL's host is **exactly** one of a list in code, `OAUTH_REDIRECT_HOSTS` in `src/shared/oauth.ts`. It has no wildcards and no subdomain matching, and the port must be the default. Start with `grok.com`, `www.cursor.com`, `claude.ai` and `claude.com`, one comment line each saying which client uses it. Adding a host is a reviewed code change, not a variable.
- **Loopback stays allowed on any port** (`http://127.0.0.1`, `http://[::1]`, `http://localhost`; RFC 8252). Claude Code and Cursor's local callback rely on it. All of 3b's other rules stay: no fragment, no userinfo, the length cap, 1–5 URIs.
- Check at **registration** (`400 invalid_redirect_uri` if any URI fails) and again at **`GET /oauth/authorize`** before anything else uses the URI. There, a registered client whose redirect host is no longer allowed gets the error page, **never a redirect**, and a request-log `oauth` value like `authorize:redirect_not_allowed`. The production clients from the live test all pass.

### 2. Refresh-token reuse grace window (10 seconds)
- `REUSE_GRACE_MS = 10_000`. When a refresh token comes back already rotated and its `rotated_at` is within the window, and the grant is not revoked, reply `invalid_grant`. **Don't revoke the grant**, and don't write `oauth_refresh_reuse`; the request log gets `oauth: token:refresh_reuse_grace`.
- Outside the window, or for a reused **authorization code** (no grace), keep 3b's behavior: revoke the grant and log `oauth_refresh_reuse`.
- A revoked grant answers `invalid_grant` as today, and is checked before the grace branch, so a revoke is never mistaken for a replay. Keep the per-grant advisory lock, so of two parallel refreshes exactly one rotates and the other lands in the grace branch.
- Not chosen: handing the late request a second fresh pair. That would leave two live refresh chains in one grant.

### 3. Reconnect preselects the agent this client used last
Change the consent page's preselection order, in `suggestAgentId` or a small wrapper around it:
1. **The agent of this `client_id`'s most recent approved consent**, found from `oauth_auth_codes` (latest `created_at` for the client), if that agent is still enabled.
2. Otherwise, **the agent of the most recent approved client with the same `client_name` and the same `redirect_uris`** (as a set), if still enabled. This covers a client that registers again on reconnect.
3. Otherwise, 3b's rule: the enabled agent whose id equals the slug, or else "Create new agent".

The page says why an agent is preselected, in one short line ("Last used by this client" or "Matches the client's name"). It's still only a default: the owner can change it, and the server re-validates the choice as today. The create-new input keeps 3b's prefill.

### 4. `mcp_method` for older-protocol clients
When the `Mcp-Method` header is absent on `POST /mcp`, log the JSON-RPC `method` from the body: a single JSON object only, only a string matching `^[a-z][a-zA-Z0-9_/]{0,63}$`, never `params` or anything else. Don't break the transport's read of the body: read a clone, or read it once and hand it on, and prove `tools/call` still works in a test. A body that isn't JSON, is a batch, or is over the size you're willing to parse logs no `mcp_method`.

### 5. Docs
- **Spec** (a `docs:` commit, bumped to **v0.2.14** with a changelog line):
  - §9.3: the registration row (the https host allow-list), the consent-page row (the preselection order), and the token-endpoint row (the 10 s grace window).
  - §14 A17: the matching tests.
  - §19: the RFC 8252 loopback note if needed.
- `docs/tasks/README.md`: 03b Done (PR #26, merged Oct 24, 2026), and add 03c.

## Out of scope
Anything on Railway or DNS; schema changes; new variables; CIMD, client secrets, scopes; an `agent_create` kind; changing Deny or the refresh lifetime; `/admin`, `/v1/*`.

## Done when (list each check and its result in the PR description)
- [ ] `pnpm lint`, `pnpm typecheck`, `pnpm test` (with `TEST_DATABASE_URL`) and `pnpm build` pass locally and in CI; paste the test count.
- [ ] **Allow-list:**
  - Registering with each start-list host's real callback (the three observed URIs above, plus `https://claude.ai/api/mcp/auth_callback`) returns `201`.
  - `https://evil.example/cb`, `https://grok.com.evil.example/cb`, `https://sub.grok.com/cb`, `https://grok.com:8443/cb` and `https://cursor.com/cb` (not `www.`) return `400 invalid_redirect_uri`.
  - Loopback on any port returns `201`.
  - A client row inserted directly with a disallowed https URI gets the error page at `/oauth/authorize`, with no `Location`.
- [ ] **Grace window:**
  - Rotating, then presenting the old refresh token within 10 s (inject the clock) gives `invalid_grant`. The grant still works: the new refresh token rotates, and no `oauth_refresh_reuse` row is written.
  - The same after 10 s revokes the grant and writes `oauth_refresh_reuse`.
  - Two parallel refreshes give one `200` and one `invalid_grant`, and the grant survives.
  - A reused code still revokes at once.
  - The test fails if the window is removed (mutation check).
- [ ] **Preselection:**
  - (a) Same `client_id`, approved first as an agent whose id isn't the slug (a client named `Cursor` approved as `grok-bot`), then revoked: the next consent preselects `grok-bot` with "Last used by this client".
  - (b) A fresh registration with the same name and redirect URIs preselects that agent too.
  - (c) The same name with different redirect URIs falls back to the slug rule.
  - (d) A disabled last-used agent is skipped.
  - 3b's preselection tests still pass.
- [ ] **`mcp_method`:** a `2025-11-25`-style `tools/call` with no `Mcp-Method` header logs `mcp_method: "tools/call"` and still succeeds. A batch, a non-JSON body and a method with odd characters log none. The header still wins when present.
- [ ] No schema change (`git diff main --stat -- migrations` is empty), `.railway/railway.ts` unchanged, and no secrets committed.
- [ ] **Live check (Marcus, after deploy).** The PR lists these steps with blank result lines:
  1. Reconnect Cursor, choose `grok-bot`, and `ping`.
  2. Revoke it and reconnect: `grok-bot` is preselected with "Last used by this client".
  3. Reconnect grok.com: its consent page opens, so its redirect host is allowed.
  4. After an hour of use, the `api` logs show `token:refresh` for each.
  5. Cursor's and Grok's `tools/call` lines show `mcp_method`.
- [ ] PR from `task-03c-oauth-followups` to `main`, titled **"Task 3c: OAuth follow-ups from the live test"**, with deviations and open questions per `docs/tasks/README.md`. Don't merge.

## Conventions
Conventional Commits, small and readable. The docs changes are their own commit. One task per PR. No secrets in the repo, ever.
