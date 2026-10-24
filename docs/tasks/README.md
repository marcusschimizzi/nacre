# Task briefs: how Nacre v3 is built

Nacre v3 is built task by task from `slices/slice-1-spec.md` §15 (and later slices), by Claude Code or Codex running locally against `github.com/marcusschimizzi/nacre`. Marcus reviews every PR.

## Workflow
1. **One brief per task.** Each task in the spec's task list gets a self-contained brief here, named `task-NN-short-name.md`. A brief states the context, the docs to read, what to do (outcomes, not line-by-line steps), what is out of scope, and the acceptance checks. It is written to be pasted straight into Claude Code or Codex.
2. **One branch and one PR per task.** Branch `task-NN-short-name` from up-to-date `main`. Keep the PR to that task. If something else needs doing, note it in the PR rather than doing it.
3. **The PR description** must:
   - name the task in the title (`Task NN: <title>`) and link the brief;
   - summarize what changed;
   - list **every acceptance check** from the brief, marked pass or fail, with how it was run and the evidence (command output, redacted);
   - list deviations from the brief or spec, with the reason;
   - end with open questions for Marcus.
4. **Review and merge.** Marcus reviews and merges. Agents never merge, force-push `main`, deploy, or touch Railway or DNS unless a brief explicitly says so.
5. **Docs live in the repo.** The spec, the design doc and the task briefs are committed under `docs/` in the repo: `docs/slice-1-spec.md`, `docs/design.md`, `docs/tasks/`. Task 01 adds them first. When a design file changes here, Marcus copies it in, and the next PR (or a small `docs:` PR) commits it. If the repo copy and this folder disagree, the newest dated changelog wins. Flag the mismatch in the PR.
6. **No secrets in the repo, ever.** Use env vars and an untracked `.env`; commit only `.env.example`.

## Conventions
- Conventional Commits (`feat(api):`, `fix(worker):`, `test:`, `docs:`, `chore:`).
- Tests, lint and typecheck pass locally and in CI before the PR is marked ready.
- Spec decisions are followed as written. A brief may simplify, but never contradicts a Decided item without saying so in the PR.

## Briefs
| # | Brief | Status |
|---|---|---|
| 01 | [Fresh start and MCP spike](task-01-fresh-start-and-mcp-spike.md) | Done (PR #19, merged Oct 23, 2026; docs follow-up PR #24, restores the lost commit pointing `docs/spike-mcp.md` open issue 3 at Copal and Wake's OAuth code as prior art for task 3b, merged Oct 23, 2026) |
| 02 | [Schema, roles and append-only triggers](task-02-schema-roles-and-triggers.md) | Done (PR #20, merged Oct 23, 2026; follow-up PR #21, migrations and A5 checks in `api`'s pre-deploy step, merged Oct 23, 2026; Railway fix PR #22, declares the `Postgres-PITR` bucket in `.railway/railway.ts`, merged Oct 23, 2026; Railway fix PR #23, drops `api`'s default restart policy to end a perpetual plan diff, merged Oct 23, 2026) |
| 03 | [Token CLI, auth middleware, activity log and Origin check](task-03-tokens-auth-and-origin.md) | Done (PR #25, merged Oct 24, 2026; applied Marcus's answers and spec v0.2.11) |
| 3b | [Minimal OAuth 2.1 for MCP](task-03b-oauth.md) (§9.3), depends on 3 | Done (PR #26, merged Oct 24, 2026, 2:23 AM, merge `18a075c`; five open questions answered by Marcus and applied in 3c; live Grok Bot test passed Oct 24, 2026) |
| 3c | [OAuth follow-ups from the live test](task-03c-oauth-followups.md), depends on 3b | Done (PR #27, merged Oct 24, 2026, 11:01 AM, merge `935d12c`; redirect host allow-list incl. `chatgpt.com`, 10 s refresh reuse grace, last-used agent preselection, `mcp_method` logging; spec v0.2.15) |
| 04 | [Event ingest (`POST /v1/events`)](task-04-event-ingest.md), depends on 3 | Done (PR #28, merged Oct 24, 2026, 3:05 PM, merge `2a3ca55`; brief v1.1; key-based metadata redaction, 8 KiB metadata cap, 400/413/422 bodies, POST-only; spec v0.2.17) |
| 05 | [Worker loop, `Extractor` + OpenAI adapter, prompt v1, `model_calls` and cost guard](task-05-worker-and-extractor.md) (§15), depends on 4 | Next, ready (brief v1.1, Oct 24, 2026) |
| 06 | [Quote verifier with unit and property tests (A4)](task-06-quote-verifier.md), no dependencies | Can run in parallel with 05 (brief v1.1, Oct 24, 2026) |

The task 3b brief cites Copal (`~/dev/copal`) and Wake (`~/dev/wake`) OAuth code as prior art to reuse (PR #24).
