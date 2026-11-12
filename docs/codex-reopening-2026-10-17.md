# Codex playground reopening — implementation handoff

> Historical compatibility-slice handoff, dated October 17. The ACP adapter and standalone host were implemented afterward. Use the [hosting guide](./codex-acp-hosting.html) for current setup and the [November 11 review](./codex-cleanup-review-2026-11-11.html) for current offline results. The pending items and test counts below describe this earlier checkpoint.

Date: 2026-10-17. Folder: `/Users/alanman/Developer/codex-local-bridge-playground`. Branch: `main`.
Changes are local and uncommitted. Starlark remains deferred.

## What is implemented

- Shared default model `gpt-6.1-sol`; explicit reasoning controls `low`, `medium`, `high`, `xhigh`, `max`. The runner no longer silently changes max into high.
- Per-response output limits, including reasoning. The actual request uses the smaller of the configured limit and remaining run-wide output allowance. Invalid limits fail before a request.
- Incomplete responses keep usage and partial text, stop clearly, and cannot execute or persist proposed tool calls. Streams without a terminal response are errors.
- Model-specific accounting: cached input is counted once; each request is priced individually. Unknown prices are reported as unknown and block dollar-budget runs before network access.
- Optional structured progress observer, injected approval handler, and AbortSignal cancellation. The normal command-line event sequence remains compatible.
- Command builder uses the Codex checkout/model, includes xhigh, explains output limits, and no longer generates or saves a caller-token field. Credentials come from the launching process environment.

## Interface integration points

These are JavaScript options to `run(options)` in `src/runner/run.js`, intended for a future interface adapter:

- `onEvent(event)`: receives a redacted copy of structured progress, tool results, and final `run_end`. Observer failures cannot alter the runner result. This is event progress, not a token-by-token text streaming interface.
- `confirm: { ask(action, timeoutMs, metadata) }`: return or resolve the exact string `allow` to permit the action. Other values, errors, expiry, and cancellation deny it. Metadata contains tool identity/input and the cancellation signal. Normal permission denials still apply before approval.
- `signal`: pass an AbortController's signal. Aborting cancels an active model connection or pending approval and prevents later tool starts. Already completed writes remain; an already executing local tool may finish. Cancellation is not rollback or guaranteed shell termination.
- `outputFormat: 'silent'`: suppresses normal stdout output for an embedding program. Combine with quiet mode. Some inherited failure paths still use stderr or process exit status, so a separate runner process is the recommended first adapter boundary.

The ACP (Agent Client Protocol) adapter, T3 provider configuration, token streaming UI, and interface handling for structured user questions are still follow-ups. A standalone hosting/bridge package is not implemented by this slice. The native runner already calls the Codex backend directly.

## Evidence and accounting limits

Earlier live reconnaissance in this chat established working model calls, real tool execution, same-process and fresh-process session resume, and enforcement of a 16-token output limit. Low, medium, and high effort succeeded live; xhigh and max are validated against documented model controls and offline request tests, not newly benchmarked here.

The implementation checks use a local HTTP model substitute and real runner/tool code. No additional live requests or spending were incurred for this implementation. Earlier reconnaissance was approximately $0.296 in reference estimates; this is not an account invoice, and one tiny accepted probe did not retain usage.

For gpt-6.1-sol, the Standard reference is $2 input / $0.10 cached input / $10 output per million tokens, or 50 / 2.5 / 250 credits. Above 272,000 input tokens in one request, input/cache rates double and output rates multiply by 1.5. The USD figures are Enterprise reference rates, not verified billing for Alan's account. Cost stopping occurs after a response and can exceed the threshold by that response. Cancellation before final usage may leave unmetered upstream work.

Sources checked 2026-10-17:

- [Model controls](https://developers.openai.com/api/docs/models/gpt-6.1-sol)
- [Credit rate card](https://help.openai.com/en/articles/11481834-chatgpt-rate-card-business-enterpriseedu-credit-based-pricing)
- [Enterprise USD reference](https://help.openai.com/en/articles/20001415-chatgpt-rate-card-enterprise-token-based-pricing)

## Files and verification

Runtime: model-controls, model-client, codex-transport, model-pricing, hosted-ports, run, confirmation, tool-pipeline, tool-registry, human-log, and kernel contract under `src/runner/`. CLI and capture/smoke defaults are updated too.

Tests: new `test/runner/codex-reopening.test.js` plus transport, model-client, pricing, and command-builder drift coverage. They check real request bodies, incomplete tool rejection, usage, silent stdout, observer isolation, approval, cancellation, paired saved tool receipts, and budgets.

Full offline suite: 620 tests passed, zero failures. Lint and format checks passed; all three recorded runner scenarios passed. The command builder embedded JavaScript parses, CLI help shows the updated controls, and git diff --check is clean. Browser interaction was not manually exercised. No live test was repeated after the account change. There is no `check:docs` script in this fork. Actual T3 UI verification awaits an ACP adapter.

## Next work

Build a small ACP adapter around the existing runner hooks, with explicit session creation/loading, serialized prompts per session, permission requests, and cancellation. Keep Responses conversation history inside the runner. Add adapter protocol tests before configuring T3. Preserve the model transport's current single-connection limit until concurrency is deliberately measured. Keep Starlark deferred.
