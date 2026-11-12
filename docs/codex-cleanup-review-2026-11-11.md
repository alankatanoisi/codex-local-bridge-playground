# Codex cleanup review and handoff

November 11, 2026 · local repository review · offline verification only.

> **Ready for owner review.** The 46 existing changed paths were valuable implementation work. All 312 original source files match the November 3 handoff and were preserved before cleanup. The unchanged checkout passed 677 tests. Five added regression tests reproduced redaction and pricing defects; repairs bring the passing suite to 682. The work remains local, unstaged, uncommitted, and unpushed.

## Folder, branch, and scope

| Field | Verified state |
| --- | --- |
| Folder and repository root | `/Users/alanman/Developer/codex-local-bridge-playground` |
| Branch | `main` — the local line of development |
| Base commit | `bcc022c2e338abc99b27aad1b0393cfc14aa8b09` |
| GitHub remote | [alankatanoisi/codex-local-bridge-playground](https://github.com/alankatanoisi/codex-local-bridge-playground) |
| Remote comparison | Read-only `git ls-remote` returned the same commit for `main` during this review |
| Machine | `Mac15,13`, arm64, the primary Mac |
| Instructions | Repository `AGENTS.md` read; `SECURITY.md` is absent |
| Initial work | 28 modified tracked files and 18 new untracked files; nothing staged |
| Final work | 32 modified tracked files and 20 new untracked files; 52 paths total |
| Review changes | 14 original changed paths updated, four previously clean files modified, and two report files added; 32 original changed paths retained byte-for-byte |

“Untracked” means Git has not started recording that new file. It does not mean the file is disposable. The host, ACP adapter, packaging script, tests, and guides were retained. No file was deleted. No pull, reset, clean, commit, or push was performed.

This review owns only the Codex repository. It did not modify the Claude playground, shared Node installations, desktop applications, account settings, normal host configuration, credentials, or existing session data.

## What is implemented and preserved

| Area | Implemented behavior | Evidence and limit |
| --- | --- | --- |
| Native model history | Responses input items, tool proposals and receipts, opaque reasoning replay, session persistence | Existing native-history tests and recorded runner scenarios pass. Native history compaction is deferred. |
| Model controls | Shared default model, explicit reasoning effort, per-response output limit capped by remaining output allowance | Fake-backend request tests inspect the real request bodies. Current service behavior was not revalidated live. |
| Incomplete responses | Preserve usage and partial text; prevent incomplete tool proposals from executing or entering resumable history | Existing incomplete-response and interrupted-stream tests pass. |
| Retry contract | Host preserves validated status/delay/code; runner owns classified bounded retries | Direct/hosted integration and cancellation tests pass. No live retry experiment was run. |
| ACP interface | Text sessions, saved configuration, replay, supervised permission requests, cancellation, per-session locking | ACP means Agent Client Protocol, the message format between an editor and this runner. Real pipes and a child-process handshake are tested. |
| Permission freshness | Reload saved Ask/Plan/Code settings under the lock before prompting or configuring | Existing multiple-client regressions pass; a stale process cannot silently keep older Code permission. |
| Credential host | Loopback service, separate local caller authentication, upstream token held by the service, authenticated status/shutdown | Temporary fake-token host lifecycle and routing tests pass. No normal host was started. |
| Crash recovery | Preserve completed edits; refuse stale locks and native histories with unanswered tool calls | Seven external crash fixtures passed again. No automatic receipt invention, edit replay, or PID-based cleanup was added. |
| Packaging | Explicit npm file allowlist, no third-party runtime dependencies, packaged runner/host/ACP entrypoints | A 129-file archive was built, extracted, compared to source, and initialized without `node_modules`. Node itself is not bundled. |
| Documentation | Command builder, protocol notes, hosting guide, historical handoff and roadmap | Current signposts reconciled; older checkpoints remain labeled history. The archived package includes the hosting guide, while other linked research documents remain repository documentation. |

## Repairs made in this review

### Terminal display and streaming redaction

**Finding:** the model client printed text deltas directly to standard output, bypassing the redactor. Standard output is the text a Terminal displays or another program captures. A synthetic token split across events still appeared intact when those events were printed consecutively.

**Additional finding:** the shared streaming redactor cut text at a fixed character position before scrubbing it. That could cut a token into two pieces that neither redaction pass recognized. A private-key block longer than the retained window could also be exposed before its closing marker arrived.

**Repair:** the model client sends a separate display copy through the shared redactor. The redactor retains unfinished lines and whole private-key blocks, then applies the ordinary secret and identifier rules before display. Native model items remain intact internally. The help text and quickstart explain the display buffering.

**Verified:** new tests cover synthetic `at-`, `sk-`, and JWT-shaped values at delta sizes 1, 11, 2,048 and 4,103 characters; exact displayed output must match scrubbing the complete answer. Separate tests place a cut inside a token and stream a private-key-shaped block longer than 6,000 characters. All pass. These fixtures establish the tested cases; pattern matching does not recognize every possible secret.

**Behavior to expect:** short single-line answers may appear only after the response finishes. Long unfinished lines or private-key blocks can exceed the usual 4,096-character display window. That window controls delay, not memory. Existing caller output limits still apply.

Sources: [`model-client.js`](../src/runner/model-client.js), [`safety.js`](../src/runner/safety.js), and the three redaction regression tests in the inventory below.

### Unknown-model pricing and dollar budgets

**Finding:** looking up a model with an ordinary JavaScript object also found inherited built-in names such as `constructor`, `toString`, `__proto__`, and `hasOwnProperty`. Those values are functions or objects, not prices. They could produce an invalid numeric estimate and let an unknown model get past the pre-request dollar-budget check.

**Repair:** accept exact model rows only when the pricing table owns that entry. Existing explicit rows and legacy family matching are preserved. Unknown prices remain unknown.

**Verified:** unit tests cover all four names, and a real runner test verifies that `constructor` with a dollar budget stops as `pricing_unknown` with zero backend requests. No dollar-budget or invoice claim was tested against the live account.

Source: [`model-pricing.js`](../src/runner/model-pricing.js).

### Entry-point lint coverage

Lint is an automatic code check that catches suspicious or redundant code. The original `npm run lint` checked `src/` and `test/`, leaving `bin/` and `scripts/` outside its scope. The supplementary check found one error: duplicate `exposedTools` keys in the runner options. It also found an unused `ingestLegacyFile` import in the archive CLI.

Removed the repeated key and unused import; their removal preserves the effective option value and runtime behavior. Extended both lint scripts to include `bin/` and `scripts/`. The expanded check passes without warnings. Formatting coverage was kept as configured; syntax checks also cover all 36 changed JavaScript files.

### Current guides and historical evidence

- Replaced the retired `/Users/alanman/.hermes/node/bin/node` T3 command with `/Users/alanman/.local/bin/node`, the shared launcher. Its target may be updated by the separate Node maintenance chat.
- Corrected current README, roadmap, and hosting status so recorded November 3 T3/mock and paid-backend results are no longer described as entirely pending.
- Kept October test counts and setup history explicitly dated. Added current counts and links to this report.
- Rebuilt the hosting, reopening, and protocol-note HTML companions from their Markdown sources with readable tables, navigation, responsive layout, and embedded styling.
- Corrected two broken quickstart links to the existing Markdown threat model; that inherited document still needs its separately planned Codex-specific refresh.
- Kept the host, ACP, native history, cancellation, permission, and packaging features. No speculative feature or architecture rewrite was added.

## Checks, including the failures before repair

| Stage | Result | Meaning |
| --- | --- | --- |
| Initial targeted tests | 61 passed, 0 failed | Original hosting/ACP/reconciliation/reopening/session-health tests |
| Initial full suite | 677 passed, 0 failed, 0 skipped | The preserved checkout already passed its existing tests |
| Initial lint / formatting / whitespace / package dry run | Passed | Original configured checks were clean |
| Added regressions before repairs | 43 passed, **5 failed**, 48 total | One terminal-display case, two shared-stream redaction cases, one pricing lookup case, one runner budget case |
| Supplementary entry-point lint before cleanup | **1 error, 1 warning** | Duplicate runner key and unused archive import; excluded from original lint scope |
| Repaired full suite | **682 passed, 0 failed, 0 skipped** | Original 677 plus five added regression tests |
| Expanded lint / formatting / whitespace | Passed | Lint now includes entrypoints and scripts |
| Changed JavaScript syntax | 36 files passed | Parser checks include scripts and entrypoints |
| Recorded runner scenarios | 3 passed | Offline plan mode, read/list, and opaque reasoning replay scenarios |
| External crash scenarios | 7 passed | Owned fake-token fixtures only; copied harness and new observations saved separately from November 3 evidence |
| Standalone build and extraction | 129 files, 0 byte mismatches | Real package wrapper run in a disposable source copy; existing `dist/` untouched |
| Extracted runtime checks | Passed | Runner help, host help, and ACP protocol version 1 initialization without dependencies |
| External-connection guard self-check | Passed | A non-loopback socket attempt is refused before connection |

The final check logs and the earlier failures are retained in the private evidence folder. Static documentation validation is recorded alongside those logs. Alan confirmed that the report opened in Edge. Automated layout inspection remained blocked: the managed in-app browser was unavailable, and Edge automation was blocked by an open extension interface. No automated visual pass is claimed. The temporary read-only preview server was stopped; the preview tab was left in Edge.

Every baseline and repair check used the resolved executable `/Users/alanman/.local/share/nodejs/v22.23.4/bin/node`, pinned by path and SHA-256. The pinned executable hash is `2cc28a1880d0774616959f2210ee739bffa6ac695c887e8988a496a21271f6c0`. A small subprocess environment supplied invented test credentials, and a Node preload blocked external TCP connections. This prevented the other chat's shared-launcher update from changing the test runtime halfway through.

The complete source package was built outside the normal checkout outputs. Its preserved archive hash is `4963fe71d77b57bd5672d6e2e0c7d2560a82a9b37e360bed4478c71b5d3ccc46`. Runtime files in the extracted package matched the reviewed checkout byte-for-byte.

## Earlier live evidence and remaining work

The November 3 source handoff and machine-readable check results record two separate routes:

1. **Actual T3 with a fake backend:** reading, Unicode, supervised refusal/approval, cancellation, and continued conversation passed. T3's Auto permission setting could answer Ask requests automatically; use Supervised when a human decision is required.
2. **Real backend outside T3:** eight requests passed synthetic recall/context and a controlled runner edit loop. Largest single input: 122,900 tokens. The private validation host was stopped afterward. Historical reference estimates are not proof of account charges.

This review verified that its initial 312 source fingerprints, file sizes, and modes match that handoff. It did not repeat those live experiments. The source match strengthens version provenance; it does not make historical tests current account or service evidence.

Remaining work is explicit:

- Actual account billing and attribution for prior experiments remain unverified here. No dashboard or account data was read in this cleanup.
- Combined actual T3-to-live-backend approval/cancellation, the normal installed provider, and normal installed-host behavior remain unverified.
- Endurance, maximum context, live error/retry/cancellation behavior, cache hits, output exhaustion, and the long-context pricing boundary remain separate experiments.
- Native history compaction, Starlark, external MCP tools, image/audio prompts, structured question tools, and extra workspace roots remain deferred or unsupported in this adapter.
- The inherited threat-model document remains partly Claude-specific; a Codex-specific rewrite is still roadmap work.
- `SECURITY.md` remains absent. This review covered the preserved changes and relevant safety boundaries, rather than every inherited subsystem.
- Fresh execution under the separately updated Node patch was not performed; the current report describes the deliberately pinned 22.23.4 checks.

Future live work needs a newly defined bounded experiment and explicit authorization in its owning chat. The historical spending ceiling does not authorize new paid requests in this review.

## Preservation and evidence

The owner-only evidence folder is:

`/Users/alanman/Documents/Codex/2026-11-11-codex-cleanup-review`

It contains:

- `private-preservation/initial-source.tar.gz`: all 312 initial source files, verified against their archived hashes.
- `private-preservation/initial-git-metadata.tar.gz`: the initial Git metadata.
- Binary full-index unstaged and staged patches, full individual untracked-file inventory, full status, source manifest, and SHA-256 checksums.
- `prior-handoff-comparison.json`: zero initial-file mismatches against the November 3 312-file handoff.
- `runtime.json`, initial/final state records, complete check logs, the failing regression log, and the supplementary lint failure log.
- A review-only patch, final source archive/manifest, file inventory, standalone package, copied crash harness, and fresh crash observations.

The evidence directory uses mode `700` and preserved files use mode `600`: only the account owner can access them through normal filesystem permissions. Archives are local and unencrypted. No credential value or saved conversation payload was placed in this report.

The backup is the recovery point for the complete dirty checkout, including new files. Restoring from the base commit alone would lose that work. No restore or cleanup command is needed to read this report.

## Complete changed-path inventory

The “review action” column compares today's final file with the preserved initial snapshot, rather than comparing everything with the old Git commit.

| Path | Git state | Area | Review action |
| --- | --- | --- | --- |
| `.gitignore` | modified | Packaging / hygiene | preserved unchanged |
| `PORTING.md` | modified | Documentation | preserved unchanged |
| `README.md` | modified | Documentation | updated here |
| `bin/codex-host.js` | new, untracked | Credential host | preserved unchanged |
| `bin/local-bridge-acp.js` | new, untracked | ACP interface | preserved unchanged |
| `bin/local-bridge-archive.js` | modified | Runner / model controls | updated here |
| `bin/local-bridge-runner.js` | modified | Runner / model controls | updated here |
| `docs/codex-acp-hosting.html` | new, untracked | Documentation | updated here |
| `docs/codex-acp-hosting.md` | new, untracked | Documentation | updated here |
| `docs/codex-bridge-runner-roadmap.html` | modified | Documentation | updated here |
| `docs/codex-cleanup-review-2026-11-11.html` | new, untracked | Documentation | new report |
| `docs/codex-cleanup-review-2026-11-11.md` | new, untracked | Documentation | new report |
| `docs/codex-reopening-2026-10-17.html` | new, untracked | Documentation | updated here |
| `docs/codex-reopening-2026-10-17.md` | new, untracked | Documentation | updated here |
| `docs/command-builder.html` | modified | Documentation | preserved unchanged |
| `docs/lab-notes/codex-protocol-notes.html` | new, untracked | Documentation | updated here |
| `docs/lab-notes/codex-protocol-notes.md` | modified | Documentation | preserved unchanged |
| `docs/runner-quickstart.html` | modified | Documentation | updated here |
| `package-lock.json` | modified | Packaging / hygiene | preserved unchanged |
| `package.json` | modified | Packaging / hygiene | updated here |
| `scripts/capture-codex-fixture.js` | modified | Runner / model controls | preserved unchanged |
| `scripts/codex-transport-smoke.js` | modified | Runner / model controls | preserved unchanged |
| `scripts/package-standalone.js` | new, untracked | Packaging / hygiene | preserved unchanged |
| `src/hosting/server.js` | new, untracked | Credential host | preserved unchanged |
| `src/hosting/state.js` | new, untracked | Credential host | preserved unchanged |
| `src/runner/acp/agent.js` | new, untracked | ACP interface | preserved unchanged |
| `src/runner/acp/connection.js` | new, untracked | ACP interface | preserved unchanged |
| `src/runner/codex-transport.js` | modified | Runner / model controls | preserved unchanged |
| `src/runner/confirmation.js` | modified | Runner / model controls | preserved unchanged |
| `src/runner/hosted-ports.js` | new, untracked | Runner / model controls | preserved unchanged |
| `src/runner/human-log.js` | modified | Runner / model controls | preserved unchanged |
| `src/runner/kernel/contract.js` | modified | Runner / model controls | preserved unchanged |
| `src/runner/model-client.js` | modified | Runner / model controls | updated here |
| `src/runner/model-controls.js` | new, untracked | Runner / model controls | preserved unchanged |
| `src/runner/model-pricing.js` | modified | Runner / model controls | updated here |
| `src/runner/model-retry.js` | modified | Runner / model controls | preserved unchanged |
| `src/runner/run.js` | modified | Runner / model controls | preserved unchanged |
| `src/runner/safety.js` | modified | Runner / model controls | updated here |
| `src/runner/session-health.js` | modified | Runner / model controls | preserved unchanged |
| `src/runner/tool-pipeline.js` | modified | Runner / model controls | preserved unchanged |
| `src/runner/tool-registry.js` | modified | Runner / model controls | preserved unchanged |
| `test/runner/codex-acp.test.js` | new, untracked | Offline checks | preserved unchanged |
| `test/runner/codex-host.test.js` | new, untracked | Offline checks | preserved unchanged |
| `test/runner/codex-model-client.test.js` | modified | Offline checks | updated here |
| `test/runner/codex-reconciliation.test.js` | new, untracked | Offline checks | preserved unchanged |
| `test/runner/codex-reopening.test.js` | new, untracked | Offline checks | updated here |
| `test/runner/codex-transport.test.js` | modified | Offline checks | preserved unchanged |
| `test/runner/command-builder-drift.test.js` | modified | Offline checks | preserved unchanged |
| `test/runner/model-client.test.js` | modified | Offline checks | preserved unchanged |
| `test/runner/model-pricing.test.js` | modified | Offline checks | updated here |
| `test/runner/session-health.test.js` | modified | Offline checks | preserved unchanged |
| `test/runner/streaming-tool-result.test.js` | modified | Offline checks | updated here |

## Handoff

**Folder:** `/Users/alanman/Developer/codex-local-bridge-playground`.

**Branch/base:** `main`, `bcc022c2e338abc99b27aad1b0393cfc14aa8b09`. Nothing staged; no commit or push created.

**Files:** 52 changed paths in total. This review updated 18 existing files (14 already changed and four previously clean) and added this Markdown report plus its standalone HTML companion. All 46 initial paths remain, with 32 of those changed paths untouched by this review. See the inventory above and private review-only patch for the exact boundary.

**Checks:** 682 tests, expanded lint, configured formatting, whitespace, 36 JavaScript syntax checks, three recorded runner scenarios, seven owned crash fixtures, and standalone extraction/initialization passed. Original passing results and later failing regressions remain visible in separate logs.

**Skipped:** live/paid requests, signed-in account inspection, combined live T3, normal host startup, Node installation changes, installation into another application, commits, pushes, dependency installation, and visual browser inspection (blocked by the browser extension interface). The pinned runtime was intentionally retained throughout verification.

**Risks and next step:** the remaining live/service/account limits above still apply. Short streamed answers may display later because redaction buffers incomplete lines. Review the code and evidence in the existing checkout; committing or publishing it is a separate owner instruction.

To read this report, open **Finder**, choose **Go → Go to Folder…**, enter `/Users/alanman/Developer/codex-local-bridge-playground/docs`, and double-click `codex-cleanup-review-2026-11-11.html`. A browser should show the dated title, contents, evidence tables, and file inventory. If the browser shows source text, use Finder's **Open With** menu to choose a browser. No Terminal command is required.
