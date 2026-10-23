# Nacre

**One memory, shared by all of your AI agents.** Tell Claude Code a fact; get it back in Grok Bot with the exact quote it came from and a link to the original message.

Nacre keeps an append-only log of what your agents saw, turns it into claims whose quotes are checked in code, and serves the resulting beliefs to every agent over MCP, with provenance on every answer. Like mother-of-pearl, it is built in thin layers over time.

## Status

**v3, slice 1, task 1: scaffold and MCP spike.** This is a ground-up reboot. What exists today:
- an `api` service (Hono) with a remote MCP endpoint at `/mcp` (Streamable HTTP, one `ping` tool, bearer-token auth) and `GET /healthz`;
- a placeholder `worker` service;
- CI, a Dockerfile and Railway Infrastructure as Code (not deployed).

The real tools (`remember`, `recall`, `get_provenance`), Postgres, extraction and the web app arrive over the rest of slice 1. v2 (the markdown knowledge-graph version) is preserved at the [`v2-final`](https://github.com/marcusschimizzi/nacre/tree/v2-final) tag and the [`v2`](https://github.com/marcusschimizzi/nacre/tree/v2) branch.

## Run it locally

Needs Node 24 (see `.node-version`) and pnpm, pinned through `packageManager` (`corepack enable` picks the right version).

```bash
pnpm install
cp .env.example .env          # then set NACRE_DEV_TOKEN, e.g. $(openssl rand -base64 32)
pnpm dev                      # api on http://localhost:3000
pnpm dev:worker               # placeholder worker, in another terminal

curl localhost:3000/healthz
```

Connect Claude Code to the local server (see [`docs/spike-mcp.md`](docs/spike-mcp.md)):

```bash
export NACRE_TOKEN=<the same value as NACRE_DEV_TOKEN>
claude mcp add --transport http nacre --scope user http://localhost:3000/mcp \
  --header 'Authorization: Bearer ${NACRE_TOKEN}'
claude mcp get nacre
```

Other scripts: `pnpm test`, `pnpm lint`, `pnpm typecheck`, `pnpm build`, then `pnpm start:api` / `pnpm start:worker`.

## Layout

| Path                  | What                                                               |
| --------------------- | ------------------------------------------------------------------ |
| `src/api/`            | Hono app: `/mcp`, `/healthz`; later `/v1/*` and the web app        |
| `src/worker/`         | Job worker (placeholder loop)                                      |
| `src/shared/`         | Config, logging, build info                                        |
| `migrations/`         | Hand-written dbmate `.sql` files (from task 2)                     |
| `test/`               | Vitest, including an MCP client test over real HTTP                |
| `.railway/railway.ts` | Railway Infrastructure as Code for the `api` and `worker` services |

## Docs

- [`docs/design.md`](docs/design.md): the overall design
- [`docs/slice-1-spec.md`](docs/slice-1-spec.md): the slice 1 build spec
- [`docs/tasks/`](docs/tasks/): task briefs and the workflow
- [`docs/spike-mcp.md`](docs/spike-mcp.md): MCP protocol findings and client setup

## License

[Apache-2.0](LICENSE)
