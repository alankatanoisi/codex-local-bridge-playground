> **Status:** Archived proposal (superseded 2026-07-10). Ideas retained in the roadmap (compaction invariants, fail-closed
> args, behavioral convergence framing). **Discarded for Phase 3:** `:11438` local bridge, `ModelRuntime` injection,
> Claude-repo convergence in this phase. See [`docs/codex-bridge-runner-roadmap.html`](../../codex-bridge-runner-roadmap.html).

# Native Convergence Roadmap — Codex-First Architecture Reset

## Summary

Phases 0–2 remain useful: they established the real Codex protocol and built a tested upstream transport. The previous Phase 3 plan is superseded.

The target is now:

```text
Provider-neutral harness contract
tools · permissions · safety · budgets · hooks · events · evaluations
                 /                              \
Claude ModelRuntime                         Codex ModelRuntime
native Messages state                       native Responses state
Claude OAuth bridge                         Codex token bridge
```

Convergence means equal capabilities and behavioral outcomes—not shared provider schemas.

- Codex will never store Anthropic messages, `tool_use`, `tool_result`, thinking signatures, or `cache_control` as its native conversation state.
- Claude will not be forced into Responses items later.
- The Codex fork proves the neutral harness contract first. Claude adopts the stable contract in a later phase.
- A physically shared package or monorepo is deferred until both native implementations pass the same behavioral suite.

## Architecture and Interfaces

### Provider-neutral harness contract

Introduce a `ModelRuntime` interface owned by the harness:

- `nextTurn({userInput, toolResults, stream}) → ModelTurn`
- `snapshot() → ModelState`
- `restore(ModelState)`
- `estimateContext() → ContextEstimate`
- `compact(policy) → CompactionResult`
- `close()`

Neutral types:

- `ToolDefinition`: `{name, description, inputSchema}`
- `ToolCall`: `{callId, name, arguments}`
- `ToolResult`: `{callId, content, isError}`
- `ModelTurn`: `{responseId, text, toolCalls, usage, finishKind, streamed}`
- `Usage`: `{totalInputTokens, uncachedInputTokens, cachedInputTokens, cacheWriteTokens, outputTokens, reasoningTokens}`
- `ModelState`: versioned, provider-tagged opaque state owned only by its runtime

The kernel and tool pipeline must not inspect provider conversation objects. Structured events become provider-neutral—`tool_call`, `tool_result`, and `model_transport_error` replace Anthropic/bridge-specific names.

### Codex-native runtime

The Codex runtime owns an ordered native Responses history:

