# CLAUDE.md

Claude-specific instructions for this repository. Read `AGENTS.md` first; it contains the shared beginner-first
workflow, the preflight ritual, and the safety and credential invariants. This file only adds what Claude agents need
on top.

## Which Repo Is This?

Run `pwd` before assuming:

| Path ends with                   | Repo                           | Expected branch |
| -------------------------------- | ------------------------------ | --------------- |
| `codex-local-bridge-playground`  | **This fork (Codex lane)**     | `main`          |
| `claude-local-bridge-playground` | Claude playground (other lane) | `main`          |

If you are in the Claude playground, stop — Codex work does not belong there, and Claude runner work does not belong
here. Never mix commits between the lanes.

## Project Overview

This fork ports the local coding-agent loop to OpenAI Codex models:

```text
prompt -> Responses API (OpenAI) -> model response -> function_call -> local tool execution -> function_call_output -> repeat
```

Plan of record: `docs/codex-bridge-runner-roadmap.html` (Part 5). Current state is tracked in README.md — until
roadmap Phase 3 lands, `src/runner/model-client.js` still speaks the old local Claude-bridge dialect and live model
calls do not work from this repo.

## Working Notes for Claude Agents

- This repo is about OpenAI transport, but the **internal** message representation deliberately stays on the
  Anthropic-block dialect (`tool_use` / `tool_result` content blocks). Translate only inside the model client.
  Resist "cleanup" refactors that push Responses-API shapes into the tool pipeline, compactor, transcripts, or archive.
- The golden-eval harness (`npm run runner:eval`) and the full test suite run offline with a fake client — use them
  freely; no credentials are ever needed for tests.
- The Anthropic-invariant rules from the Claude playground (no OpenAI routes there, OAuth-only there) apply to **that**
  repo, not this one. This repo's invariants are in AGENTS.md: `at-…` token from one env var, Responses API only,
  no Anthropic credentials or fallbacks here.
- When porting a fix from the Claude playground (or contributing one back), add a line to `PORTING.md` with the
  source commit hash.

## Key Files

- `README.md`: fork status, lanes, credential policy, roadmap state.
- `PORTING.md`: cross-repo fix log.
- `docs/codex-bridge-runner-roadmap.html`: the living build plan (feasibility, wire-format table, phases, risks).
- `bin/local-bridge-runner.js`: runner CLI entrypoint.
- `src/runner/run.js`: main runner loop (Phase 3 edits the cache/reasoning paths here).
- `src/runner/model-client.js`: model transport client (Phase 3 rewrites this to the Responses API).
- `src/runner/tool-registry.js` / `src/runner/tool-catalog.js`: tool dispatch and definitions.
- `src/runner/permissions.js` / `src/runner/safety.js`: allow/ask/deny policy; confinement and redaction.
- `src/trace-utils.js`: shared trace/redaction utilities.

## Docs To Keep Updated

When changing runner behavior, CLI options, or transport/auth behavior, update: `README.md`,
`docs/runner-quickstart.html`, `docs/command-builder.html`, `docs/threat-model.md` (safety changes), and the phase
status in `docs/codex-bridge-runner-roadmap.html`.
