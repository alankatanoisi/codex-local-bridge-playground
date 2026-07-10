# Codex protocol notes (Phase 0)

Pinned 2026-07-08 against a **live 200 streamed response** captured with a throwaway curl probe on the capture
machine. Updated 2026-07-10 for Phase 3 native rewrite (function-call fixtures + capture helper). This is the contract
Phase 2 (transport) and Phase 3 (native client) build against. If any of this drifts, update this file and the
findings callout in `docs/codex-bridge-runner-roadmap.html` together.

Reference fixture (redacted): `test/runner/fixtures/codex/responses-stream-pong.sse`.

## Endpoint

- `POST https://chatgpt.com/backend-api/codex/responses` — the ChatGPT backend.
- `api.openai.com/v1/responses` returns **401** for an `at-…` token: the ChatGPT Business programmatic access token
  is **not** a platform API key, and the platform endpoint is not part of this lane.

## Auth

- Header: `Authorization: Bearer $CODEX_ACCESS_TOKEN` (the `at-…` token; env var is the only sanctioned source in
  this repo).
- On-disk source used by the official Codex CLI: `~/.codex/auth.json` → key `personal_access_token`
  (`OPENAI_API_KEY` is `null` there). The runner does **not** read that file; it reads the env var only.

## Request body

```json
{ "model": "gpt-5.5", "input": [...], "store": false, "stream": true }
```

- `input` is a list of typed items. A user message item looks like:
  `{ "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "…" }] }`.
- `max_output_tokens` is **rejected** ("Unsupported parameter") — omit it. Output-budget enforcement stays a
  runner-side concern (existing budget tracker).
- `stream: false` is **rejected** ("Stream must be set to true") — the backend is **streaming-only**. Phase 3
  therefore implements one code path: the streaming client. There is no buffered `post()` equivalent for this lane.

## SSE event grammar (observed order)

```text
response.created
response.in_progress
response.output_item.added
response.content_part.added
response.output_text.delta      (repeats; text tokens)
response.output_text.done
response.content_part.done
response.output_item.done
response.completed
```

- Text tokens arrive in `response.output_text.delta` → field `delta` (the analog of Anthropic's `text_delta`).
- Each delta event also carries an `obfuscation` field. The mapper must **tolerate and ignore** it.
- **`response.output` is empty `[]` on `response.completed`** in every live capture so far (pong, function-call,
  final-answer). Phase 3 must assemble output items from `response.output_item.*` / argument / text events — do not
  rely on the terminal `response.output` array.

### Function-call SSE (live capture 2026-07-10)

Reference fixture (redacted, live): `test/runner/fixtures/codex/responses-stream-function-call.sse`.
Captured with `npm run capture:codex -- --preset function-call` (model `gpt-5.5`, `reasoning.effort: medium`,
`include: ["reasoning.encrypted_content"]`). Leak-grep: 0 hits.

Observed event order for a single `list_files` tool call:

```text
response.created
response.in_progress
response.output_item.added          (item.type: function_call; call_id + name; arguments: "")
response.function_call_arguments.delta   (repeats; JSON string fragments; obfuscation present)
response.function_call_arguments.done    (full arguments JSON string)
response.output_item.done           (completed function_call item)
response.completed                  (response.output: []; reasoning_tokens: 0)
```

- Each `function_call_arguments.delta` carries an `obfuscation` field — tolerate and ignore (same as text deltas).
- Arguments arrive as a JSON **string** on the completed item (`{"path":"."}`), not a parsed object.
- Fail-closed: malformed argument JSON must never become an executable empty `{}`.
- No separate `reasoning` output item was emitted on this medium-effort tool turn (`reasoning_tokens: 0`).
  Treat reasoning-item replay as required when present; do not assume every turn emits one.

### Final-answer SSE after function_call_output (live capture 2026-07-10)

Reference fixture (redacted, live): `test/runner/fixtures/codex/responses-stream-final-answer.sse`.
Captured with `npm run capture:codex -- --preset final-answer`. Leak-grep: 0 hits.

Uses the same text delta grammar as the pong probe:

```text
response.created → … → response.output_item.added (message / final_answer)
→ content_part.added → output_text.delta* → output_text.done
→ content_part.done → output_item.done → response.completed
```

Assistant message items include `phase: "final_answer"`. Again `response.output: []` on completed.

## Prompt caching

- Automatic; **no request-side markers** exist or are needed.
- The response reports `prompt_cache_key` (a UUID) and `prompt_cache_retention: "24h"`.
- Consequence for Phase 3: **delete** the runner's `cache_control` budgeting rather than porting it.

## Reasoning

- Request/response metadata includes `reasoning: { effort: "medium", context, mode, summary }`.
- CLI `--effort` maps to `reasoning.effort`.
- Live function-call / final-answer captures at `medium` did **not** emit a `reasoning` output item or encrypted
  content, even with `include: ["reasoning.encrypted_content"]`. When a reasoning item *does* appear, preserve it
  verbatim across turns under `store: false` (same opaque round-trip pattern as Anthropic thinking signatures).
- `temperature` was accepted/echoed as `1` on these captures (not rejected). Effort value `max` is still untested —
  map runner `max` to the nearest accepted value when first observed.

## Usage field names (exact)

| Responses API field                         | Runner-internal field        |
| ------------------------------------------- | ---------------------------- |
| `input_tokens`                              | `input_tokens`               |
| `input_tokens_details.cached_tokens`        | `cache_read_input_tokens`    |
| `input_tokens_details.cache_write_tokens`   | ignore / treat as 0          |
| `output_tokens`                             | `output_tokens`              |
| `output_tokens_details.reasoning_tokens`    | (new; record in transcripts) |
| `total_tokens`                              | (derived; ignore)            |

Live captures include `cache_write_tokens: 0` under `input_tokens_details`. There is still no meaningful cache-write
billing signal for this lane — keep runner `cache_creation_input_tokens` fixed at 0.

## Redaction requirements for fixtures and logs

Anything captured from this backend may contain durable account identifiers even after the token is stripped:

- `safety_identifier` (`user-…`) → replace with `user-[REDACTED-ID]`.
- `prompt_cache_key` UUID → replace with `[REDACTED-UUID]`.
- `at-…` / `sk-…` / `eyJ…` shapes → must never appear; grep the fixture for them before committing (expect 0 hits).
