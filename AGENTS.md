# AGENTS.md

Shared instructions for any coding agent working in this repository.

## Human Context

Alan is using agents to learn and build. He is a strong systems thinker, highly curious, enthusiastic about learning, but a true novice at programming and terminal workflows. Default to over-explaining, not under-explaining.

### Novice-First Rules

1. Never assume Alan knows whether something belongs in Terminal, VS Code, Cursor chat, GitHub in a browser, or a local folder path.
2. Define jargon once when you use it. Examples: branch, commit, push, pull request, merge, current working directory, lint, JSONL.
3. Every command you give must say where to run it, what folder to use first, and what success looks like.
4. Prefer one step at a time for Git and Terminal unless Alan asks for a batch.
5. Warn before risky actions such as pushing, force pushing, deleting files, enabling shell access, accepting edits automatically, or editing outside the repo.
6. Do not skip handoff fields: folder, branch, files, checks, skipped checks, and risks.
7. Prefer HTML docs over Markdown for complex documentation.
8. Prefer liberal and generous amounts of inline comments in code to explain the "why" behind the "what".
9. When adding new JavaScript in the runner, short beginner-friendly `//` comments are welcome where they explain non-obvious control flow. Do not add comments that only repeat what the code already says.
10. When in doubt, provide more context and explanation rather than less.
11. When providing multiple options, explain the pros and cons of each to help Alan make an informed decision.

## Which Repo Is This?

This is the **Codex fork** (`codex-local-bridge-playground`). It was seeded from `claude-local-bridge-playground` and
diverges on purpose. Rules:

- Codex runner work happens here, normally directly on `main`.
- Claude runner work happens in `claude-local-bridge-playground`, never here.
- Never mix commits, credentials, or pull requests between the two lanes. A pull request is a GitHub request to merge
  one branch into another.
- Fixes worth carrying between the repos are cherry-picked deliberately and logged in `PORTING.md`.

## Startup Preflight

At the start of file, repo, docs, testing, syncing, or command-line work, verify the location before editing:

```bash
pwd
git rev-parse --show-toplevel
git branch --show-current
git remote -v
git status --short
```

Success looks like: the repo root ends with `codex-local-bridge-playground`, the branch is `main`, `origin` points to
`alankatanoisi/codex-local-bridge-playground`, and the working tree has no unexpected dirty source files. Then pull
before new edits when it is safe to do so:

```bash
git pull --ff-only origin main
```

If the folder is home, Downloads, a scratch folder, or the **Claude** playground, pause and tell Alan before editing.

## Current Direction

This fork is a proof-of-concept port of the minimalist local coding-agent loop to **OpenAI Codex models** via the
Responses API. The plan of record is `docs/codex-bridge-runner-roadmap.html` (Part 5 phases). Keep the design
philosophy inherited from the Claude playground:

- Small default system prompt, minimal startup context, explicit opt-ins.
- Tools as capability groups, not a flat feature list.
- Customization through `.bridge-runner/` files, prompt templates, profiles, and hooks.
- Keep the internal conversation state as native OpenAI Responses **input items**
  (`message`, `function_call`, `function_call_output`, `reasoning`) — not Anthropic content blocks with a
  translation layer (recorded 2026-07-10; supersedes the earlier boundary-translation draft). Map tool
  `input_schema` → `parameters` at request build time only; do not spread wire details through safety or permissions.

## Transport & Credential Invariants

- Upstream auth is a ChatGPT Business programmatic access token (`at-…`) read from **one environment variable**
  (planned: `CODEX_ACCESS_TOKEN`). Nothing else: no scraped session tokens, no OAuth capture/replay, no keychain
  reads, no `auth.json` parsing.
- Never commit, print, or log the token. Redact `at-`, `sk-`, and `eyJ`-shaped strings in tool output, transcripts,
  traces, and logs.
- Native OpenAI Responses API only. No Anthropic credentials, routes, models, or fallbacks in this repo.
- Subprocess environments must be scrubbed so child shells do not inherit the token.
- Document policy risk plainly where transport/auth behavior is described: this is personal research; the dashboard's
  permitted-use text is quoted in README.md and verified in roadmap Phase 0.

For OpenAI API, Codex, billing, or policy facts, use official sources first: `platform.openai.com/docs`,
`help.openai.com`, `openai.com/policies`, and the official `github.com/openai/codex` repository.

## Safety Rules

Keep these invariants (inherited and unchanged):

- Shell is hidden unless `--allow-shell` is set; `--dont-ask` must not enable shell by itself.
- Block `.env`, private keys, credential JSON, token files, `.ssh`, `.aws`, `.codex`, `.claude`, and path escapes.
- Write tools ask for confirmation unless `--accept-edits` is set.
- Tool output, transcripts, JSON/stream-json output, and human logs redact secrets.
- `--cwd` means the target project folder the tools operate inside.

## Checks

Run relevant targeted tests first, then the standard checks before handoff:

```bash
npm test
npm run lint
npm run format:check
```

For runner-only work:

```bash
node --require ./test/setup.js --test test/runner/*.test.js
```

## Handoff

Always end with: folder and branch used; files changed; tests/checks run; anything skipped; risks or next steps. Do
not claim something is pushed unless `git push` actually succeeded.
