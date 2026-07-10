# Codex SSE fixtures

Redacted streamed Responses API captures for offline transport and Phase 3 client tests.

| File | Purpose | Source |
| ---- | ------- | ------ |
| `responses-stream-pong.sse` | Text-only ping | Live capture (Phase 0) |
| `responses-stream-function-call.sse` | Tool-call turn (`list_files`) | Live capture 2026-07-10 (`--preset function-call`) |
| `responses-stream-final-answer.sse` | Post-`function_call_output` text answer | Live capture 2026-07-10 (`--preset final-answer`) |

Both Phase 3 captures reported `leak-grep: 0 hits` and were re-checked by `test/runner/capture-codex-fixture.test.js`.

## Re-capture (if the wire grammar drifts)

```bash
cd /Users/alanman/Developer/codex-local-bridge-playground
export CODEX_ACCESS_TOKEN=<at-… token from ChatGPT dashboard>

npm run capture:codex -- --preset function-call --out test/runner/fixtures/codex/responses-stream-function-call.sse
npm run capture:codex -- --preset final-answer --out test/runner/fixtures/codex/responses-stream-final-answer.sse
```

Success: script prints `leak-grep: 0 hits`. Review the diff, then commit. Rotate the token afterward if it touched a terminal.

Wire contract: `docs/lab-notes/codex-protocol-notes.md`.
