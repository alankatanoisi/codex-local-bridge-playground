# Bounded Codex runner evaluation — 2026-10-18

Untouched baseline: **635 tests passed; lint and formatting passed.** Seven live attempts all reached runner success. Five passed every strict fixture assertion; two writing cases passed their behavior checks but failed the strict no-extra-files check because of runner bookkeeping. Ten deterministic mock probes include two intentionally retained strict failures. No runner fixes were made.

## Scope, provenance, and boundaries

Evaluation folder: /Users/alanman/Developer/codex-evaluation-2026-10-18. Source: its isolated source/ snapshot, with no Git branch. Manifest base: 21af777f802fbc05832ce117ef5c7ce39e9580ff. Manifest SHA-256: e1470d9e9be906cfe56b54bde63b36f82f6736f863c7092992d114115f7ba8e1. The session initially opened in the Claude playground; all evaluation work was explicitly directed to the Codex snapshot. Report publication target: codex-local-bridge-playground, main. The snapshot is never initialized as a repository.

Existing repositories were not test fixtures. All model edit targets lived under private-evaluation-v2/ inside this evaluation folder. Source files were not fixed. Starlark and additional T3 features remained deferred. No parallel live campaigns or agents were used.

## Baseline evidence

Initial supplied integrity checker: PASS, 274 files, exit 0 (before installation).
Subsequent strict checker: FAIL, exit 1; four Finder .DS_Store additions.
All 274 manifest-listed files still match; no runner fixes were made.

integrity: exit 1, 0.136s
install: exit 0, 1.116s
test: exit 0, 4.724s
lint: exit 0, 2.333s
format: exit 0, 1.800s

npm test: 635 pass, 0 fail, 0 skipped, 0 todo.
Complete local logs are retained in results/private-logs; excluded from the return archive.
SECURITY.md absent from incoming snapshot.

## Protocol and budget

Live configuration: gpt-6.1-sol, low effort, 4,000 maximum output tokens per request, eight maximum model steps, 32,000 output tokens per run, bare startup, isolated .state.json checkpoints, archives disabled, and injected explicit approvals. Each run used a $2 reference-cost guard and a 175-second runner wall-clock setting inside an external 180-second subprocess timeout. Seven live attempts used 45.343 seconds of summed external attempt duration, comfortably inside the 30-minute campaign ceiling. No timeout occurred. The live series spanned under five minutes including local inspection between outputs.

Observed live usage: 10,642 input tokens; 649 output tokens; 0 cached-input tokens; 0 reported reasoning tokens. Total reference estimate: **$0.027774** from the incoming source table. Actual account charges and dashboard billing were unavailable. This estimate is not an invoice, and the configured guard is based on reference prices. No additional paid calls were made after this bounded batch.

## Attempt measurements

Elapsed time below includes starting and ending the worker process. Model calls count request notifications. Tool requests include cancelled announcements, not only executed effects. “Strict fail” preserves an assertion that did not pass, even where the model task succeeded.

| Attempt | Evidence | Elapsed s | Model calls | Tool requests | Stop reason | Strict verdict |
| --- | --- | ---: | ---: | ---: | --- | --- |
| mock-deny-write | mock | 0.217 | 2 | 1 | success | Pass |
| mock-cancel-stream | mock | 0.107 | 1 | 0 | cancelled | Pass |
| mock-cancel-tools | mock | 0.099 | 1 | 2 | cancelled | Fail |
| mock-tool-failure | mock | 0.076 | 2 | 1 | success | Pass |
| mock-incomplete-tool | mock | 0.072 | 1 | 0 | max_output_tokens | Pass |
| mock-small-output | mock | 0.077 | 1 | 0 | max_output_tokens | Pass |
| mock-context | mock | 0.078 | 4 | 4 | semantic_cycle_detected | Fail |
| mock-retry-400 | mock | 0.072 | 3 | 0 | bridge_error | Pass |
| live-smoke | live | 2.141 | 1 | 0 | success | Pass |
| live-read | live | 5.543 | 2 | 3 | success | Pass |
| live-edit | live | 10.315 | 3 | 2 | success | Fail |
| mock-context-diverse | mock | 0.107 | 5 | 4 | success | Pass |
| live-repair | live | 12.681 | 6 | 5 | success | Fail |
| live-remember | live | 2.770 | 1 | 0 | success | Pass |
| live-recall | live | 3.335 | 1 | 0 | success | Pass |
| live-read-repeat | live | 8.558 | 2 | 3 | success | Pass |
| mock-context-budget | mock | 0.117 | 4 | 3 | context_budget_exceeded | Pass |

