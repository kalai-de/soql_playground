# Salesforce SOQL Playground

A small Node.js app built with Express and jsforce. It ships a SOQL editor (line numbers, keyboard shortcuts, resizable), a searchable schema explorer, a results table with JSON view, an AI assistant that turns a plain-English question into a SOQL query, and more.

## Features

- **SOQL editor** — syntax highlighting, line numbers, resizable height, field insertion at the cursor, `Cmd/Ctrl + Enter` to run, and explicit `Cmd/Ctrl + A` select-all handling.
- **Schema explorer** — a full-height, searchable object list that drills into fields (with labels, types, and lookup targets). Click a field to insert its API name. Picklist fields expand to show their active values; click one to insert it as a quoted SOQL string. Field search also matches picklist values. Objects with record types list them above the fields (name, DeveloperName, Id); click the DeveloperName or Id to insert it quoted, for `RecordType.DeveloperName = …` or `RecordTypeId = …`.
- **Results** — table and JSON views, filter loaded records, click-to-copy cells, pagination via "Load more", and CSV or JSON export of all loaded records.
- **AI assistant** — describe the records you want and the server asks the selected model for a SOQL query, then drops it into the editor for review. Switch between providers (OpenRouter, Claude Code, GitHub Copilot, OpenAI, Anthropic, Gemini) per query.
- **Session controls** — refresh the Salesforce token from the UI, dark/light theme, and auto-dismissing toasts.
- **Persistence** — query, selected object, view mode, theme, editor height, and AI provider/model selection survive a page reload.

## Requirements

- Node.js 22+
- pnpm

## Run

```sh
pnpm install
pnpm dev
```

Open http://localhost:3000. Use `pnpm start` to run without file watching.

The existing `.env` loads automatically. See `.env.example` for supported variables. `PORT` defaults to `3000`.

## Scripts

| Script | Command | Purpose |
| --- | --- | --- |
| `pnpm dev` | `node --watch --env-file=.env src/index.js` | Run with file watching |
| `pnpm start` | `node --env-file=.env src/index.js` | Run once |
| `pnpm lint` | `eslint .` | Lint the project |
| `pnpm test` | `node --test` | Run the test suite |

## Salesforce setup

Authentication uses the OAuth **client credentials** flow. In Salesforce, enable **Client Credentials Flow** for the connected/external client app and assign a **Run As** integration user with API access and permission to query the desired objects. Set `SALESFORCE_LOGIN_URL` to your org's My Domain URL (including its sandbox domain when applicable).

| Variable | Purpose |
| --- | --- |
| `SALESFORCE_LOGIN_URL` | My Domain URL (HTTPS required) |
| `SALESFORCE_CLIENT_ID` | Connected app consumer key |
| `SALESFORCE_CLIENT_SECRET` | Connected app consumer secret |
| `SALESFORCE_API_VERSION` | API version, defaults to `66.0` |

Credentials and access tokens stay on the server. The app listens on localhost and runs queries with the integration user's permissions. Only SOQL `SELECT` queries are accepted. Loading more records appends Salesforce's next page; export includes all loaded records.

Use **Refresh token** in the header to request a new access token. The UI shows the org, API version, and token issue time. A failed authorization retains the previous server session, and expired sessions trigger automatic reauthorization. Recent queries are kept in memory for the current page session.

## AI query assistant

Type a question in **Ask AI to build a query**; the server asks the selected model for a SOQL query and puts the result into the editor for you to review and run. The prompt includes the org's queryable object names plus the fields of the object currently selected in the schema explorer (or one inferred from your question), which keeps API names accurate. Generated queries are re-validated on the server: a single `SELECT` with a top-level `LIMIT` between 1 and 200, otherwise rejected.

### Providers

Configure one or more providers in `.env`, then restart:

| Provider | Enable with | Default model | Model picker |
| --- | --- | --- | --- |
| OpenAI | `OPENAI_API_KEY` | `gpt-4o-mini` | Default model only |
| OpenRouter | `OPEN_ROUTER_API_KEY` | `openai/gpt-4o-mini` | Live catalog with context size and pricing |
| Anthropic API | `ANTHROPIC_API_KEY` | `claude-sonnet-5-5` | Default model only |
| Google Gemini | `GOOGLE_API_KEY` | `gemini-2.0-flash` | Default model only |
| Claude Code (local) | `CLAUDE_CODE_ENABLED=true` | `sonnet` | `sonnet`, `opus`, `haiku` |
| GitHub Copilot (local) | `COPILOT_ENABLED=true` | `auto` | Models from your Copilot plan |

Every configured provider appears in the panel's **Provider** dropdown, so you can switch between them (for example OpenRouter and Claude Code) per query. The provider and the model chosen for each provider are remembered in the browser.

- `LLM_PROVIDER` picks the default provider. Without it, the first configured provider in the table order is the default.
- `LLM_MODEL` and `LLM_BASE_URL` apply **only to the default provider**, so an OpenRouter model ID is never sent to another provider.

