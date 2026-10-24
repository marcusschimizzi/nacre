# OpenAI Responses API fixtures

These bodies are **hand-written in the documented Responses API shape on Oct 24, 2026** (the
`POST /v1/responses` reference at developers.openai.com), not captured from a live call. The adapter
tests (`test/openai.test.ts`) serve them through an injected `fetch`, so no test touches the network.
- `ok-*.json`, `cached-tokens.json`: a completed response whose `output_text` is the model's JSON.
- `refusal.json`, `incomplete.json`, `api-error.json`: billed or failed responses the adapter must
  turn into `refusal`, `incomplete` and `api_error`.
- `malformed-json.json`, `schema-*.json`: output that isn't valid JSON or breaks the claim schema.
- `http-error.json`: the error body sent with a non-2xx status (the tests pick the status).

The `FIXTURE-…-TEXT` strings are sentinels: tests assert they never reach an error message or a log.
Marcus can replace any file with a real capture later (redact the request id; there is no key in a
response body).