## Independent task outcomes

Read and repeat: correct known answer and all hashes unchanged. Edit and repair: independent Node tests passed; target.js was the only changed existing file; test.cjs and unrelated.txt were unchanged. Each writing task added a backup and a run manifest. Repair also demonstrated an initial failing test (exit 1), followed by an independently verified pass (exit 0). These tasks remain strict failures under the original “only target changed” check.

Restart: the first process saved a randomized harmless fact; a fresh worker loaded the same checkpoint and recalled the fact from a question that did not contain the answer. Both checkpoint assertions passed. The returned data includes only checkpoint structure and answer-check outcomes, not live transcript text.

## Prioritized findings and proposed fixes

### P1 · observed design limitation — Native history compaction is bypassed.

run.js:988-995 explicitly leaves native Responses history unchanged. The bounded context probes observed growth, not a full context-window test. Proposed next work: implement and independently test native compaction before long campaigns.

### P1 · observed guard behavior — Context accounting conflates cumulative usage with current context.

run.js:1211 uses total input plus output across calls. mock-context-budget stopped on request four at 10,080 cumulative tokens while that request carried only a small history. Proposed fix: keep spend counters separate from current-request context accounting.

### P2 · observed retry behavior — Permanent HTTP 400 failures are retried immediately.

mock-retry-400 sent the same invalid request three times in about 8 ms between first and last request notifications. run.js:1116-1125 retries broad transport errors without classification or delay. Proposed fix: fail permanent errors immediately; bound and delay transient retries.

### P2 · observed API trap — Session filenames without .state.json collide with their ledger.

The first harness used session.json. session-ledger.js:19-21 returned that same filename, and subsequent loading rejected ledger JSON as an unsupported session. Eight setup failures are retained separately; no live calls occurred. Proposed fix: reject unsupported suffixes before file creation or derive ledger paths safely.

### P2 · observed event-contract gap — Cancellation still announces a later tool request.

mock-cancel-tools emitted a second tool_use and an error receipt after cancellation. tool-registry.js:190 blocked execution; b.txt was absent and a.txt survived. Proposed fix: distinguish requested/cancelled/executing events, or check cancellation before request announcements while preserving paired receipts.

### P3 · observed fixture side effect — Edits create backup and manifest files inside the disposable project.

live-edit and live-repair changed target.js and added .bridge-runner bookkeeping. Both passed the independent test and preserved all existing unrelated files. Strict only-target-changed remained false. Proposed evaluation improvement: specify allowed bookkeeping separately; do not hide the original assertion.

## Context probe: bytes versus usage

Input bytes count serialized native history only; request bytes include instructions and tool definitions. Usage is a server-reported token count summed across requests. Bytes and tokens are different units, and cumulative billed processing is different from current context occupancy. Synthetic usage was deliberately controlled to expose that distinction.

| Probe | Request | Input items | Input bytes | Request bytes | Reported input tokens this response |
| --- | ---: | ---: | ---: | ---: | ---: |
| mock-context-diverse | 1 | 1 | 109 | 1917 | 1000 |
| mock-context-diverse | 2 | 3 | 391 | 2199 | 2000 |
| mock-context-diverse | 3 | 5 | 773 | 2581 | 3000 |
| mock-context-diverse | 4 | 7 | 1255 | 3063 | 4000 |
| mock-context-diverse | 5 | 9 | 1837 | 3645 | 5000 |
| mock-context-budget | 1 | 1 | 109 | 1917 | 1000 |
| mock-context-budget | 2 | 3 | 391 | 2199 | 2000 |
| mock-context-budget | 3 | 5 | 773 | 2581 | 3000 |
| mock-context-budget | 4 | 7 | 1255 | 3063 | 4000 |

## Broad takeaways and recommendations

1. Integrity succeeded on all 274 incoming files before dependency installation; this is the anchor for an untouched baseline.

2. The later strict checker failure is explained by Finder metadata additions, not changed runner source. Dependencies also make that whole-tree checker unsuitable after npm ci.

