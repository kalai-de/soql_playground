# Agent Guide

Guidance for AI coding agents working in this repository. Read this before making changes.

## Project overview

Salesforce SOQL Playground: a small, dependency-light Node.js app for exploring a Salesforce org with read-only SOQL. The server exposes a JSON API backed by jsforce and several AI providers; the client is a single-page vanilla-JS UI served statically. There is no build step, no bundler, and no TypeScript.

- Runtime: Node.js 22+, ES modules (`"type": "module"`).
- Server: Express 5.
- Salesforce: jsforce 3.x via the OAuth client credentials flow.
- Package manager: **pnpm** (do not use npm or yarn; never commit `package-lock.json`).
- Repository: GitHub `kalai-de/soql_playground`, default branch `main`.

## Commands

```sh
pnpm install      # install dependencies
pnpm dev          # run with --watch and .env
pnpm start        # run once
pnpm lint         # eslint .
pnpm test         # node --test
```

Before finishing any change, run both `pnpm lint` and `pnpm test` and fix any failures or lint errors.

## Architecture

```
src/
  index.js          # Entry point. Reads PORT, listens on 127.0.0.1.
  app.js            # createApp(): routes, input validation, schema shaping, static serving, error handler.
  salesforce.js     # Connection cache, client-credentials auth, auto-refresh on INVALID_SESSION_ID.
  llm.js            # Multi-provider LLM client: HTTP APIs + local Claude Code / Copilot CLIs, model catalogs.
  soql-assistant.js # Prompt construction and SOQL output validation.
  *.test.js         # Tests, one file per module, using node:test.
public/
  index.html        # Static markup for the whole UI.
  app.js            # Client state, fetch calls, rendering, localStorage persistence.
  styles.css        # Design tokens (CSS custom properties) and component styles.
```

### Request flow

1. Browser calls a `/api/*` endpoint from `public/app.js`.
2. `src/app.js` validates the body, then runs Salesforce work through `withSalesforce()`.
3. `salesforce.js` reuses a cached `Connection` and transparently reauthorizes on expiry.
4. For AI routes, `app.js` resolves the requested provider (`resolveProvider()`), checks the model with `isAllowedModel()`, picks up to `MAX_PROMPT_OBJECTS` (4) objects with `relevantObjects()` and describes them in parallel, calls `suggestQuery()` in `soql-assistant.js`, then re-validates the generated query with `normalizeGeneratedQuery()` before returning it.

`createApp()` takes injectable dependencies (`run`, `refresh`, `assist`, `getModels`) so tests can stub Salesforce and the LLM. `getModels` receives the provider name.

### Schema shaping

`describeFields()` in `app.js` turns a jsforce describe into `{ name, recordTypes, fields }`. The same shape feeds both `GET /api/objects/:name` and the AI prompt, but `buildPrompt()` only uses field name, label, type, relationship, references, and filterability.

AI prompt context:

- `relevantObjects()` orders candidates as: sidebar selection, objects the request names (`mentionedObjects()`: API name or label, simple plurals, longest match first, skipping `GENERIC_OBJECT_TERMS` such as "name"), then objects in the editor's `FROM` clauses. It keeps the first 4.
- The route sends `objectSchemas` (each `describeFields()` plus `childRelationships()`) and `objectFields` (the first schema, kept for older callers).
- `buildPrompt()` labels the first schema "Primary" (up to `MAX_SCHEMA_FIELDS`, 400) and the rest "Related" (up to `MAX_RELATED_FIELDS`, 150), and lists up to `MAX_CHILD_RELATIONSHIPS` (60) child relationships per object, custom `__r` ones first. Keep these caps: they bound the prompt's token cost.

- `picklistValues()` keeps active values only, as `{ value, label, default? }`, for `picklist` and `multipicklist` fields. The key is omitted for other types.
- `recordTypes()` drops the synthetic Master record type, keeps inactive ones (existing records can still use them), and sorts active first, then by name.

### AI providers

Providers live in the `PROVIDERS` map in `llm.js`, with display names in `PROVIDER_LABELS`. Several can be configured at once; the UI lets the user pick one per query.

- `getLlmConfig(name?)` resolves one provider (the default when `name` is omitted) or returns `null` if it is unknown or not configured. `listLlmProviders()` lists configured providers, default first, with no secrets.
- The default is `LLM_PROVIDER` when usable, otherwise the first configured provider in map order. `LLM_MODEL` and `LLM_BASE_URL` apply only to the default provider.
- `isAllowedModel(config, model)` is the single model check:
  - OpenRouter: any valid `vendor/model` ID (`isValidModelId()`).
  - Copilot: the ID shape `COPILOT_MODEL_ID` (lowercase, never starting with `-`); the CLI rejects models the plan cannot use.
  - Everyone else: only their fixed catalog (`fixedModels()`).
