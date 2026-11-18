# Salesforce SOQL Playground

A local workbench for exploring a Salesforce org with SOQL. Browse objects, fields, picklist values, and record types; write queries in a syntax-highlighted editor or describe what you want in plain English; and inspect, filter, and export the results. Built with Node.js, Express, and jsforce, with a dependency-free browser UI.

## Features

- **SOQL editor**: syntax highlighting, line numbers, resizable height, insert-at-cursor from the schema sidebar, `Cmd/Ctrl + Enter` to run, recent queries for the session, and explicit `Cmd/Ctrl + A` select-all handling.
- **Schema sidebar**: a searchable list of queryable objects that drills into the selected object.
  - **Fields** show API name, label, and type, with lookup targets (`→ User`). Click a field to insert its API name.
  - **Picklists** expand to their active values (`picklist · 12 ▸`). Click a value to insert it as a quoted SOQL string. Field search also matches picklist values and shows only the matching ones.
  - **Record types** are listed above the fields with name, DeveloperName, and Id. Click the DeveloperName or Id to insert it quoted, for `RecordType.DeveloperName = …` or `RecordTypeId = …`.
- **AI assistant**: describe the records you want and the selected model writes the SOQL into the editor for you to review. Switch between OpenRouter, Claude Code, GitHub Copilot, OpenAI, Anthropic, and Gemini per query.
- **Results**: table and JSON views, row filter, click-to-copy cells, "Load more" pagination, and CSV or JSON export of all loaded records.
- **Session and settings**: Salesforce org, API version, and token time in the header; one-click token refresh; light and dark themes. The query, selected object, view mode, theme, editor height, and AI provider/model survive a reload.

## Requirements

