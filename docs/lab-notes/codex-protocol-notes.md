# Codex protocol notes (Phase 0)

Pinned 2026-07-08 against a **live 200 streamed response** captured with a throwaway curl probe on the capture
machine. This is the contract Phase 2 (transport) and Phase 3 (adapter) build against. If any of this drifts, update
this file and the findings callout in `docs/codex-bridge-runner-roadmap.html` together.

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
- Function-call and reasoning item streaming were not exercised by the pong probe; extend this section when the
  Phase 3 adapter first observes them (expected: `response.function_call_arguments.delta` / `.done` per the
  Responses API family).

## Prompt caching

- Automatic; **no request-side markers** exist or are needed.
- The response reports `prompt_cache_key` (a UUID) and `prompt_cache_retention: "24h"`.
- Consequence for Phase 3: **delete** the runner's `cache_control` budgeting rather than porting it.

## Reasoning

- The response includes `reasoning: { effort: "medium", … }`.
- CLI `--effort` maps to `reasoning.effort`.
- The reasoning object is treated as a replayable/opaque block — reuse the runner's thinking-signature preservation
  path.

## Usage field names (exact)

| Responses API field                      | Runner-internal field        |
| ---------------------------------------- | ---------------------------- |
| `input_tokens`                           | `input_tokens`               |
| `input_tokens_details.cached_tokens`     | `cache_read_input_tokens`    |
| `output_tokens`                          | `output_tokens`              |
| `output_tokens_details.reasoning_tokens` | (new; record in transcripts) |
| `total_tokens`                           | (derived; ignore)            |

There is **no cache-write counter** — fix `cache_creation_input_tokens` at 0.

## Redaction requirements for fixtures and logs

Anything captured from this backend may contain durable account identifiers even after the token is stripped:

- `safety_identifier` (`user-…`) → replace with `user-[REDACTED-ID]`.
- `prompt_cache_key` UUID → replace with `[REDACTED-UUID]`.
- `at-…` / `sk-…` / `eyJ…` shapes → must never appear; grep the fixture for them before committing (expect 0 hits).
