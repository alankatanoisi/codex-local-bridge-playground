# Phase 3 (Native-First) — Codex-DNA Rewrite Plan

## Context

Phases 0–2 are done (fork `main` = `b3fffcf`). Alan reviewed the GLM boundary-translation plan and made the
governing architecture decision: **native-first**. The fork is its own species: internals speak native OpenAI
Responses **items**, not Anthropic content blocks with a translation layer. What converges between the two
runners is the *behavioral* layer — kernel contract (stop reasons, events, budgets), capability-grouped tools,
permissions, safety/redaction, sessions/observability, CLI — not the message schema. This supersedes the GLM
plan's Steps 2–3; its verified findings (seam facts, junk files, DEFAULT_MODEL gap, multimodal tool results,
effort-value mismatch) carry into this plan where still applicable.

Prior decisions that stand: reference-API-rate pricing for `gpt-5.5` (labeled as reference; plan billing is
subscription); fixture capture via a helper script; all work on feature branch `codex/phase-3-responses-native`
with a draft PR. Honest scope: ~8–12 sessions (vs 3–4 for translation) — accepted trade for a clean species.

## Native representation (the new lingua franca)

- Conversation state = a list of Responses **input items**: `message` (role + `input_text`/`output_text`
  parts), `function_call` (call_id, name, arguments-as-JSON-string), `function_call_output` (call_id, output
  string), `reasoning` (opaque, preserved verbatim). Assistant turns append the response's output items
  directly to the item list — the native stateless pattern (simpler than Anthropic role alternation).
- System prompt → `instructions` string (context-builder blocks flattened).
- Tool definitions → native `{ type:'function', name, description, parameters }` **in the tool files
  themselves** (mechanical `input_schema`→`parameters` rename across the 24 tools + catalog/registry/tests).
- Usage → native-flavored internal struct `{ input_tokens, output_tokens, cached_tokens, reasoning_tokens }`
  (no cache-write concept); consumers (budget-tracker, model-pricing, human-log, archive, kernel contract)
  updated in one workstream.
- Known convergence gaps handled natively, not faked: `function_call_output` has no `is_error` flag → error
  results get a structured error prefix in `output` (documented); no image/document payloads on tool outputs →
  placeholder note, revisit at Phase 5's `input_image` item; old (pre-native) session files can't resume →
  documented as unsupported in the PoC fork.

## Execution stages (each lands green on the branch)

- **Stage 0 — branch + cleanup + capture tooling.** Branch off `main`; `git rm verify-done
  FOLDER-STRUCTURE.md`; `npm run format` to clear drift. Add `scripts/capture-codex-fixture.js` (reuses
  `codex-transport.js`; auto-redacts safety_identifier / prompt_cache_key / token shapes; built-in leak-grep).
- **Stage 1 — fixtures (Alan, capture machine; gates reasoning + param questions).** Capture
  `responses-stream-list-files.sse` (function_call turn, tools array + `include:
  ["reasoning.encrypted_content"]`) and `responses-stream-final-answer.sse` (post-function_call_output turn).
  Same probes settle: does the backend emit reasoning items (→ preserve verbatim) or not (→ document gap);
  accepted `reasoning.effort` values (runner `max` needs a mapping — no native `max`); whether `temperature`
  is accepted (drop if rejected). Rotate the token afterward if it touched a terminal.
- **Stage 2 — item schema module.** New `src/runner/items.js`: constructors, extractors (`extractText`,
  `extractFunctionCalls`), type guards — unit-tested first; this is the contract every later stage codes to.
- **Stage 3 — native model-client.** `model-client.js` rewritten over
  `codex-transport.requestStream/requestBuffered`: builds native request (`instructions`, `input` items,
  native tools, `reasoning.effort`, `store:false`, `stream:true`, no `max_output_tokens`), maps the pinned SSE
  grammar (incl. `function_call_arguments.delta` buffering, tolerate `obfuscation`), returns native output
  items + usage. No Anthropic shapes anywhere. `_transport` meta replaces `_localBridge` (run.js trace
  consumer at ~1047 updated in Stage 4).
- **Stage 4 — the loop.** `run.js`: history as item list; native extraction; delete cache_control budgeting
  (~85 lines) and the Anthropic cache-hit log; usage struct swap; `DEFAULT_MODEL` → `gpt-5.5` (bin:20).
- **Stage 5 — pipeline + compactor.** `tool-pipeline.js` emits `function_call_output` items
  (call_id-keyed; error-prefix convention; multimodal degradation via `tool-result-content.js`).
  `context-compactor.js` ladder walks item lists.
- **Stage 6 — observability.** Transcript/archive turn-schema, human-log, output-format events, session
  store/ledger record native items (`provider: codex`, reasoning_tokens included); their tests updated.
- **Stage 7 — golden harness + cases.** `golden-eval.js` scripts become native output-item scripts; the 2
  existing golden cases rewritten and expect-blocks regenerated (reviewed diff = the regression approval).
- **Stage 8 — proof.** `test/runner/codex-model-client.test.js` (fixture-driven both directions) +
  `test/runner/codex-e2e-loop.test.js` (mock SSE server branching on function_call_output; real `run()`;
  asserts stopReason success, steps 2, tool_use→tool_result→text event order, native-shaped request).
- **Stage 9 — pricing + docs + PR.** `gpt-5.5` reference rates (cache_write 0, labeled reference-only in the
  usage line + README); roadmap Parts 2/5 rewritten for the native-first decision (record it as a formal
  decision like Option C), stale next-steps checklist refreshed, protocol notes extended with observed
  function_call/reasoning grammar, README phase status; PR ready for Alan's review + merge.

## Verification

- Per stage: full `npm test` + `npm run lint` + `npm run format:check` green before the next stage starts.
- End: `npm run runner:eval` green on the rewritten goldens; the e2e loop test passes offline.
- Live handshake (Alan or token-in-env session): `npm run smoke:codex`, then one read-only
  `node bin/local-bridge-runner.js --cwd <throwaway-lab> "list the files and summarize"` — the first true
  end-to-end native Codex agent run (Phase 3 → Phase 4 handshake).

## Risks & honesty notes

- Largest-scope change in the fork's life; mitigations: stage-by-stage green gates, feature branch + PR,
  fixtures pinned before coding, the untouched ~80% of the suite (tools/safety/permissions) as the outer net.
- The rewritten goldens are a new net guarding a new shape — Stage 8's e2e test is the independent proof.
- Phase 6 cross-runner comparisons shift from transcript-level to rollup metrics (cost/steps/stop-reasons),
  since the two lanes now have different transcript schemas — acceptable and expected for two species.