- Node.js 22+
- pnpm
- Optional, for the local AI providers: [Claude Code](https://claude.com/claude-code) and/or the [GitHub Copilot CLI](https://docs.github.com/copilot/how-tos/use-copilot-agents/use-copilot-cli), installed and signed in.

## Run

```sh
pnpm install
cp .env.example .env   # then fill in Salesforce and AI settings
pnpm dev
```

Open http://localhost:3000. Use `pnpm start` to run without file watching. `PORT` defaults to `3000`, and the server listens on `127.0.0.1` only.

## Scripts

| Script | Command | Purpose |
| --- | --- | --- |
| `pnpm dev` | `node --watch --env-file=.env src/index.js` | Run with file watching |
| `pnpm start` | `node --env-file=.env src/index.js` | Run once |
| `pnpm lint` | `eslint .` | Lint the project |
| `pnpm test` | `node --test` | Run the test suite |

## Salesforce setup

Authentication uses the OAuth **client credentials** flow. In Salesforce, enable **Client Credentials Flow** for the connected or external client app and assign a **Run As** integration user with API access and permission to query the objects you need. Set `SALESFORCE_LOGIN_URL` to your org's My Domain URL (including the sandbox domain when applicable).

| Variable | Purpose |
| --- | --- |
| `SALESFORCE_LOGIN_URL` | My Domain URL (HTTPS required) |
| `SALESFORCE_CLIENT_ID` | Connected app consumer key |
| `SALESFORCE_CLIENT_SECRET` | Connected app consumer secret |
| `SALESFORCE_API_VERSION` | API version, defaults to `66.0` |

Credentials and access tokens stay on the server. Queries run with the integration user's permissions, and only a single SOQL `SELECT` is accepted. Use **Refresh token** in the header to request a new access token; a failed refresh keeps the previous session, and expired sessions reauthorize automatically.

## AI query assistant

Type a request in the amber prompt above the editor and choose **Write SOQL**. The server sends the model:

- your request and the current editor contents,
- the org's queryable object names (up to 500), and
- the fields of the object selected in the sidebar, or one inferred from your request (up to 400 fields).

No record data is sent. Picklist values and record types are not included in the prompt.

The answer is re-validated on the server before it reaches the editor: it must be a single `SELECT` with one top-level `LIMIT` between 1 and 200. If the model says the schema cannot answer the request, its explanation is shown instead of a query.

A typical request with an object selected is roughly 3,000 to 15,000 input tokens, mostly the schema, and about 100 output tokens.

### Providers

Configure one or more providers in `.env`, then restart:

| Provider | Enable with | Default model | Model list |
| --- | --- | --- | --- |
| OpenAI | `OPENAI_API_KEY` | `gpt-4o-mini` | Default model only |
| OpenRouter | `OPEN_ROUTER_API_KEY` | `openai/gpt-4o-mini` | Live catalog with context size and pricing |
| Anthropic API | `ANTHROPIC_API_KEY` | `claude-sonnet-5-5` | Default model only |
| Google Gemini | `GOOGLE_API_KEY` | `gemini-2.0-flash` | Default model only |
| Claude Code (local) | `CLAUDE_CODE_ENABLED=true` | `sonnet` | `sonnet`, `opus`, `haiku` |
| GitHub Copilot (local) | `COPILOT_ENABLED=true` | `auto` | Models from your Copilot plan |

Every configured provider appears in the provider dropdown under the prompt, so you can switch per query. The browser remembers the provider and the model you chose for each one.

- `LLM_PROVIDER` picks the default provider. Without it, the first configured provider in the table order is the default.
- `LLM_MODEL` and `LLM_BASE_URL` apply **only to the default provider**, so an OpenRouter model ID is never sent to another provider.

Example: OpenRouter by default, with both local CLIs one click away:

```sh
OPEN_ROUTER_API_KEY=sk-or-...
LLM_PROVIDER=openrouter
LLM_MODEL=openai/gpt-4o-mini
CLAUDE_CODE_ENABLED=true
COPILOT_ENABLED=true
```

### Claude Code (local)

The `claude-code` provider runs the Claude Code CLI in headless mode (`claude -p`) with your Claude Code login. It needs no API key and counts against your Claude Code plan.

- **Local only:** it works only where the server runs on a machine with `claude` installed and logged in. Leave it disabled on shared or deployed servers.
- **Locked down:** each call runs with no tools, no MCP servers, no settings, skills, or slash commands, and no saved session, in a temp directory. Server secrets (including `ANTHROPIC_API_KEY`, so your login is used) are removed from its environment.
- **Speed:** about 2 to 4 seconds per query; calls time out after 120 seconds.

| Variable | Purpose |
| --- | --- |
| `CLAUDE_CODE_ENABLED` | `true` to offer the provider |
| `CLAUDE_CODE_MODEL` | Default model: `sonnet`, `opus`, `haiku`, or a full model ID |
| `CLAUDE_CODE_PATH` | Path to the `claude` binary if it is not on `PATH` |

### GitHub Copilot (local)

The `copilot` provider runs the GitHub Copilot CLI in non-interactive mode (`copilot -p`) with your Copilot login (`copilot login`). It needs no API key; each query uses Copilot premium requests according to the model you pick.

- **Local only:** it works only where the server runs on a machine with `copilot` installed and signed in.
- **Locked down:** every built-in tool is excluded, built-in MCP servers and repository instructions are off, and each call runs in a new empty temp directory that is deleted afterwards. The app never passes `--allow-all`, and it removes `COPILOT_ALLOW_ALL` and server secrets from the CLI's environment.
- **Models:** the dropdown lists the model IDs from `copilot help config` (for example `claude-sonnet-5.5`, `gpt-6.1-sol`) plus `auto`. A model your plan cannot use fails with Copilot's own error message.
- **Speed:** about 10 to 20 seconds per query; calls time out after 180 seconds. Copilot has no system-prompt flag, so the instructions and your request are sent as one prompt.
- **Sessions:** Copilot keeps its own local session history in `~/.copilot`; the app cannot turn that off.

| Variable | Purpose |
| --- | --- |
| `COPILOT_ENABLED` | `true` to offer the provider |
| `COPILOT_MODEL` | Default model: `auto` or a Copilot model ID |
| `COPILOT_PATH` | Path to the `copilot` binary if it is not on `PATH` |

### Security notes

- API keys stay on the server; the browser only receives provider names and model metadata.
- The schema and your request go to whichever provider you pick (see the list above). Choose a provider your organization allows for Salesforce metadata.
- `POST /api/ai/query` accepts an optional `provider` and `model`. An unknown provider or a model that does not belong to it is rejected with `400`.
- `GET /api/ai/models` caches the OpenRouter catalog for 10 minutes and the Copilot model list for an hour.
- Set `OPENROUTER_SITE_URL` and `OPENROUTER_APP_NAME` to customize the attribution headers sent to OpenRouter.

## API reference

All endpoints are prefixed with `/api` and return JSON. Errors are `{ error, code }`.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/status` | Salesforce session status (org, API version, auth time) |
| `POST` | `/api/auth/refresh` | Request a new Salesforce access token |
| `GET` | `/api/objects` | List queryable objects (`name`, `label`) |
| `GET` | `/api/objects/:name` | Describe an object's fields (with active picklist values) and record types |
| `GET` | `/api/ai/status` | Default AI provider plus every configured provider |
| `GET` | `/api/ai/models?provider=` | List selectable models for a provider (default if omitted) |
| `POST` | `/api/ai/query` | Write a SOQL query from a plain-English request |
| `POST` | `/api/query` | Run a read-only SOQL query or fetch the next page |

`POST /api/ai/query` status codes:

| Status | Code | Meaning |
| --- | --- | --- |
| `200` | | `{ query, explanation }` |
| `400` | | Invalid request, provider, or model |
| `422` | `AI_DECLINED` | The model could not answer from the schema; `error` holds its explanation |
| `502` | `INVALID_SOQL` | The model's output was not a safe, valid `SELECT` |
| `502` | `LLM_ERROR` | The provider or CLI failed (message included) |
| `503` | `LLM_NOT_CONFIGURED` | No AI provider is configured |

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| "Could not find the Claude Code CLI" or "…GitHub Copilot CLI" | Set `CLAUDE_CODE_PATH` or `COPILOT_PATH` to the full binary path. The server only sees the `PATH` of the shell that started it. |
| Claude Code fails with "Not logged in" | Run `claude` once and log in. |
| Copilot fails with "Model … is not available" | Pick another model or `auto`; your Copilot plan decides which models you can use. |
| The AI says it needs more schema | Select the relevant object in the sidebar first, so its fields are included, or try a stronger model. |
| A provider is missing from the dropdown | Check its key or `*_ENABLED` flag in `.env`, then restart the server. |

## Project structure

```
src/
  index.js          # HTTP entry point; starts Express on 127.0.0.1
  app.js            # Express app: routes, validation, schema shaping, static files
  salesforce.js     # jsforce connection, caching, token refresh
  llm.js            # Multi-provider LLM client: HTTP APIs + local Claude Code / Copilot CLIs
  soql-assistant.js # Prompt building and SOQL output validation
  *.test.js         # Node test runner suites
public/
  index.html        # Single-page UI
  app.js            # Client logic: sidebar, editor highlighting, AI, results, persistence
  styles.css        # Design tokens and component styles (light and dark)
```

The UI loads IBM Plex Sans and IBM Plex Mono from Google Fonts and falls back to system fonts offline. Everything else is served locally.

## Checks

```sh
pnpm lint
pnpm test
```

See [AGENTS.md](AGENTS.md) for architecture notes and conventions for AI coding agents.
