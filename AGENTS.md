# Agent Guide

Guidance for AI coding agents working in this repository. Read this before making changes.

## Project overview

Salesforce SOQL Playground: a small, dependency-light Node.js app. The server exposes a JSON API backed by jsforce, and the client is a single-page vanilla-JS UI served statically. There is no build step, no bundler, and no TypeScript.

- Runtime: Node.js 22+, ES modules (`"type": "module"`).
- Server: Express 5.
- Salesforce: jsforce 3.x via the OAuth client credentials flow.
- Package manager: **pnpm** (do not use npm or yarn; never commit `package-lock.json`).

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
  app.js            # createApp(): routes, input validation, static serving, error handler.
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
4. For AI routes, `app.js` resolves the requested provider, validates the model for it, gathers schema context, calls `soql-assistant.js`, then re-validates the generated query before returning it.

`createApp()` takes injectable dependencies (`run`, `refresh`, `assist`, `getModels`) so tests can stub Salesforce and the LLM. `getModels` receives the provider name.

### AI providers

Providers live in the `PROVIDERS` map in `llm.js`. Several can be configured at once; the UI lets the user pick one per query.

- `getLlmConfig(name?)` resolves one provider (the default when `name` is omitted) or returns `null` if it is unknown or not configured. `listLlmProviders()` lists configured providers, default first, with no secrets.
- The default is `LLM_PROVIDER` when usable, otherwise the first configured provider in map order. `LLM_MODEL` and `LLM_BASE_URL` apply only to the default provider.
- `isAllowedModel(config, model)` is the single model check: OpenRouter accepts any valid `vendor/model` ID; other providers accept only their fixed catalog (`fixedModels()`).
- HTTP providers go through `buildRequest()` + `fetch`. Local CLI providers are listed in `CLI_PROVIDERS` (enabled by `<PREFIX>_ENABLED`, with `<PREFIX>_PATH` / `<PREFIX>_MODEL`) and spawn through `runCli()` with `execFile` (no shell) and the scrubbed `cliEnv()`.
  - `claude-code` → `runClaudeCode()`: `claude -p --output-format json`, user prompt on stdin, reads `result`.
  - `copilot` → `runCopilot()`: `copilot -C <fresh temp dir> -p <system + user> --output-format json`, reads the last `assistant.message` from the JSONL events, deletes the temp dir. Copilot has no system-prompt flag. Its model list is parsed from `copilot help config` and cached for an hour; `isAllowedModel()` only enforces the ID shape (`COPILOT_MODEL_ID`) and the CLI rejects unavailable models.
- To add a provider: add it to `PROVIDERS` and `PROVIDER_LABELS`, handle its `kind` in `buildRequest()` (or a dedicated runner), and add tests.

### API contract for AI routes

- `GET /api/ai/status` → `{ configured, provider, model, providers: [{ name, label, model, default }] }`.
- `GET /api/ai/models?provider=<name>` → `{ provider, defaultModel, models }`.
- `POST /api/ai/query` body `{ question, object?, previousQuery?, provider?, model? }`. Unknown or unconfigured provider, or a model not allowed for it → `400`; nothing configured → `503` with `code: 'LLM_NOT_CONFIGURED'`. When the model deliberately returns an empty query, the route answers `422` with `code: 'AI_DECLINED'` and the model's explanation as `error`; unsafe or invalid output stays `502` `INVALID_SOQL`.
- `GET /api/objects/:name` fields carry `picklistValues: [{ value, label, default? }]` (active values only) for `picklist` and `multipicklist` fields. The response also has `recordTypes: [{ id, name, developerName, active, default? }]`, excluding the synthetic Master record type; inactive ones are kept because existing records can still use them. The AI prompt includes neither.

## Conventions

