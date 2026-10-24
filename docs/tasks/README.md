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
| 01 | [Fresh start and MCP spike](task-01-fresh-start-and-mcp-spike.md) | Done (PR #19, merged Oct 23, 2026) |
| 02 | [Schema, roles and append-only triggers](task-02-schema-roles-and-triggers.md) | Done (PR #20, merged Oct 23, 2026) |
| 03 | [Token CLI, auth middleware, activity log and Origin check](task-03-tokens-auth-and-origin.md) | Done (PR #25, merged Oct 24, 2026) |
| 03b | [Minimal OAuth 2.1 for MCP](task-03b-oauth.md) | Done (PR #26, merged Oct 24, 2026) |
| 03c | [OAuth follow-ups from the live test](task-03c-oauth-followups.md) | Done (PR #27, merged Oct 24, 2026) |
| 04 | [Event ingest (`POST /v1/events`)](task-04-event-ingest.md) | In progress (PR #28) |
