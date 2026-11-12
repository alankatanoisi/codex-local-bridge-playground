# Node 22.23.5 verification supplement

November 12, 2026 · Codex local bridge playground · offline verification on the primary Mac.

> **Passed without repairs.** The reviewed implementation passes all 682 tests under Node 22.23.5, plus the recorded runner scenarios, crash fixtures, lint, formatting, syntax, and standalone-package checks. No existing repository file changed during testing. This supplement adds only a Markdown report and its standalone HTML companion. Later heavier implementation, build, testing, and live-call work is intended for Alan’s secondary 2020 MacBook Air.

This supplements the [November 11 cleanup review and handoff](./codex-cleanup-review-2026-11-11.html). The earlier report remains an unchanged record of its Node 22.23.4 checks.

## Location and source identity

| Field | Verified value |
| --- | --- |
| Current folder and repository root | `/Users/alanman/Developer/codex-local-bridge-playground` |
| Branch | `main` |
| Base commit | `bcc022c2e338abc99b27aad1b0393cfc14aa8b09` |
| Remote | `https://github.com/alankatanoisi/codex-local-bridge-playground.git` |
| Machine used for this verification | Primary Mac, `Mac15,13`, arm64 |
| Repository instructions | `AGENTS.md` read; `SECURITY.md` is absent |
| Initial state | 32 modified tracked files and 20 untracked files; 52 changed paths, nothing staged |
| Source comparison | All 314 initial files match the November 11 final manifest by SHA-256, size, and file permissions |
| Source after checks | All 314 initial files remain unchanged |
| Final repository change from this task | Two new report files; 54 changed paths in total, nothing staged |

The source manifest is a list of files with fingerprints: it lets us detect a changed byte, missing file, or changed permission. Matching manifests establish that the Node 22.23.4 and 22.23.5 runs used the same reviewed source. They do not establish behavior on another computer or against the live service.

The checkout’s existing work was preserved. No pull, reset, cleanup deletion, staging, commit, or push was performed. A new private pre-test archive was verified before this supplement was written.

## Exact runtime and offline boundary

| Runtime field | Recorded value |
| --- | --- |
| Node version | `v22.23.5` |
| Executable | `/Users/alanman/.local/share/nodejs/v22.23.5/bin/node` |
| Executable SHA-256 | `ff9365ccf73e95b7ac69867418124973addde63043650c0db96bd6a722c53cd8` |
| Subprocess PATH | Pinned Node directory first, followed by standard system directories |
| Test credential | Invented fixture value supplied in a reduced subprocess environment |
| Network boundary | Node preload refuses external TCP destinations; temporary model-shaped servers use loopback |

“Loopback” means a connection that stays on this computer, using an address such as `127.0.0.1`. The offline fixtures run the real request, tool, permission, session, and host code against a local substitute for the model service.

The check harness pins the resolved Node executable and verifies its hash. This keeps a shared-launcher change from switching runtimes during the run. The guard’s own test confirmed that an external socket destination was rejected before connecting.

Temporary fixture hosts were created and stopped by their tests. The normal host was not started or reconfigured. No live model request was made by this verification. No dependency installation, global Node update, account inspection, or desktop application change was performed.

## Check results

All checks passed on the first run. No new implementation defect or failing check required a repair.

| Check | Node 22.23.5 result | Evidence |
| --- | --- | --- |
| Targeted hosting, ACP, reconciliation, reopening, and session-health tests | 62 passed; 0 failed, cancelled, or skipped | `checks/node-22.23.5-targeted.log` |
| Complete `npm test` suite | **682 passed; 0 failed, cancelled, or skipped** | `checks/node-22.23.5-npm-test.log` |
| Expanded lint, including `src`, `test`, `bin`, and `scripts` | Passed | `checks/node-22.23.5-lint.log` |
| Configured formatting check | Passed | `checks/node-22.23.5-format-check.log` |
| Git whitespace check | Passed | `checks/node-22.23.5-diff-check.log` |
| Package allowlist dry run | Passed | `checks/node-22.23.5-pack-dry-run.log` |
| Offline connection guard self-check | Passed | `checks/offline-guard-self-check.log` |
| Recorded runner scenarios | 3 passed | `checks/runner-eval.log` |
| Owned crash-recovery fixtures | 7 passed; 0 failed, cancelled, or skipped | `checks/crash-fixtures.log` |
| Explicit entrypoint and script lint | Passed | `checks/entrypoint-lint.log` |
| Changed JavaScript syntax | 36 files passed | `checks/changed-js-syntax.json` |
| Standalone build in a disposable source copy | Passed | `checks/standalone-package-build.log` |
| Extracted runner help and host help | Both passed without `node_modules` | `checks/extracted-runner-help.log`, `checks/extracted-host-help.log` |
| Extracted ACP initialization | Protocol version 1; clean process exit | `checks/extracted-acp-handshake.json` |
| Package contents | 129 files, 0 source-byte mismatches, 0 forbidden paths | `extra-results.json` |
| Supplement structure and links | Checked after rendering; embedded styles, no external assets or scripts | `checks/supplement-validation.json` |