- ES modules only: `import`/`export`, no `require`.
- Keep the codebase dependency-light. Prefer Web/Node built-ins (`fetch`, `node:test`, `node:url`) over new packages.
- Server code stays in `src/`; browser code stays in `public/`. Never import server modules into the client.
- Client DOM lookups use the `$` id helper; state that should survive reloads goes through `localStorage` with the `soql.` prefix (AI choices use `soql.aiProvider` and `soql.aiModel:<provider>`).
- Style the UI with the shared CSS custom-property tokens in `styles.css` so both dark and light themes stay consistent. Teal (`--accent`) marks actions; amber (`--ai`) marks anything AI-related; `--tok-*` tokens color both editor syntax and schema metadata.
- The editor is a transparent `<textarea>` over a `<pre id="highlight">` layer. Both must keep identical font, size, line-height, padding, and `white-space: pre`, and scroll together (`syncEditorScroll()`), or the caret drifts from the text.
- Errors from the API are JSON `{ error, code }`. Do not leak Salesforce connection details, requests, or credentials in error messages.
- Keep the editor read-only-safe: enforced query validation lives in `soql-assistant.js` (`normalizeReadOnlyQuery`, `normalizeGeneratedQuery`).

## Hard constraints

- **Do not remove the explicit `Cmd/Ctrl + A` keyboard handling on the editor.** Native select-all can be swallowed inside IDE-embedded previews, so the `keydown` handler and propagation stop must stay.
- **Only read-only SOQL is allowed.** Reject anything that is not a single `SELECT`. Never add DML paths.
- **AI-generated queries must keep a top-level `LIMIT` between 1 and 200** and are re-validated server-side; do not relax this.
- **API keys never reach the browser.** Only provider name and model metadata are exposed.
- **Claude Code runs locked down.** The prompt contains untrusted text (the user's question and Salesforce labels), so `runClaudeCode()` must keep `--tools ""`, `--strict-mcp-config`, `--setting-sources ""`, `--disable-slash-commands`, and `--no-session-persistence`, run in `os.tmpdir()`, and strip secrets from the child env (`claudeCodeEnv()`). Never add `--dangerously-skip-permissions`, tools, or a shell. Model values passed as CLI args must come from the fixed allow-list.
- **Copilot runs locked down.** `runCopilot()` must keep `--excluded-tools=<COPILOT_TOOLS>`, `--disable-builtin-mcps`, `--no-custom-instructions`, `--no-ask-user`, `--disallow-temp-dir`, and the fresh temp working directory. Never pass `--allow-all`, `--allow-all-tools`, `--allow-tool`, `--yolo`, or `--autopilot`, and keep stripping `COPILOT_ALLOW_ALL` / `COPILOT_ASSISTED_APPROVAL` from its env. When the CLI adds tools, add them to `COPILOT_TOOLS`.
- **Local CLI providers are opt-in.** Claude Code and Copilot are enabled only by `CLAUDE_CODE_ENABLED` / `COPILOT_ENABLED`; never auto-enable them by detecting the binary.
- **Redact secrets in errors.** `llm.js` strips the API key from upstream error summaries; preserve that behavior.

## Environment variables

See `.env.example`. Salesforce: `SALESFORCE_LOGIN_URL`, `SALESFORCE_CLIENT_ID`, `SALESFORCE_CLIENT_SECRET`, `SALESFORCE_API_VERSION`, `PORT`. AI: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, `OPEN_ROUTER_API_KEY`, `LLM_PROVIDER`, `LLM_MODEL`, `LLM_BASE_URL`, `OPENROUTER_SITE_URL`, `OPENROUTER_APP_NAME`, `CLAUDE_CODE_ENABLED`, `CLAUDE_CODE_MODEL`, `CLAUDE_CODE_PATH`, `COPILOT_ENABLED`, `COPILOT_MODEL`, `COPILOT_PATH`. Never hardcode or commit real credentials.

## Testing

- Tests use the built-in `node:test` runner with `node:assert/strict`; one `*.test.js` per module.
- API tests spin up the app with injected stubs via a `serve()` helper; LLM tests point the client at a local stub server.
- CLI provider tests never call the real CLIs: `fakeClaude()` / `fakeCopilot()` in `llm.test.js` write stand-in executables and points `CLAUDE_CODE_PATH` at it, then asserts on the args, stdin, cwd, and env it received.
- Tests that touch provider config must clear and restore every LLM env var, including `CLAUDE_CODE_*` and `COPILOT_*` (see `KEYS` / `LLM_KEYS`).
- Add a test when changing validation, routing, or provider behavior. Run `pnpm test` and `pnpm lint` before you finish.