- HTTP providers go through `buildRequest()` and `fetch`, with the API key redacted from error summaries (`summarize()`).
- Local CLI providers are listed in `CLI_PROVIDERS` (enabled by `<PREFIX>_ENABLED`, configured by `<PREFIX>_PATH` and `<PREFIX>_MODEL`). They spawn through `runCli()` with `execFile` (never a shell) and the scrubbed `cliEnv()`; failures go through `cliFailure()`.
  - `claude-code` → `runClaudeCode()`: `claude -p --output-format json`, system prompt as a flag, user prompt on stdin, reads `result`.
  - `copilot` → `runCopilot()`: `copilot -C <fresh mkdtemp dir> -p <system + user> --output-format json`, reads the last `assistant.message` from the JSONL events, then deletes the temp dir. Copilot has no system-prompt flag. `copilotModels()` parses `copilot help config` and caches the list for an hour.
- To add an HTTP provider: add it to `PROVIDERS` and `PROVIDER_LABELS`, handle its `kind` in `buildRequest()`, and add a stub-server test.
- To add a CLI provider: also add it to `CLI_PROVIDERS`, write a locked-down runner, add its env names to the `cliEnv()` scrub list, add its name to the `localLogin` map in `updateAiModelMeta()` (client), test it with a stand-in executable, and document its lockdown below and in the README.

### AI answers

`suggestQuery()` parses the model's JSON (or falls back to a bare `SELECT`) and returns `{ query, explanation }`. When the model deliberately returns an empty query, it returns `declined: true` and the route answers `422 AI_DECLINED` with the explanation, which the client shows as a normal answer rather than an error.

### API contract for AI routes

- `GET /api/ai/status` → `{ configured, provider, model, providers: [{ name, label, model, default }] }`.
- `GET /api/ai/models?provider=<name>` → `{ provider, defaultModel, models }`.
- `POST /api/ai/query` body `{ question, object?, previousQuery?, provider?, model? }`.
  - Unknown or unconfigured provider, or a model not allowed for it → `400`.
  - Nothing configured → `503 LLM_NOT_CONFIGURED`.
  - Model declined → `422 AI_DECLINED`.
  - Unsafe or invalid output → `502 INVALID_SOQL`; provider or CLI failure → `502 LLM_ERROR`.

### Client (`public/app.js`)

- **Sidebar:** `renderObjects()` and `selectObject()` drive the object list; `describeObject()` loads fields; `renderFields()` builds rows with `fieldButton()`, `picklistBlock()`, and `renderRecordTypes()`. Clicks call `insertField()`, which inserts at the cursor. String values go through `soqlString()` for SOQL escaping.
- **Editor:** `highlightSoql()` tokenizes into the `<pre id="highlight">` layer; `updateEditor()` re-renders it on every input.
- **AI:** `loadAiStatus()`, `loadAiModels()`, and `askAi()`; `updateAiModelMeta()` shows pricing for OpenRouter and a login note for local CLIs.
- **Results:** `runQuery()`, `renderResult()`, `flatten()` for nested relationship fields, and `toCsv()` / `saveFile()` for export.

## Conventions

- ES modules only: `import`/`export`, no `require`.
- Keep the codebase dependency-light. Prefer Web/Node built-ins (`fetch`, `node:test`, `node:child_process`) over new packages. The only external resource is the Google Fonts stylesheet; do not add other CDNs.
- Server code stays in `src/`; browser code stays in `public/`. Never import server modules into the client.
- Client DOM lookups use the `$` id helper. State that should survive reloads goes through the `storage` helper (`localStorage` with the `soql.` prefix): `query`, `object`, `format`, `theme`, `editorHeight`, `recordTypesOpen`, `aiProvider`, and `aiModel:<provider>`.
- Build DOM with `textContent` and `createElement`. The only `innerHTML` uses are the highlight layer and field names, both passed through `escapeHtml()` first; keep it that way, because org metadata is untrusted.
- Style the UI with the shared CSS custom-property tokens in `styles.css` so light and dark themes stay consistent. Teal (`--accent`) marks actions; amber (`--ai`) marks anything AI-related; `--tok-*` tokens color both editor syntax and schema metadata.
- The editor is a transparent `<textarea>` over a `<pre id="highlight">` layer. Both must keep identical font, size, line-height, padding, and `white-space: pre`, and scroll together (`syncEditorScroll()`), or the caret drifts from the text.
- UI copy is plain, sentence case, and names actions by what they do ("Write SOQL", "Run query", "Export CSV"). No ALL-CAPS labels or decorative arrows.
- Errors from the API are JSON `{ error, code }`. Do not leak Salesforce connection details, requests, or credentials in error messages.
- Keep query validation in `soql-assistant.js` (`normalizeReadOnlyQuery`, `normalizeGeneratedQuery`).

