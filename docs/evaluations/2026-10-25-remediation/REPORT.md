# Codex runner: three bounded fixes — October 25, 2026

The evaluation evidence is now committed and pushed. The three agreed runner fixes are implemented on Codex main: safe session filenames, classified retries with bounded waits, and current-request context accounting. No paid model requests were made. The original October 18 evidence remains byte-for-byte unchanged.

## Folder, branch, and provenance

- Repository: `/Users/alanman/Developer/codex-local-bridge-playground`, branch `main`.
- Evidence commit: `bebd914` (29 supporting files), published separately before implementation.
- Original report commit: `d87a705`; original results remain under `docs/evaluations/2026-10-18/`.
- Implementation starts from `bebd914`; the commit containing this report records the exact patch.
- The Claude repository, original isolated snapshot, existing user projects, and credentials were not edit targets.

The original isolated evaluation included uncommitted features that were never present in this Mac's committed Codex main. Comparing its manifest with the pre-fix main tree found **42 differing or missing paths**, including hosted transport, T3 adapter, output-control, and observer changes. Therefore, **635 tests describes the evaluated snapshot, while 603 tests describes the actual pre-fix main checkout**. This work fixes only the agreed issues on committed main; it does not silently promote those other snapshot features.

## What changed and why

### 1. Session filenames fail safely before creating files

Previously, `session.json` could be used as both a state file and its event log because the log filename was derived by replacing a `.state.json` suffix that was absent. The shared validator now requires `.state.json` before state-store construction, ledger path derivation, explicit path resolution, or autopsy-file writing. Empty explicit filenames are rejected too. The command-line interface treats this as an understandable input error and gives an example: `session.state.json`.

Regression checks verify zero model requests and zero new project files for an invalid path; they also verify that an existing invalid-path file stays byte-for-byte unchanged. Existing tests verify that valid native session persistence and resumption still work.

### 2. Permanent errors stop; temporary errors retry with waits

The transport now attaches a numeric HTTP status and a parsed Retry-After delay to redacted errors. The runner uses those structured fields, rather than guessing from backend prose. Error messages remain scrubbed.

- Temporary HTTP statuses: 408, 429, 500, 502, 503, and 504.
- Temporary network codes: ECONNRESET, ECONNREFUSED, ETIMEDOUT, EAI_AGAIN, and EPIPE.
- All other statuses and unclassified errors stop. This includes invalid-request and authentication failures.
- A consecutive failure can receive at most two retries, also bounded by the remaining model steps. The waits start at 250 ms and 500 ms; a valid server Retry-After can make them longer.
- A server delay over 30 seconds ends this bounded run instead of retrying earlier than requested. A wait that would consume the remaining configured wall-clock allowance is refused too.
- A successful model response resets the consecutive retry allowance. Tool failures have their own counter.

These are deliberately bounded policy choices for this runner. They do not establish universal backend recovery behavior. A temporary network error may occur after upstream processing; a retry can repeat processing, so limits remain important.

### 3. Context size is separated from cumulative usage

The hard context guard now uses the latest response's reported input plus output tokens. It no longer adds all earlier requests together. Cached input and reasoning are already represented within the normalized input/output totals and are not added again.

The existing threshold behavior is retained: warn above the configured context threshold and stop above twice that threshold. Cumulative input/output allowances remain separate and still stop a run when used up. Before a response arrives, an advisory estimate includes the entire serialized request: instructions, native history, tool receipts, and tool definitions. Bytes divided by three is only a rough estimate; it warns and never blocks by itself.

Native history compaction remains bypassed. This change corrects accounting; it does not implement compression, guarantee that an oversized request is stopped before transmission, or establish full-window endurance.

## Before and after verification

The first nine regression checks were run against untouched main before fixes: **seven failed and two passed**. Their names and outcomes are preserved in `checks.json`. After implementation, those cases plus edge checks pass: **16 of 16**. The current full suite passes **619 of 619** (603 existing tests plus 16 new tests).

