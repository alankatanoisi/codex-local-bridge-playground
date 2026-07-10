# Native items schema contract (Phase 3 Stage 2)

Plan of record: `docs/codex-bridge-runner-roadmap.html` Part 5 Phase 3.
Implementation: `src/runner/items.js`.

## Decision

This fork’s internal conversation state is a list of OpenAI Responses **input items**.
It is **not** Anthropic `messages` with `tool_use` / `tool_result` content blocks.

| Concern | Contract |
| ------- | -------- |
| History | Ordered array of items: `message`, `function_call`, `function_call_output`, `reasoning` |
| System prompt | Separate `instructions` string (not an item) |
| Tool defs | Map `input_schema` → `parameters` at request build (`toNativeToolDefinition`) |
| Tool errors | No `is_error` flag → prefix output with `ERROR: ` |
| Bad tool args | Fail-closed (`parseFunctionCallArguments`); never execute `{}` on bad JSON |
| Reasoning | Preserve verbatim when present; medium-effort captures may emit none |
| Sessions | `schemaVersion: 2`, `provider: "codex"`, field `items` |
| Old sessions | Clean break — reject resume, leave file untouched |

## Constructors / extractors

Use `src/runner/items.js` only — do not hand-build wire shapes in `run.js` / pipeline later.

- `userMessage(text)`, `assistantMessage(text)`
- `functionCall({ callId, name, arguments, id? })`
- `functionCallOutput({ callId, output, isError? })`
- `reasoningItem(raw)`, `cloneItem(item)`
- `extractText`, `extractFunctionCalls`, `extractReasoningItems`
- `normalizeUsage(responsesUsage)`

## Session resume

```js
const items = require('./items');
items.assertNativeSession(loaded); // throws SessionSchemaError for v1 / Anthropic shapes
```

Stage 5 wires this into `session-store.js`. New session files use `schemaVersion: 2`, `provider: "codex"`, and
`items[]`; v1 session files fail closed and remain untouched.