## Hard constraints

- **Do not remove the explicit `Cmd/Ctrl + A` keyboard handling on the editor.** Native select-all can be swallowed inside IDE-embedded previews, so the `keydown` handler and propagation stop must stay.
- **Only read-only SOQL is allowed.** Reject anything that is not a single `SELECT`. Never add DML paths.
- **AI-generated queries must keep a top-level `LIMIT` between 1 and 200** and are re-validated server-side; do not relax this.
- **API keys never reach the browser.** Only provider names and model metadata are exposed.
- **Never send record data to an AI provider.** The prompt carries the request, editor contents, and schema metadata only.
- **Claude Code runs locked down.** The prompt contains untrusted text (the user's request and Salesforce labels), so `runClaudeCode()` must keep `--tools ""`, `--strict-mcp-config`, `--setting-sources ""`, `--disable-slash-commands`, and `--no-session-persistence`, run in `os.tmpdir()`, and use `cliEnv()`. Never add `--dangerously-skip-permissions`, tools, or a shell. Model values come from the fixed allow-list.
- **Copilot runs locked down.** `runCopilot()` must keep `--excluded-tools=<COPILOT_TOOLS>`, `--disable-builtin-mcps`, `--no-custom-instructions`, `--no-ask-user`, `--disallow-temp-dir`, and the fresh temp working directory. Never pass `--allow-all`, `--allow-all-tools`, `--allow-tool`, `--yolo`, or `--autopilot`, and keep stripping `COPILOT_ALLOW_ALL` and `COPILOT_ASSISTED_APPROVAL` in `cliEnv()`. When the CLI adds tools, add them to `COPILOT_TOOLS`.
- **Local CLI providers are opt-in.** Claude Code and Copilot are enabled only by `CLAUDE_CODE_ENABLED` / `COPILOT_ENABLED`; never auto-enable them by detecting the binary.
- **Redact secrets in errors.** `summarize()` strips the API key from upstream error summaries, and `cliEnv()` keeps server secrets away from CLIs; preserve both.
- **Never commit `.env`.** It is git-ignored; only `.env.example` (with empty values) is tracked.

## Environment variables

See `.env.example`.

- Salesforce: `SALESFORCE_LOGIN_URL`, `SALESFORCE_CLIENT_ID`, `SALESFORCE_CLIENT_SECRET`, `SALESFORCE_API_VERSION`, `PORT`.
- HTTP AI providers: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, `OPEN_ROUTER_API_KEY`, `LLM_PROVIDER`, `LLM_MODEL`, `LLM_BASE_URL`, `OPENROUTER_SITE_URL`, `OPENROUTER_APP_NAME`.
- Local CLI providers: `CLAUDE_CODE_ENABLED`, `CLAUDE_CODE_MODEL`, `CLAUDE_CODE_PATH`, `COPILOT_ENABLED`, `COPILOT_MODEL`, `COPILOT_PATH`.

Never hardcode or commit real credentials.

## Testing

- Tests use the built-in `node:test` runner with `node:assert/strict`; one `*.test.js` per module.
- API tests start the app with injected stubs via a `serve()` helper; HTTP provider tests point the client at a local stub server (`providerServer()`).
- CLI provider tests never call the real CLIs. `fakeClaude()` and `fakeCopilot()` in `llm.test.js` write stand-in executables, point `CLAUDE_CODE_PATH` / `COPILOT_PATH` at them, and assert on the arguments, stdin, working directory, and environment they received.
- Tests that touch provider config must clear and restore every LLM env var, including `CLAUDE_CODE_*` and `COPILOT_*` (see `KEYS` in `llm.test.js` and `LLM_KEYS` in `app.test.js`).
- Add a test when changing validation, routing, schema shaping, or provider behavior. Run `pnpm test` and `pnpm lint` before you finish.
