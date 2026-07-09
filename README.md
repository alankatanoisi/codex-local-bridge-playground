# Codex Local Bridge Playground

> **Fork status:** experimental proof of concept, seeded from
> [claude-local-bridge-playground](https://github.com/alankatanoisi/claude-local-bridge-playground) (Option C of the
> [Codex bridge runner roadmap](./docs/codex-bridge-runner-roadmap.html)). The runner code here still speaks the
> Anthropic Messages dialect internally — the Codex transport rewrite (roadmap Phases 2–3) has **not** landed yet, so
> live model calls do not work in this repo yet. Offline tests and golden evals do.

This repo is the lab for a **Codex local bridge runner**: the same small local coding-agent loop developed in the
Claude playground (prompts, capability-grouped tools, permissions, safety, sessions, transcripts, archives, undo),
being ported to drive **OpenAI Codex models** through the Responses API.

```text
prompt -> Responses API (OpenAI) -> model response -> function_call -> local tool execution -> function_call_output -> repeat
```

## Repository lanes (read this first)

| Lane                       | GitHub                                                                                            | Use for                                              |
| -------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| **This fork (Codex lane)** | [codex-local-bridge-playground](https://github.com/alankatanoisi/codex-local-bridge-playground)   | Codex runner port: transport, adapter, PoC runs      |
| Claude playground          | [claude-local-bridge-playground](https://github.com/alankatanoisi/claude-local-bridge-playground) | Claude runner work; do not mix commits between lanes |

The two repos share ancestry (see the seed commit) but diverge on purpose. Fixes worth carrying across are logged in
[`PORTING.md`](./PORTING.md).

## Credentials & policy (read before any live call)

Upstream auth for this lane is a **ChatGPT Business programmatic access token** (`at-…`), created in the ChatGPT
dashboard under _Access tokens — create and manage access tokens for ChatGPT and Codex programmatic use cases_, and
supplied to the runner through **one environment variable only** (planned name: `CODEX_ACCESS_TOKEN`).

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
  [docs/lab-notes/codex-protocol-notes.md](./docs/lab-notes/codex-protocol-notes.md); one mechanical step remains —
  importing the redacted SSE fixture from the capture machine.
- **Phase 1 — create and seed the fork:** done (this repo). Seed commit records the source commit; prune removed the
  VS Code extension, Claude bridge transport, and Claude-specific lanes.
- **Phase 2 — transport (direct token client):** next up.
- **Phase 3 — rewrite the coupled modules (Responses API client):** not started. Until this lands, `src/runner/` still
  targets the old local Claude bridge and live runs are not possible here.
- **Phases 4–6:** not started.

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