Lint checks for suspicious or redundant code. Syntax checks verify that JavaScript can be parsed. The recorded runner scenarios replay predefined model responses. The crash fixtures exercise interrupted requests, pending approvals, completed edits, stale locks, and refusal to resume unanswered native tool history. These are separate checks with different purposes.

The standalone archive was built in a temporary source copy, leaving the normal checkout’s existing `dist/` folder alone. It contains the runtime distribution; it does not contain the complete development/test checkout. Its SHA-256 is:

`4963fe71d77b57bd5672d6e2e0c7d2560a82a9b37e360bed4478c71b5d3ccc46`

That matches the November 11 archive hash. The extracted archive’s files also matched the current checkout byte-for-byte, and its ACP adapter initialized without installing dependencies.

## Comparison with the earlier verification

| Evidence | November 11: Node 22.23.4 | November 12: Node 22.23.5 |
| --- | --- | --- |
| Full test suite | 682 passed | 682 passed |
| Targeted tests | 62 passed | 62 passed |
| Recorded runner scenarios | 3 passed | 3 passed |
| Crash fixtures | 7 passed | 7 passed |
| Standalone runtime files | 129 | 129 |
| Reviewed source carried into the run | November 11 final source | Exact match to all 314 November 11 files |
| Source repairs during this run | Historical cleanup report records its repairs | None |

The supported conclusion is that the reviewed implementation passes these offline checks under Node 22.23.5 on the primary arm64 Mac. This is a compatibility result for the tested code paths. It does not establish current upstream model behavior, actual billing, endurance, every possible security property, or compatibility on the secondary laptop.

## Direction for the secondary 2020 MacBook Air

Alan’s November 12 instruction is to move the heavier implementation, build, and testing work in later steps—especially live-call work—to the secondary 2020 MacBook Air. This instruction governs the machine choice for that later work. Older primary-Mac-only checks in earlier handoffs describe their historical campaigns.

This verification stayed on the primary Mac because step 1 was explicitly authorized here. No connection, transfer, installation, configuration change, or test was performed on the MacBook Air. Its exact hardware identifier, chip architecture, operating system, Node executable, checkout location, and current source state remain unverified.

The next agent should:

1. **Verify the Air before working.** Confirm the actual computer, architecture, project folder, branch, remote, individual untracked files, and resolved Node executable. Preserve any work already on that machine before combining source.
2. **Transfer the exact reviewed development source.** There are still 52 pre-existing uncommitted paths on the primary Mac. A plain Git clone or pull will not contain them. Choose a reviewed Git checkpoint after separate authorization, or a verified source-archive transfer that preserves the Air’s existing work. The 129-file runtime package omits the tests and is insufficient as the complete development handoff.
3. **Verify the transferred source and runtime on the Air.** Compare fingerprints and repeat the relevant offline checks there before treating these primary-Mac results as an Air acceptance result.
4. **Keep the local integration boundary explicit.** A practical rehearsal would run T3, the adapter, host, fake backend, and disposable test workspace together on the Air, preserving the existing loopback-only host design. Using the primary Mac as a remote client would be a separate design choice.
5. **Define any live experiment separately.** Prepare a bounded request/output plan, account for T3 title generation, record usage privately, and obtain explicit authorization for the live trial. This step-1 instruction authorizes no live calls and does not revive a historical spending allowance. Provision any future credential through the approved environment on the intended machine.

No further implementation, heavier build, or live-call phase was begun here. A Git commit or push also remains a separate instruction.

## Evidence and preservation

The owner-only evidence folder is:

`/Users/alanman/Documents/Codex/2026-11-12-codex-node-22.23.5-verification`

It contains the exact runtime metadata, before/after source comparisons, complete logs, copied offline harness and network guard, copied crash fixtures and fresh observations, package archive, final machine-readable results, and checksums. `private-preservation/` contains the verified 314-file pre-test source archive, source manifest, full initial status, and patches. A final source archive includes this supplement and its companion.

The folder uses mode `700` and its files use mode `600`, restricting access through normal filesystem permissions to the account owner. Archives remain local and unencrypted. No upstream credential or saved account/conversation payload was added to this report.

## Handoff

**Folder / branch:** `/Users/alanman/Developer/codex-local-bridge-playground`, `main`, base `bcc022c2e338abc99b27aad1b0393cfc14aa8b09`.

**Files added:** `docs/codex-node-22.23.5-verification-2026-11-12.md` and `.html`. All 314 pre-existing source files remain unchanged. Nothing staged; no commit or push.

**Checks:** 682 full-suite tests, 62 targeted tests, three recorded runner scenarios, seven owned crash fixtures, expanded lint, formatting, 36 syntax checks, package build/extraction/initialization, whitespace, and supplement structure/link checks passed under the pinned Node 22.23.5 executable.

**Skipped:** live calls, account/billing checks, normal host startup, dependency installation, global runtime or application changes, commits/pushes, actual T3 interaction, visual browser inspection, and all execution or transfer on the MacBook Air.

**Remaining risks / next step:** the primary-Mac offline result is complete. The later heavier work should begin with the secondary MacBook Air preflight and an exact source handoff. Combined live T3 behavior, actual billing, and endurance remain unverified. This report supplies no new live-call authorization.
