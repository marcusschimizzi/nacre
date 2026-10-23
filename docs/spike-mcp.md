# MCP spike: remote Streamable HTTP server, old and new clients

*Task 01, Oct 23, 2026. Run on Node 24.19, macOS. "Observed" means seen in this spike's tests, logs or manual runs; "from source" means read in the installed SDK's `dist`; everything else says where it comes from.*

## Bottom line

- **SDK:** the official TypeScript SDK **v2**: `@modelcontextprotocol/server` 2.3.1 on the server, `@modelcontextprotocol/client` 2.3.1 in tests. **Not** `@modelcontextprotocol/sdk`: that package is the v1 maintenance line, implements the spec only up to 2025-11-25, and its README says 2026-07-28 support "is not planned for v1.x". The spec (§12.2) and the brief name `@modelcontextprotocol/sdk`; v2 is the same official SDK, split into packages, and the only line that does what §12.2 relies on (tracks the spec, negotiates with older clients).
- **Decision: fully stateless, one endpoint, both protocol eras.** `/mcp` is served by `createMcpHandler(factory, { legacy: 'stateless' })`. 2026-07-28 requests are answered statelessly; 2025-era clients get the classic stateless Streamable HTTP leg (a fresh server per request, no `Mcp-Session-Id`, `405` on `GET`/`DELETE`). No sessions, no sticky routing, nothing in memory between requests.
- **Clients:** Claude Code 2.1.309 negotiates **2026-07-28**, connects at user scope and runs the tool from a session. Forced to the legacy protocol it also connects (2025-11-25). The v1 SDK client, the v2 client pinned to 2025-11-25 / 2025-06-18 / 2025-03-26, and MCP Inspector 2.12 all list and call `ping`. **Grok Bot is untested**: it needs a public URL (see below).

## Protocol findings

### Versions the server negotiates
The v2 SDK keeps two lists (from source):
- **Legacy, `initialize` handshake:** `2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05`, `2024-10-07` (`@modelcontextprotocol/core` `SUPPORTED_PROTOCOL_VERSIONS`; `LATEST_PROTOCOL_VERSION` is still `2025-11-25` because it only names the latest *handshake* version).
- **Modern:** `2026-07-28` (`SUPPORTED_MODERN_PROTOCOL_VERSIONS` in `@modelcontextprotocol/server`).

How a request is classified (from source, `classifyInboundRequest`): it is **modern** only if its body carries `params._meta["io.modelcontextprotocol/protocolVersion"]`. `initialize`, envelope-less POSTs, batches and `GET`/`DELETE` are **legacy**.

On the wire (observed):

| | 2026-07-28 | 2025-era |
|---|---|---|
| Handshake | none; clients may send `server/discover` first | `initialize` → `notifications/initialized` (202) |
| Per-request headers | `MCP-Protocol-Version: 2026-07-28`, `Mcp-Method: tools/call` (+ `Mcp-Name`) | `MCP-Protocol-Version: 2025-xx` after `initialize` |
| Per-request body | version, client info and capabilities in `params._meta` | plain JSON-RPC |
| Session id | none | none (we never issue `Mcp-Session-Id`) |
| `GET /mcp` (SSE stream) | not used | `405`; both client generations treat it as "no stream" and carry on |

### Session id, stateless, GET/SSE
- **Session id: not needed.** Both eras run without `Mcp-Session-Id` (observed; asserted in `test/mcp-http.test.ts`).
- **GET/SSE: not needed.** In stateless mode `GET` and `DELETE` get `405 Method not allowed`. The v1 client (`sdk/dist/esm/client/streamableHttp.js`), the v2 client, Claude Code and MCP Inspector all accept that and continue (observed). Responses to POSTs can still stream as SSE within the request.
- **What a server must do so both kinds of client connect:** use `createMcpHandler` (not a bare `WebStandardStreamableHTTPServerTransport`, which only serves the legacy leg), keep `legacy: 'stateless'` (the default), build a fresh `McpServer` per request in the factory, put auth in front of it, and leave `GET`/`DELETE` to the handler.
- Cost: the server cannot push unsolicited notifications (list-changed, progress outside a request). Slice 1 needs none. Claude Code still opens `subscriptions/listen` (observed, answered 200); if a later slice needs server push, revisit with the SDK's event-bus option.