3. The complete automated baseline matched the prior count: 635 passing tests, zero failures, zero skipped tests, zero todo tests.

4. Lint passed; this checks the configured JavaScript rules and does not establish live model quality.

5. Formatting passed; no source reformatting was needed to obtain that result.

6. The snapshot has no Git branch or history. Its manifest base identifies provenance, but includes incoming uncommitted source state as described by the handoff.

7. The selected machine ran Node 22.22.3, satisfying the supplied Node 22 minimum; machine details are in environment.json without username or serial number.

8. The local host reported status ok with zero active requests before the batch. Host health alone was not counted as model readiness.

9. The tiny exact-response request returned EVAL_READY, proving this host/token/model path worked for that request.

10. The harness never read the upstream credential; clientEnvironment supplied only the local host connection in process memory.

11. The read task produced the known product 27 and color amber; every fixture byte remained unchanged.

12. The repeated read task independently met the same answer and unchanged-file checks.

13. The two read samples took 5.543 and 8.558 seconds including process startup. Two samples cannot establish typical latency or a percentile.

14. The narrow edit changed the exported multiplier from two to three and passed an independent Node assertion test.

15. All existing unrelated files survived both writing tasks byte-for-byte, including the test; generated bookkeeping explains their strict assertion failures.

16. The repair fixture failed before the model ran and passed afterward; this rules out a meaningless initially-green repair task.

17. The repair model actually requested node test.cjs before and after its edit; exact commands and receipts are recorded in measurements.

18. Shell was enabled only for the repair experiment. The injected approval allowed only the exact test command and write_file on target.js.

19. The shell tool itself is not an operating-system sandbox; this evaluation used a disposable project and narrow approval rather than treating cwd as command confinement.

20. A randomized harmless label survived an actual process restart and was recalled without being repeated in the second prompt.

21. The resumed checkpoint used schema version 2 and provider codex. Checkpoint item counts are returned, while live session contents stay private.

22. The denied-write mock returned success at the conversation level even though the write was denied. Final stop reason alone is insufficient; check filesystem outcomes and approval records.

23. Cancellation during an active mock stream returned cancelled and started no tools; this is deterministic local evidence, not live network race coverage.

24. Cancellation between two writes preserved the completed first write and blocked the second mutation.

25. The later tool_use announcement after cancellation fails the strict observer expectation, despite the execution guard protecting the file.

26. A missing-file tool error was reported and the loop continued to the next mock response; this proves control-flow recovery, not a live model repair strategy.

27. Incomplete function arguments did not execute a write and were not stored as completed function calls.

28. The small-output mock preserved partial text and reported max_output_tokens rather than success. Synthetic usage intentionally need not obey the requested limit; this tests runner interpretation, not upstream enforcement.

29. The original context probe repeated the same call and triggered semantic_cycle_detected after four requests. Preserve this outcome as evidence of the loop guard.

30. The diverse context probe completed five requests, separating growing serialized input from cumulative usage without filling a real context window.

31. Native compaction remains unimplemented in this path; inherited compaction tests are not evidence that native Responses history can be compressed safely.

32. The cumulative context guard can stop a sequence of individually small requests. Use it as cumulative protection until current-context measurement is separated.

33. The HTTP 400 probe showed three immediate retries of unchanged invalid input. Permanent/transient classification should precede a longer evaluation.

34. The session filename suffix is a real integration requirement that deserves input validation and a regression test; the harness correction did not modify the runner.

35. All observed live cached-token and reasoning-token counters were zero; this does not establish that caching or reasoning is absent in other workloads.

36. Live timings separate overall process duration, observer-bounded model calls, tool request-to-result duration, and injected approval delay. Tool duration includes any approval wait.

37. First-token latency and live wire request bytes are unavailable in this harness. A completed assistant event must not be presented as first-token timing.

38. The total reference estimate is about 2.78 cents, far below the $25 authorization under the snapshot pricing table. Actual billed dollars were not observable or independently verified.

39. Seven live attempts stayed below the ten-attempt ceiling. Only the successful read case was repeated; strict side-effect failures made the edit ineligible for an automatic repeat.

40. This is a small functional evaluation, not evidence about large repositories, long sessions, high effort, network recovery, sleep/wake behavior, Starlark, or additional T3 features.

## Measurement definitions and limitations

