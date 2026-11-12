# Codex ACP and standalone hosting

Setup guide · reviewed 2026-11-11 · `/Users/alanman/Developer/codex-local-bridge-playground` · branch `main`.

## November 11 offline review

The unchanged 46-path local implementation was privately backed up and passed all 677 existing tests. Five added regression tests reproduced display-redaction and pricing edge cases; the repaired suite passes 682 tests. The [dated cleanup review](./codex-cleanup-review-2026-11-11.html) records the preservation, repairs, package checks, and remaining limits. This review made no live model request, did not start the normal host, and created no commit or push.

The T3 command below now uses the shared Node launcher instead of the retired Hermes path. Model and pricing details below remain dated implementation evidence; this offline review did not revalidate current service pricing or permitted use.

## November 3 reconciliation applied to the original checkout

The separately tested reconciliation has been applied to the original checkout on `main`, based on published `bcc022c`. The original dirty source and Git metadata were preserved outside the repository before application. The changes remain uncommitted and unpushed; the normal host has not been restarted. The current setup instructions below include the November 11 launcher correction; dated test counts describe their own checkpoints.

- The standalone service preserves only validated error status, retry delay, and recognized network codes. The runner remains the single owner of retries. The local client accepts this error envelope only on its explicitly selected local-service route; unknown failures stop without guessing from prose or a generic relay status.
- Each prompt and configuration change reloads the saved session settings while holding its exclusive lock. A client that loaded Code mode earlier must honor a newer saved Ask or Plan setting, and the interface receives the refreshed settings. A failed reload leaves the saved file intact and releases the lock.
- Cancellation interrupts a retry wait as well as an active request or pending approval. Completed edits and paired tool receipts remain preserved.
- Filesystem failures become valid numeric JSON-RPC errors. Streamed text keeps incomplete UTF-8 character bytes between network chunks, on direct and hosted routes.
- The published session-filename validation, bounded/classified retries, and current-request context accounting remain in place, alongside local output limits and incomplete-tool protection.
- A hard process kill can leave an unanswered native tool call even after a lock is manually cleared. Resume now refuses that malformed history before any backend request, including when resume-risk acknowledgement is supplied. Inspect files for completed edits and use a fresh session; the runner does not fabricate receipts or repeat edits to repair history.

Recorded November 3 evidence: 677 offline tests and seven external crash scenarios passed with fake credentials and temporary local services. Actual T3 checks with a fake backend covered reading, Unicode, supervised approvals/refusals, cancellation, and continued conversation. Separately, eight real backend requests outside T3 passed synthetic-context and runner tool-loop checks; the largest input was 122,900 tokens. The private validation host was stopped afterward. Those separate routes do not prove combined T3-to-live-backend behavior, actual account charges, or endurance. T3's separate title generation was not fully metered. The preserved external November 3 handoff contains the detailed evidence; this review did not repeat those live requests. Both the service and client need the reconciled error contract. Starlark and native history compaction remain deferred.

## Two ways to run

**Direct:** T3 starts the ACP (Agent Client Protocol) adapter. That process runs the local tool loop and calls the Codex backend using `CODEX_ACCESS_TOKEN` in its environment.

**Standalone host:** a background service owns `CODEX_ACCESS_TOKEN`. T3 starts the same adapter with `--host standalone`; it reads an owner-only local connection file and uses a separate local caller token. The host forwards native Responses events to the runner. No editor window is needed. The model's tools still execute in the runner, not in the credential service.

Both routes preserve native Responses conversation history. Neither route adds Starlark or changes the Claude checkout. The package needs Node.js 22 or later; it has no third-party runtime dependencies and does not bundle Node itself.

## T3 manual provider fields

In T3 Code, open Settings → Providers → Add provider and choose the manual ACP option. These are configuration values, not text to paste into a chat:

- Name: `Codex Playground`
- Command on this Mac: `/Users/alanman/.local/bin/node` (the shared Node launcher; its target can be updated independently of this repository).
- Arguments, direct route: `/Users/alanman/Developer/codex-local-bridge-playground/bin/local-bridge-acp.js`
- Arguments, standalone route: `/Users/alanman/Developer/codex-local-bridge-playground/bin/local-bridge-acp.js --host standalone --ignore-client-mcp`

If the T3 form represents arguments as separate entries, enter the script path, `--host`, `standalone`, and `--ignore-client-mcp` separately. The optional `acp` subcommand is also accepted. Use the direct manual ACP provider, not an impersonation of the Cursor command-line program.

The direct route requires the access token in the environment of the T3-launched process. The standalone route requires a running host, but T3 does not need the upstream token. Do not paste the upstream token into command arguments or this documentation.

T3 may supply MCP (Model Context Protocol) servers during session setup. `--ignore-client-mcp` explicitly leaves those extra tools unused so the session can start; it does not connect to their URLs or run their commands. Without that option, the adapter rejects supplied MCP servers. The runner’s built-in tools remain available.

Workspace trust remains required. If the workspace has not already been trusted, the runner reports `workspace_not_trusted`. Explicitly adding `--trust-workspace` to the adapter arguments trusts the folders supplied by that provider. This does not automatically approve edits or enable shell commands. Add it only for a provider whose selected project folders you intend to trust.

Refresh provider status after saving. A working adapter reports protocol version 1 and the model `gpt-6.1-sol`. The November 3 check configured a temporary offline provider in the actual T3 application on the primary M3 and verified reading, Unicode, supervised approval/refusal, cancellation and same-conversation continuity. The normal installed provider and combined T3-to-real-backend route remain unverified; the separate November 3 backend experiment is described above. T3 can also generate thread titles through a separately configured model; a mock ACP backend alone does not meter all T3 account usage.