### Auth
- `Authorization: Bearer <token>` is checked before the MCP handler, in constant time (SHA-256 both sides, then `timingSafeEqual`). Missing, malformed, wrong-scheme and wrong tokens all get the same `401` with `WWW-Authenticate: Bearer realm="nacre"`.
- **No OAuth loop.** We serve no `/.well-known/oauth-*` metadata and send no `resource_metadata` in the challenge. The SDK clients only try OAuth when given an `authProvider` (from source). Claude Code with a static `Authorization` header reports the 401 and does **not** fall back to OAuth (observed message: "Server rejected the configured Authorization header (HTTP 401)… OAuth fallback is disabled when headers.Authorization is set").
- The token is never logged. The request log has method, path, status, timing, `MCP-Protocol-Version`, `Mcp-Method` and user agent only; pino also redacts any `authorization`/`token` field. A test asserts the token never appears in log output.

## What Claude Code negotiated

Claude Code **2.1.309**, from the server's request log (redacted, observed):

```
# default (MCP_PROTOCOL_NEGOTIATION unset): modern
POST 200 2026-07-28 server/discover      claude-code/2.1.309 (sdk-cli)
POST 200 2026-07-28 subscriptions/listen claude-code/2.1.309 (sdk-cli)
POST 200 2026-07-28 tools/list           claude-code/2.1.309 (sdk-cli)
POST 200 2026-07-28 tools/call           claude-code/2.1.309 (sdk-cli)

# MCP_PROTOCOL_NEGOTIATION=legacy: 2025-11-25 handshake
POST 200 -          (initialize)         claude-code/2.1.309 (sdk-cli)
POST 202 2025-11-25 (initialized)        claude-code/2.1.309 (sdk-cli)
GET  405 2025-11-25 (SSE stream refused) claude-code/2.1.309 (sdk-cli)
POST 200 2025-11-25 (tools/list)         claude-code/2.1.309 (sdk-cli)
```

The Claude Code docs say it asks HTTP servers whether they support 2026-07-28 and uses it if so; `MCP_PROTOCOL_NEGOTIATION` (`auto` | `legacy`) and `MCP_SDK_GENERATION` (`v1` | `v2`) override that (code.claude.com/docs/en/mcp.md).

## Claude Code setup (user level)

```bash
# Token: from `nacre token create --agent claude-code` once task 3 exists; NACRE_DEV_TOKEN for now.
mkdir -p ~/.nacre && chmod 700 ~/.nacre
printf '%s' '<token>' > ~/.nacre/token && chmod 600 ~/.nacre/token
echo 'export NACRE_TOKEN="$(cat ~/.nacre/token)"' >> ~/.zshrc

claude mcp add --transport http nacre --scope user https://api.nacre.so/mcp \
  --header 'Authorization: Bearer ${NACRE_TOKEN}'
claude mcp get nacre        # Status: ✔ Connected
```

- **How the token reaches the header (spec §8.1), verified.** The single quotes keep the shell from expanding `${NACRE_TOKEN}`, so the config stores the literal `Bearer ${NACRE_TOKEN}` (observed in `~/.claude.json`). Claude Code expands it from **its own process environment** at connect time. A custom name like `NACRE_TOKEN` expands; Claude Code's own credential variables (`ANTHROPIC_API_KEY` and similar) would read as empty toward a remote server (docs). With `NACRE_TOKEN` unset, `claude mcp get` shows `✘ Failed to connect` with the 401 message above (observed).
  - Caveat: Claude Code launched outside a shell that sources `~/.zshrc` (desktop app, some IDE launches) will not see `NACRE_TOKEN`. Hooks read `~/.nacre/token` directly (§8.3), but the MCP header can't.
- **Where config lives (verified against code.claude.com docs and on disk):** user-scope MCP servers are in **`~/.claude.json`**, top-level `mcpServers.nacre` (`{"type":"http","url":…,"headers":{"Authorization":"Bearer ${NACRE_TOKEN}"}}`). User-level hooks go in **`~/.claude/settings.json`** (spec §8.2). `CLAUDE_CONFIG_DIR` relocates the latter.
- Remove with `claude mcp remove nacre --scope user`.

## Grok Bot connector setup (spec §9.1)

