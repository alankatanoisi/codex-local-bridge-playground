# Codex Local Bridge Playground

> **Reviewed November 11, 2026:** the preserved Codex runner, T3 ACP adapter, and standalone host are implemented.
> The offline suite passes 682 tests. This review repaired terminal-stream redaction and an unknown-model pricing edge case.
> See the [setup and hosting guide](./docs/codex-acp-hosting.html) and the
> [dated cleanup review](./docs/codex-cleanup-review-2026-11-11.html).
> Earlier T3 tests used a fake backend; earlier paid backend tests ran outside T3. Combined live T3 use,
> actual billing, and endurance remain unverified. Starlark and native history compaction remain deferred.

This repo is the lab for a **Codex local bridge runner**: the same small local coding-agent loop developed in the
Claude playground (prompts, capability-grouped tools, permissions, safety, sessions, transcripts, archives, undo),
being ported to drive **OpenAI Codex models** through the Responses API.

```text
prompt -> Responses API (OpenAI) -> model response -> function_call -> local tool execution -> function_call_output -> repeat
```

## Reconciliation and cleanup — November 11, 2026

The original checkout combines published `bcc022c` with the preserved local host/ACP features. The 46 existing changed paths were backed up before this review. The unchanged checkout passed 677 offline tests; five new regression tests then exposed and verified repairs for terminal-stream redaction, redaction at chunk boundaries and across long private-key blocks, and inherited JavaScript object names being mistaken for priced models. The current suite passes 682 tests. `--stream` now displays redacted buffered chunks; unfinished lines and private-key blocks can delay display until they can be scrubbed together.

The November 3 reconciliation remains intact: fresh saved permissions across ACP clients, classified host errors, cancellable retries, numeric protocol errors, fragmented Unicode, safe session filenames, current-request context accounting, incomplete-response tool protection, and refusal to resume unanswered native tool calls. Inspect completed files and start a fresh session after interrupted tool history; no receipts are invented.

The [dated review and handoff](./docs/codex-cleanup-review-2026-11-11.html) separates current offline results from the recorded November 3 T3/mock and paid-backend experiments. This review made no live model request and did not start or reconfigure the normal host. Changes remain local, unstaged, uncommitted, and unpushed.

## Repository lanes (read this first)