## Starting and stopping the host

Open **Terminal**, in Applications → Utilities. In that Terminal, first move to the repository:

```bash
cd /Users/alanman/Developer/codex-local-bridge-playground
```

Use a Terminal whose environment already contains `CODEX_ACCESS_TOKEN`. Then start the background host:

```bash
node bin/codex-host.js start
```

Success prints JSON containing `"status":"ok"`. The service listens on `127.0.0.1:11448`, accessible only on this computer. `serve` runs in the foreground instead of the background. This package does not install a login item or start automatically after a reboot.

To inspect it, in Terminal in that same folder:

```bash
node bin/codex-host.js status
```

To stop it, in Terminal in that same folder:

```bash
node bin/codex-host.js stop
```

Success prints `"status":"stopping"`. Stopping cancels active model requests. Status and shutdown require the local caller token, which these commands read automatically; they never print it.

A missing `CODEX_ACCESS_TOKEN` error means this Terminal does not have the upstream credential. A port-in-use error means another process already owns that port; inspect it rather than killing an unknown process. A failed startup points to the private `~/.bridge-runner/codex-host/host.log`. A leftover `host.lock` after a crash requires inspecting the recorded process before removing the lock; automatic PID-based killing is deliberately absent. A missing host state error in T3 means the host has not started, stopped, or is using a different state directory.

Advanced: `--port` and `--state-dir` choose a separate host instance. Give the adapter the matching `--host-state-dir`. The client transport also accepts `CODEX_BRIDGE_URL` and `CODEX_BRIDGE_CALLER_TOKEN` for local service callers, with loopback-only address validation. Do not combine that route with a conflicting endpoint override.

## Standalone archive

In Terminal, from the repository folder, build the package:

```bash
npm run package:standalone
```

Success prints the archive path, file count, and integrity hash. The archive is saved under `dist/` and contains the runner, adapter, host, built-in prompts, and this guide. It excludes dependency folders, tests, credentials, sessions, and experiment artifacts. Nothing is published or installed globally.

Extract the archive into a folder of your choice. Its `package/` directory contains `bin/local-bridge-acp.js` and `bin/codex-host.js`. Point T3's script argument at that extracted path. Node.js must already be installed; no `npm install` is needed for runtime use.

## Behavior and limits

- Session creation requires an absolute project directory. Session loading binds the saved session to that same real directory, restores native model context, and replays redacted user/assistant/tool history to T3.
- Sessions live under `~/.bridge-runner/codex-acp`; the host's separate private connection directory is `~/.bridge-runner/codex-host`. The latter stores only the local caller token, never the upstream access token.
- The Ask mode requests approval from the client application for edits. In the actual November 3 T3 check, T3's **Permissions: Auto** answered that request automatically despite the adapter displaying Ask. Select **Permissions: Supervised** in T3 when a human decision is required, and verify the visible prompt in a disposable project first. Plan proposes edits without applying them. Code approves enabled edits without per-edit prompts. Shell remains hidden unless `--allow-shell` is explicitly supplied when launching the adapter.
- One prompt runs at a time per adapter process, even across different sessions. A per-session lock also prevents simultaneous prompts from separate processes; after a forced process kill, inspect the PID in the leftover .run.lock before removing it. T3 can launch separate processes for separate chats. Default step ceiling: 32 model requests per prompt, configurable with `--max-steps`.
- Cancellation interrupts the model request or pending approval and prevents subsequent tools. Completed edits remain. An already executing local tool may finish; this is not rollback.
- This first adapter supports text prompts and completed-response text updates. Images, external MCP (Model Context Protocol) servers, extra workspace roots, structured question tools, and token-by-token display are not advertised or exposed.
- Approval requests offer allow-once and deny. They time out safely. Unknown replies and client disconnects do not approve edits. The model cannot change the host or acquire shell permission.
- Cost accounting remains available in the runner. Reference estimates do not establish actual billing. A model without a known price cannot start a dollar-budget run. Historical experiment budgets do not authorize a new live campaign.
- Terminal `--stream` output is redacted in buffered chunks. Unfinished lines and private-key blocks can delay display; this option does not promise immediate token-by-token printing.

## Verification and next checks

Automated checks cover real ACP pipes, a real child-process handshake, fragmented Unicode, malformed JSON recovery, native session continuity, fresh-client replay, approval, cancellation, configuration, host authentication, credential separation, the complete ACP → host → model-substitute route, and detached host start/status/stop. Test model servers run locally with fake tokens.

November 11 verification: the unchanged checkout passed 677 tests; after five reproduced regression failures and their repairs, the suite passes 682. Lint, formatting, syntax, recorded runner scenarios, and standalone-package checks are recorded in the dated review. The extracted package can initialize its ACP adapter and print CLI help without installing dependencies. All model-shaped requests in this review stayed on this computer and used fake tokens. Actual billing, combined live T3 use, endurance, and maximum-context behavior remain separate work.

Historical checkpoints: the October 18 adapter slice recorded 634 tests and a 127-file package; November 3 recorded 677 tests and a 129-file package. Those counts describe different versions. They are retained as provenance, not competing current results.

Protocol references: [ACP session setup](https://agentclientprotocol.com/protocol/v1/session-setup), [prompt turns](https://agentclientprotocol.com/protocol/v1/prompt-turn), and [tool permissions](https://agentclientprotocol.com/protocol/v1/tool-calls). T3-specific response shapes were checked against the local `t3code` source. Claude's adapter informed the design; its transport and credential implementation were not copied.

## Setup diagnosis update

October 18 setup fix: the default host port is now 11448 because 11438 was occupied by another local gateway. Startup now reports the child process error directly; checking an already-running host does not require re-supplying the upstream token.
