# PORTING.md

Cross-repo fix log between this fork and `claude-local-bridge-playground`.

The two repos share ancestry but diverge on purpose (roadmap Option C). Nothing flows between them automatically, so
every fix deliberately carried across gets one line here. This keeps divergence visible instead of silent, and gives
future "should we go monorepo?" discussions real evidence.

Format: date · direction · source commit · one-line description.

## Provenance

- Seeded from `claude-local-bridge-playground@7c206c4e47222c8751853cc9ac6e8ea74b73045a` (main, post PR #17) on
  2026-07-08.

## Ported fixes

- 2026-10-17 · Claude → Codex · reference checkout `0a26f14` · Borrowed the interface concepts for progress, injected approvals, and cancellation; implemented independently for native Responses history. No ACP adapter, bridge host, or Starlark code copied.

- 2026-10-17 · Claude → Codex · local ACP reference · Independently implemented ACP v1 session/config/permission patterns and T3 model-list/mode compatibility. Added Codex-only standalone host with environment credentials and separate local caller authentication. No Claude credential or Starlark code copied.