- Add a **remote MCP server**: URL `https://api.nacre.so/mcp` (the Railway `*.up.railway.app` URL until DNS is live) and header `Authorization: Bearer nacre_tok_…` minted with `--agent grok-bot`. The token goes in the header, never the URL.
- What a remote client needs from the server, all in place: public HTTPS; Streamable HTTP on POST at `/mcp`; JSON or SSE responses within the request; either protocol era; a static bearer header with no OAuth; `405` on `GET` tolerated; no session affinity (any replica can answer).
- **Not tested: Grok Bot needs a public URL.** Exposing a dev machine through a tunnel was out of scope. **Test this once the api service is deployed:**
  1. Grok Bot's connector UI accepts a custom `Authorization` header. If it only offers OAuth or a URL token, stop and decide; §9.1 forbids tokens in URLs.
  2. With a wrong token, the connector shows an error rather than starting OAuth discovery.
  3. With the right token, it lists `ping` and calls it from a chat. The request log shows its `MCP-Protocol-Version` and user agent; record both here.
  4. `NACRE_TOKEN=… pnpm mcp:smoke https://<railway-domain>/mcp` passes against the deployed URL (all five modes).
  5. If it stays on a legacy protocol, confirm no request gets `400`/`-32020` (a modern envelope without the version header).

## Generic-client compatibility (observed)

| Client | Protocol | Result |
|---|---|---|
| Claude Code 2.1.309, default | 2026-07-28 | connected, `tools/list`, `tools/call` from a `claude -p` session |
| Claude Code 2.1.309, `MCP_PROTOCOL_NEGOTIATION=legacy` | 2025-11-25 | connected |
| `@modelcontextprotocol/client` 2.3.1, pinned / `auto` | 2026-07-28 | initialize-free connect, list, call |
| `@modelcontextprotocol/client` 2.3.1, legacy | 2025-11-25, 2025-06-18, 2025-03-26 | initialize, list, call |
| `@modelcontextprotocol/sdk` 1.32.1 client | 2025-11-25 | initialize, list, call (structured content intact) |
| MCP Inspector 2.12.0 CLI (`--transport http --header …`) | 2025-11-25 | `tools/call ping` returned `{pong: true, …}` |
| Grok Bot | ? | not tested, needs a public URL (above) |

Reproduce: `pnpm test` (the SDK rows) and `NACRE_TOKEN=… pnpm mcp:smoke http://localhost:3000/mcp`.

## Open issues, and what the spec should change

1. **§12.2 stack table:** replace `@modelcontextprotocol/sdk` with `@modelcontextprotocol/server` (and `@modelcontextprotocol/client` for tests). v1 will not get 2026-07-28.
2. **§12.1 / §15 task 1 / brief: `railway.json` is deprecated.** Railway's docs say Config as Code is deprecated, **new services cannot opt into it**, and existing files stop being read on **2026-12-01**. This PR ships `.railway/railway.ts` (Railway Infrastructure as Code) plus a `Dockerfile` instead. Applying it is a `railway config plan` / `apply` against the project, so it belongs to the reset Marcus does; note that a single-file plan proposes deleting resources the file doesn't list (today: the old Postgres and the bucket, which §12.1 removes anyway; after task 2, Postgres must be added to the file).
3. **Grok Bot**: header support and protocol version are unknown until deploy (above). This is still the biggest client risk (R1/R2).
4. **Origin validation (a spec MUST, not yet done).** The Streamable HTTP transport spec says servers MUST validate `Origin` to prevent DNS rebinding. Here the bearer token already defeats a rebinding page, because the page can't read the token. I left it out because Grok Bot's connector might send an `Origin` we can't predict until it's tested. Proposal: once Grok Bot's behavior is known (task 12 at the latest), reject requests whose `Origin` is present and not allow-listed. Do it before the web app's cookie auth (task 13), since cookies are sent automatically.
5. **Server push** is off in stateless mode (above). That's fine for slice 1; revisit if a slice needs list-changed or server notifications.
6. **`NACRE_TOKEN` outside a shell** (above): consider documenting a launcher, or reading the token from a file once Claude Code supports that for headers.
7. **Toolchain notes:** TypeScript 7.0 (native compiler) and pnpm 12 work here; pnpm 12 fails installs on unapproved build scripts, so `esbuild` is allowed in `pnpm-workspace.yaml`. Node 26 becomes LTS around the end of October 2026; the image pins Node 24 (Active LTS today).