| Lane                       | GitHub                                                                                            | Use for                                              |
| -------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| **This fork (Codex lane)** | [codex-local-bridge-playground](https://github.com/alankatanoisi/codex-local-bridge-playground)   | Native Responses runner: transport and PoC runs      |
| Claude playground          | [claude-local-bridge-playground](https://github.com/alankatanoisi/claude-local-bridge-playground) | Claude runner work; do not mix commits between lanes |

The two repos share ancestry (see the seed commit) but diverge on purpose. Fixes worth carrying across are logged in
[`PORTING.md`](./PORTING.md).

## Credentials & policy (read before any live call)

Upstream auth for this lane is a **ChatGPT Business programmatic access token** (`at-…`), created in the ChatGPT
dashboard under _Access tokens — create and manage access tokens for ChatGPT and Codex programmatic use cases_, and
supplied to the runner through **one environment variable only**: `CODEX_ACCESS_TOKEN`.

OpenAI's dashboard documentation describes these tokens as intended for:

> - codex exec jobs that run from trusted automation.
> - Local scripts that need repeatable, non-interactive Codex runs.
> - Enterprise workflows where usage should be associated with a ChatGPT workspace user instead of an API organization key.

This runner is being built as exactly that second case — a local script for repeatable, non-interactive Codex runs.
That said, this is still personal research: the quote above is the dashboard's own wording, not an OpenAI endorsement
of this specific project, and roadmap Phase 0 pins down the exact endpoints and permitted-use details before anything
ships. Treat the token like a password: never commit it, never print it, revoke it from the dashboard if it ever leaks.

Transport invariants for this repo:

- Upstream auth is `Authorization: Bearer <at-… token>` from the environment variable only.
- Never commit, print, or log the token; debug, trace, transcript, and log surfaces must redact `at-`, `sk-`, and
  `eyJ`-shaped strings.
- Native OpenAI Responses API only; no Anthropic credentials, routes, or fallbacks in this repo.
- No scraped ChatGPT session tokens and no OAuth capture-and-replay paths.

## Current state vs the roadmap

The living plan is [docs/codex-bridge-runner-roadmap.html](./docs/codex-bridge-runner-roadmap.html) (Part 5):

- **Phase 0 — protocol & token spike:** done (2026-07-08, verified against a live streamed 200 response). Endpoint:
  `POST https://chatgpt.com/backend-api/codex/responses`, auth `Bearer $CODEX_ACCESS_TOKEN`, streaming-only backend,
  automatic caching, model `gpt-5.5`. Full contract in
  [docs/lab-notes/codex-protocol-notes.md](./docs/lab-notes/codex-protocol-notes.md); the redacted SSE fixture now
  lives at `test/runner/fixtures/codex/responses-stream-pong.sse`.
- **Phase 1 — create and seed the fork:** done (this repo). Seed commit records the source commit; prune removed the
  VS Code extension, Claude bridge transport, and Claude-specific lanes.
- **Phase 2 — transport (direct token client):** done (2026-07-09). `src/runner/codex-transport.js` is a direct
  streaming client for the Codex backend (token from `CODEX_ACCESS_TOKEN` only). Safety hardening landed first:
  `at-…` shapes redact everywhere, `CODEX_*` env vars are scrubbed from child shells, `~/.codex/` joined the deny
  matrix, and request boundaries hit the flight recorder with header names only. Offline: `npm test`
  (`test/runner/codex-transport.test.js`). Live: `npm run smoke:codex`.
- **Phase 3 — native Responses rewrite:** Stages 1–6 landed on `main`; Stage 7 live proof completed on 2026-10-17. The reopening compatibility update is documented in the handoff above.
  **Decision (2026-07-10):** internal conversation state is native Responses items (`message`, `function_call`,
  `function_call_output`, `reasoning`) — not Anthropic blocks with a translation layer. Landed: live SSE fixtures,
  `items.js` schema contract, native `model-client.js` over `codex-transport.js`, run-loop/pipeline boundary,
  schema-v2 persistence/observability (`provider: codex`), native golden scripts, an offline mock-SSE end-to-end
  loop (`test/runner/codex-offline-e2e.test.js`), and the Anthropic-shape fence (`test/runner/codex-fence.test.js` —
  no `/v1/messages`, no `cache_control`, no Anthropic request shapes on the active path). Original Phase 3 non-goals:
  local bridge (now implemented on default port `11448` in the reopening hosting slice), `ModelRuntime`, Claude-repo convergence; native compaction is a focused follow-up.
- **Reopening integration slice (2026-10-17):** ACP adapter and optional standalone host implemented; see the setup guide above. The older phase numbering remains historical.

### Pricing estimate boundary

The active `gpt-6.1-sol` row uses Standard reference rates checked on 2026-10-17: $2 input,
$0.10 cached input, and $10 output per million tokens, equivalent to 50 / 2.5 / 250 credits.
The USD figures are the published Enterprise reference, **not verified account billing**.
Above 272,000 input tokens in a single request, input/cache rates double and output rates multiply by 1.5.
The runner sums individual request estimates; several short turns do not trigger the long-context surcharge.
Unknown models show unknown cost and cannot start with a dollar budget.
A dollar budget stops at response boundaries and can exceed its threshold by one response; it is not a hard billing cap.
Sources: [credit rates](https://help.openai.com/en/articles/11481834-chatgpt-rate-card-business-enterpriseedu-credit-based-pricing)
and [Enterprise USD rates](https://help.openai.com/en/articles/20001415-chatgpt-rate-card-enterprise-token-based-pricing).

`--max-tokens` now limits each response at the backend, including reasoning tokens. The request is also capped
by the remaining run-wide output allowance. An incomplete response preserves usage and any partial answer,
but its proposed tool calls are not executed or saved into resumable conversation history.

## What's in the box (inherited from the Claude playground)

- `bin/local-bridge-runner.js` — runner CLI entrypoint (name kept for now; renaming is a later cleanup).
- `src/runner/**` — agent loop, capability-grouped tools (read / session / clarification / orchestration / worktree /
  skills / write / recovery / shell), permissions, safety (path confinement, deny matrix, secret redaction), sessions,
  transcripts, archive, undo manifests, golden-eval harness.
- `test/runner/**` — the runner test suite (runs fully offline; golden evals replay canned model scripts through a
  fake client, no live credentials needed).
- `docs/` — runner quickstart, command builder, threat model (still Claude-flavored until Phase 5), and the roadmap.

## Development

```bash
npm install
npm test           # node:test suite (offline)
npm run lint
npm run format:check
npm run runner:eval  # golden-transcript evals (offline, fake client)
```

Safety defaults carried over from the Claude playground and kept: shell hidden unless `--allow-shell`; write tools ask
unless `--accept-edits`; `.env`, key files, `.ssh`, `.aws`, and path escapes blocked; tool output and logs redact
secrets.