- User messages use `input_text`.
- Model tool requests remain `function_call` items.
- Tool results remain `function_call_output` items.
- Reasoning items retain their IDs, summaries, encrypted content, status, and ordering.
- Requests use `store:false`, `stream:true`, and `include:["reasoning.encrypted_content"]`.
- The runtime preserves and replays complete native output items instead of reconstructing them through Claude-shaped blocks, as required for stateless reasoning. [OpenAI reasoning guidance](https://developers.openai.com/api/docs/guides/reasoning)
- Function arguments are parsed fail-closed; malformed JSON never becomes an executable empty object. [OpenAI function-calling guidance](https://developers.openai.com/api/docs/guides/function-calling)
- Automatic OpenAI caching is used without Anthropic cache markers.

Native compaction operates on Responses items:

- Clip old `function_call_output` strings without changing call IDs.
- Remove old prefixes only at completed turn boundaries.
- Never orphan a reasoning item from its associated message or function call.
- Preserve the most recent six turns exactly.
- Replace compacted prefixes with a native user summary item containing recovery guidance.

### Native Codex local bridge

Add a standalone local service:

```text
POST http://127.0.0.1:11438/v1/responses
GET  http://127.0.0.1:11438/health
```

Behavior:

- Bind only to `127.0.0.1`.
- Accept native Responses requests and stream native Responses SSE; expose no Messages, Chat Completions, or model-list compatibility endpoints.
- Reuse Phase 2’s `codex-transport.js` as the bridge’s upstream client.
- Read `CODEX_ACCESS_TOKEN` only inside the bridge process; never accept or forward an upstream credential from the runner.
- Require a separate local caller token in `x-codex-bridge-token`. Generate it under `~/.codex-local-bridge/caller-token` with owner-only permissions; the runner loads it automatically.
- Strip incoming authorization headers, reject browser-origin requests, scrub errors, and record only header names and structural request metadata.
- No Codex credential interception, keychain scraping, `auth.json` reading, or simulation of the Claude proxy interceptor.

The default runner endpoint becomes `http://127.0.0.1:11438/v1/responses`; `--bridge-url` and `CODEX_BRIDGE_URL` may override it. Remove command-line caller-token values so secrets cannot land in shell history.

## Revised Roadmap

### Phase 3A — Record the reset and neutral contract

- Remove `verify-done` and the generated `FOLDER-STRUCTURE.md`; leave ignored `.DS_Store` files untouched.
- Replace the roadmap’s translation architecture with this native-convergence design.
- Add the versioned neutral types and contract tests before changing the loop.
- Convert tool definitions from `input_schema` to neutral `inputSchema`.
- Add architectural lint tests that reject Anthropic wire vocabulary in active Codex runtime code.
- Bump transcript, archive, and session schemas to v2.

Exit: the neutral contract is documented and tested while all existing behavioral tests still pass through a temporary scripted runtime adapter.

### Phase 3B — Build the native Codex bridge

- Add the loopback server, caller-token management, health endpoint, request validation, streaming passthrough, redacted traces, and beginner-friendly startup errors.
- Move the live smoke test from direct transport usage to runner-client → local bridge → mock/real upstream.
- Preserve direct transport tests as lower-level bridge tests.

Exit: an offline mock proves native SSE passthrough and credential separation; a live bridge smoke call proves the existing token path still works.

### Phase 3C — Refactor the harness seam

- Make `run.js` depend on an injected `ModelRuntime`, not `model-client.js` or provider messages.
- Change the tool pipeline to consume neutral `ToolCall` and return neutral `ToolResult`.
- Replace Anthropic-shaped context builders with neutral user input and instruction builders.
- Make session state store `model_state`; transcripts and archives remain provider-neutral audit surfaces.
- Make session state—not transcript reconstruction—the authoritative resume mechanism.
- Reject inherited v1/Anthropic sessions clearly and leave their files untouched.
- Replace `BRIDGE_ERROR` and `tool_use` event vocabulary with neutral equivalents, with a documented schema-version break.

Exit: scripted neutral-runtime golden cases pass for read, plan, write denial, budget stop, compaction, and final-answer behavior.

### Phase 3D — Implement the native Responses runtime

- Compose native Responses requests directly from neutral instructions, tool definitions, new user input, and prior native Responses items.
- Assemble ordered output from SSE item events; do not rely on the backend’s final `response.output`, which is empty in the existing capture.
- Preserve native reasoning and function-call items exactly across turns and session snapshots.
- Implement native context estimation and compaction.
- Map usage without double-counting cached tokens.
- Report Codex credits using the official GPT-5.5 rate card—125 input, 12.5 cached-input, and 750 output credits per million—and add `--max-credits`. Unknown model rates remain unavailable rather than falling back to Claude prices. [Official Codex rate card](https://help.openai.com/en/articles/20001106-codex-rate-card-2)
- Change runner/coordinator defaults and effort validation to the pinned GPT-5.5 contract.

Exit: the real Codex runtime completes a two-turn function-call loop through the mock local bridge with no Anthropic message shapes anywhere in the active path.

### Phase 3E — Integration and roadmap truth

- Add a redacting live-capture helper for function-call, function-output, final-answer, and reasoning SSE fixtures.
- Run the safe capture against the native bridge; refuse to commit fixtures if token or account identifiers remain.
- Update README, protocol notes, threat model, and roadmap with verified behavior and check results.
- Replace the stale Claude-repository roadmap copy with an archived pointer in a separate Claude-repository commit.

Exit: Phase 3 is marked complete only after the native bridge, native runtime, neutral kernel, session resume, and behavioral suite all pass.

### Phase 4 — Live Codex capability ladder

Run, in order:

1. Read-only task
2. Plan mode
3. Confirmed edit
4. Auto-approved edit
5. Shell opt-in
6. Session resume
7. Compaction
8. Subagent/worktree behavior
9. Streaming and machine-readable output

Exit: a throwaway calculator-fix task completes through the native bridge, including tests, archive, session resume, and usage-credit reporting.

### Phase 5 — Codex hardening

- Multimodal Responses inputs
- Retry/rate-limit policy
- Bridge lifecycle and optional LaunchAgent
- Native quickstart and command builder
- Expanded threat model and redaction review
- Known-gap inventory

### Phase 6 — Claude convergence

- Port the proven neutral `ModelRuntime` contract, neutral tool schemas, kernel events, and behavioral suite to the Claude repository.
- Implement a Claude-native runtime that retains Messages, Claude reasoning, cache controls, and the existing OAuth bridge.
- Compare capabilities through shared behavioral cases, not serialized provider payloads.
- Keep provider-specific fixtures and protocol tests separate.

### Phase 7 — Optional shared-core extraction

Only after both native runtimes pass the parity suite, evaluate extracting the neutral harness into a shared package or monorepo. Do not perform this topology change during the Codex-first proof.

## Test Plan

- Contract tests for every neutral type, runtime method, schema version, and invalid provider-state restore.
- Bridge tests for loopback binding, mandatory caller auth, upstream-token isolation, endpoint allowlisting, error scrubbing, and awkward SSE chunking.
- Codex runtime fixtures for text, function calls, function outputs, reasoning replay, cached usage, incomplete responses, malformed arguments, and empty terminal output arrays.
- Kernel behavioral tests for permissions, plan mode, write safety, shell gating, budgets, loop detection, hooks, compaction, session snapshots, resume, archives, and redaction.
- Full mock chain: runner → native bridge → scripted upstream → function call → real local tool → function output → final answer.
- Architectural fence tests proving active Codex runtime source contains no `/v1/messages`, `tool_use`, `tool_result`, `thinking`, `signature`, `input_schema`, or `cache_control`.
- Final checks: `npm test`, `npm run runner:eval`, `npm run lint`, and `npm run format:check`.

## Assumptions

- Confirmed architecture: provider-neutral harness, native Claude and Codex runtimes, and a native Codex local bridge.
- Confirmed rollout: Codex first, then mirror the stable contract into Claude.
- Phase 2 is retained as upstream bridge plumbing, not discarded.
- Port `11438` is the default Codex bridge port; Claude remains on `11437`.
- GPT-5.5 remains pinned to the captured protocol during this roadmap phase.
- The Codex bridge provides the security outcomes of credential isolation, tracing, and controlled local access without reproducing Claude’s interception mechanism.
- The earlier translation-based Phase 3 proposal is fully superseded.