| Scenario | Before | After |
| --- | --- | --- |
| Invalid session filename | Not rejected safely | Rejected before session writes or network requests |
| Direct invalid store/log/autopsy path | Unsafe path accepted | Rejected; existing file preserved |
| Permanent HTTP 400 | Three requests | One request; bridge_error |
| One HTTP 503 followed by success | Immediate retry | Delayed retry, then success |
| Repeated HTTP 503 | Immediate retries | Three requests maximum, with increasing waits |
| HTTP 429 with a 120-second Retry-After | Retried immediately | One request; bounded run ends |
| Five small contexts with 15,000 cumulative input tokens | Stopped on fourth response | All five requests complete; usage remains 15,000 |
| One individually oversized context | Stopped | Still stopped before executing its tool |
| Separate 5,000-token cumulative input cap | Stopped | Still stopped on the second 3,000-token request |

Additional tests cover HTTP-date delays, invalid/overflowing header values, short server waits, the last allowed model step, the wall-clock allowance, successful-response retry resets, understandable filename errors, and structured error metadata/redaction.

| Check | Exit code | Result |
| --- | ---: | --- |
| regressions | 0 | 16 passed, 0 failed |
| test | 0 | 619 passed, 0 failed |
| lint | 0 | Pass |
| format | 0 | Pass |
| bin-syntax | 0 | Pass |
| diff-whitespace | 0 | Pass |


The tests use a local HTTP server and disposable projects. They exercise the real runner, client, session stores, and local tool execution without real credentials. The fake token exists only for these offline tests. The original read/edit/live model fixtures and reports are preserved; new paid live comparisons were not run. This is deterministic regression evidence, not a claim about current live backend behavior or typical timing.

## Changed files

- `src/runner/session-path.js`: shared validation and beginner-friendly error.
- `src/runner/session-store.js`, `session-ledger.js`, and `loop-autopsy.js`: validate before using derived session files.
- `src/runner/model-retry.js`: structured classification and bounded server/backoff delays.
- `src/runner/codex-transport.js`: retain only the numeric retry metadata and network error code; authentication is unchanged.
- `src/runner/run.js`: delayed bounded retries and current-response context accounting.
- `bin/local-bridge-runner.js`: accurate help and expected-error formatting.
- `test/runner/codex-remediation.test.js`: 16 offline regression checks.
- `test/runner/codex-transport.test.js`: retain redaction coverage and assert structured HTTP status.
- `docs/command-builder.html` and `docs/runner-quickstart.html`: correct filename and context explanations, including the absence of native compaction.
- This Markdown report, its standalone HTML companion, and `checks.json`.

## Reproducing the checks

In macOS Terminal, work in the Codex folder below. Terminal can be opened by pressing Command-Space, typing Terminal, and pressing Return. Run one command at a time; the regression command should report 16 passing tests, while the complete suite should report 619. The fake local service means these commands do not spend model credits.

```bash
# Point Terminal at the Codex repository, which is separate from the Claude one.
cd /Users/alanman/Developer/codex-local-bridge-playground
# Exercise the specific failures and boundary conditions fixed here.
node --require ./test/setup.js --test test/runner/codex-remediation.test.js
# Check the complete existing suite plus the new tests.
npm test
# Check the configured JavaScript rules.
npm run lint
# Check formatting without changing files.
npm run format:check
```

If lint or formatting reports that its executable is missing, the pinned development dependencies have not been installed in that checkout; `npm ci` installs them using its existing lockfile. No dependency files were changed in this work. Installation reported two high-severity dependency advisories; these were not investigated or changed as part of the three runner fixes.

## Remaining boundaries and handoff

No fixes were made to native compaction, cancellation notification semantics, T3, or Starlark. No real upstream calls, large-project tests, long-context endurance runs, or account billing checks were performed. The preserved evaluation snapshot and any already-running process have not been updated by changing this repository; they must not be assumed to contain these fixes.

The original snapshot's hosted/observer features need a separate reconciliation decision before assuming that tests in main cover them. The next useful review is of these three changes and their focused regressions. Scope of this handoff is the Codex repository on main; all implementation checks listed above passed, and original evaluation checksums were verified again.