Model duration runs from the model_request observer event to the corresponding completed/partial assistant event; it includes local transport and parsing. Tool duration runs from tool_use to tool_result and may include approval or a cancellation rejection. Approval delay measures only the injected callback, not human reaction time. Full elapsed time is measured independently by the parent. HTTP-error calls have no assistant completion, so their individual model duration is unavailable; request and error event timestamps remain available. First-token latency is unavailable. No timing here is a population estimate.

Live wire request sizes were not instrumented; mock HTTP request sizes were measured directly. Cached-input and reasoning counters are recorded as reported. Mock usage/cost values are synthetic and are excluded from live spend. The output-limit and cancellation probes used deterministic local responses; they do not establish live backend enforcement or live cancellation races. Full-window context, network retry backoff recovery, multiple model/effort settings, and adversarial shell isolation were not tested.

## Harness setup evidence and corrections

The first log-directory creation targeted source/results while the logging script expected the parent results directory. That invocation failed before dependency installation or baseline execution; the empty directories were removed and the corrected invocation ran all baseline checks. The initial integrity checker had already passed. A later strict integrity check found Finder .DS_Store additions, and a manifest-only comparison confirmed every packaged file remained unchanged. The baseline script should have gated installation on each repeated integrity failure; it did not. Installation and testing proceeded after that explained metadata-only divergence; this procedural limitation is retained explicitly.

The initial eight mock harness attempts failed before model requests because the session path lacked the required .state.json suffix. Their original failure summaries are retained in harness-setup-failures.json. After correcting the harness path, the same runner source was measured again. The original context/cancellation strict failures also remain in results.json. No failed runner outcome was repaired and relabeled as the incoming baseline.

## Reproduction and returned files

In Terminal on macOS, open it through Spotlight: press Command-Space, type Terminal, and press Return. Start with the folder command below. The first command changes Terminal to this authorized evaluation folder; it does not modify files. The mock command needs no live credential. Use a fresh extracted evaluation folder containing source/ and these results/ files, with no existing private-evaluation-v2 directory. Existing fixture directories cause a safe FileExistsError instead of being overwritten.

```bash
# Enter the authorized isolated evaluation folder.
cd /Users/alanman/Developer/codex-evaluation-2026-10-18
# On a fresh incoming snapshot only, verify before installing dependencies.
python3 verify.py
# Run the deterministic local probes; success prints one JSON summary per case.
python3 results/harness/evaluate.py mock
```

The original verify.py compares every source file, so it will fail after dependency installation or Finder metadata additions. That is expected on this already-used folder; do not remove evidence to force it green. The source snapshot and original handoff must accompany a fresh reproduction; the return archive intentionally does not duplicate source or dependencies. Offline probes exercise the actual runner and local HTTP transport.

For a newly authorized live reproduction only, start the supplied host in a Terminal that has the local credential, then run python3 results/harness/evaluate.py live from the evaluation folder. Never paste credentials into chat or command arguments. The live harness refuses a second paid batch if results.json already contains live rows. A host-not-ready error means the host should be checked in the same local state directory. A schema error with a custom session filename means it must end in .state.json.

Returned: REPORT.md and standalone REPORT.html; results.json and results.csv; environment.json; baseline-checks.txt and baseline-checks.json; harness source; fixture definitions; preserved scrubbed setup failures; post-integrity.json; and SHA256SUMS for the archive contents. Complete baseline logs remain local under results/private-logs. Raw live sessions and ledger payloads remain local under private-evaluation*/ and are excluded. The archive excludes source, node_modules, host state, credentials, and live transcripts.

## Handoff and next experiment

Folder: isolated evaluation snapshot; branch: none. Publication: Codex repository main, reports only. Files created: results/ and private evaluation fixtures/state; no manifest-listed source changes. Checks: initial integrity, dependency installation, 635 tests, lint, format, independent fixture assertions, ten offline probes, seven live attempts, report/data consistency checks, and archive checksum verification. Skipped checks: large-project coding, long context, live output exhaustion/cancellation races, actual invoice verification, Starlark, and additional T3 features, all outside this batch or deferred.

Next recommended decision: review the context-accounting, retry-classification, session-filename, and cancellation-event findings before authorizing fixes. Preserve this baseline and compare any later changes against the same fixtures. Do not expand the live campaign automatically. The user-started host remains under user control and was not stopped by this evaluation.