Example: OpenRouter by default, with Claude Code one click away:

```sh
OPEN_ROUTER_API_KEY=sk-or-...
LLM_PROVIDER=openrouter
LLM_MODEL=openai/gpt-4o-mini
CLAUDE_CODE_ENABLED=true
```

### Claude Code (local)

The `claude-code` provider runs the [Claude Code](https://claude.com/claude-code) CLI in headless mode (`claude -p`) using your Claude Code login. It needs no API key and counts against your Claude Code plan.

- **Local only:** it works only where the server runs on a machine with `claude` installed and logged in. Leave it disabled on shared or deployed servers.
- **Locked down:** each call runs with no tools, no MCP servers, no settings, skills, or slash commands, no saved session, and in a temp directory. Server secrets (including `ANTHROPIC_API_KEY`, so your login is used) are removed from its environment.
- **Slower:** expect a few extra seconds per query for CLI startup; calls time out after 120 seconds.

| Variable | Purpose |
| --- | --- |
| `CLAUDE_CODE_ENABLED` | `true` to offer the provider |
| `CLAUDE_CODE_MODEL` | Default model: `sonnet`, `opus`, `haiku`, or a full model ID |
| `CLAUDE_CODE_PATH` | Path to the `claude` binary if it is not on `PATH` |

### GitHub Copilot (local)

The `copilot` provider runs the [GitHub Copilot CLI](https://docs.github.com/copilot/how-tos/use-copilot-agents/use-copilot-cli) in non-interactive mode (`copilot -p`) using your Copilot login (`copilot login`). It needs no API key; each query uses Copilot premium requests according to the model you pick.

- **Local only:** it works only where the server runs on a machine with `copilot` installed and signed in.
- **Locked down:** every built-in tool is excluded (`--excluded-tools`), built-in MCP servers and repository instructions are off, and each call runs in a new empty temp directory that is deleted afterwards. Non-interactive mode also denies any tool request that is not explicitly allowed, and the app never passes `--allow-all`. `COPILOT_ALLOW_ALL` and server secrets are removed from its environment.
- **Models:** the dropdown lists the model IDs from `copilot help config` (for example `claude-sonnet-5.5`, `gpt-6.1-sol`), plus `auto`. Models your plan cannot use fail with Copilot's own error message.
- **Slower:** expect roughly 10–20 seconds per query; calls time out after 180 seconds. Copilot has no system-prompt flag, so the instructions and your request are sent as one prompt.
- **Sessions:** Copilot keeps its own local session history in `~/.copilot`; the app cannot turn that off.

| Variable | Purpose |
| --- | --- |
| `COPILOT_ENABLED` | `true` to offer the provider |
| `COPILOT_MODEL` | Default model: `auto` or a Copilot model ID |
| `COPILOT_PATH` | Path to the `copilot` binary if it is not on `PATH` |

### Security notes

API keys stay on the server; the browser only receives provider names and model metadata. `GET /api/ai/models` caches the OpenRouter catalog for 10 minutes. `POST /api/ai/query` accepts an optional `provider` and `model`; a model that does not belong to the provider is rejected with `400`. With no provider configured, the panel shows a hint and the endpoint returns `503`. Set `OPENROUTER_SITE_URL` and `OPENROUTER_APP_NAME` to customize the attribution headers sent to OpenRouter.

## API reference

All endpoints are prefixed with `/api` and return JSON.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/status` | Salesforce session status (org, API version, auth time) |
| `POST` | `/api/auth/refresh` | Request a new Salesforce access token |
| `GET` | `/api/objects` | List queryable objects (`name`, `label`) |
| `GET` | `/api/objects/:name` | Describe an object's fields (with active picklist values) and record types |
| `GET` | `/api/ai/status` | Default AI provider plus every configured provider |
| `GET` | `/api/ai/models?provider=` | List selectable models for a provider (default if omitted) |
| `POST` | `/api/ai/query` | Build a SOQL query from a natural-language question |
| `POST` | `/api/query` | Run a read-only SOQL query or fetch the next page |

## Project structure

```
src/
  index.js          # HTTP entry point; starts Express on 127.0.0.1
  app.js            # Express app: routes, validation, static files
  salesforce.js     # jsforce connection, caching, token refresh
  llm.js            # Multi-provider LLM client (HTTP APIs + local Claude Code / Copilot CLIs), model catalogs
  soql-assistant.js # Prompt building and SOQL output validation
  *.test.js         # Node test runner suites
public/
  index.html        # Single-page UI
  app.js            # Client logic (state, fetch, rendering, persistence)
  styles.css        # Design tokens and component styles
```

## Checks

```sh
pnpm lint
pnpm test
```

See [AGENTS.md](AGENTS.md) for architecture notes and conventions used by AI coding agents.
