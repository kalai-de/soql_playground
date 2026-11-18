import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TIMEOUT_MS = 45000;
const CLAUDE_CODE_TIMEOUT_MS = 120000;
const COPILOT_TIMEOUT_MS = 180000;
const MODEL_TIMEOUT_MS = 15000;
const MODEL_CACHE_TTL_MS = 10 * 60 * 1000;
const modelCache = new Map();

const PROVIDERS = {
  openai: {
    envKey: 'OPENAI_API_KEY',
    kind: 'openai',
    base: 'https://api.openai.com/v1',
    path: '/chat/completions',
    model: 'gpt-4o-mini',
  },
  openrouter: {
    envKey: 'OPEN_ROUTER_API_KEY',
    kind: 'openai',
    base: 'https://openrouter.ai/api/v1',
    path: '/chat/completions',
    model: 'openai/gpt-4o-mini',
  },
  anthropic: {
    envKey: 'ANTHROPIC_API_KEY',
    kind: 'anthropic',
    base: 'https://api.anthropic.com/v1',
    path: '/messages',
    model: 'claude-sonnet-5-5',
  },
  gemini: {
    envKey: 'GOOGLE_API_KEY',
    kind: 'gemini',
    base: 'https://generativelanguage.googleapis.com/v1beta/models',
    model: 'gemini-2.0-flash',
  },
  // Local only: runs the `claude` CLI in headless mode with your Claude Code login.
  'claude-code': {
    kind: 'claude-code',
    model: 'sonnet',
  },
  // Local only: runs the GitHub Copilot CLI (`copilot -p`) with your Copilot login.
  copilot: {
    kind: 'copilot',
    model: 'auto',
  },
};

/** Local CLI providers: enabled by a flag, configured by <PREFIX>_PATH / <PREFIX>_MODEL. */
const CLI_PROVIDERS = {
  'claude-code': { envPrefix: 'CLAUDE_CODE', command: 'claude' },
  copilot: { envPrefix: 'COPILOT', command: 'copilot' },
};

const PROVIDER_LABELS = {
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
  anthropic: 'Anthropic API',
  gemini: 'Gemini',
  'claude-code': 'Claude Code (local)',
  copilot: 'GitHub Copilot (local)',
};

const CLAUDE_CODE_MODELS = [
  { id: 'sonnet', name: 'Claude Sonnet (latest)' },
  { id: 'opus', name: 'Claude Opus (latest)' },
  { id: 'haiku', name: 'Claude Haiku (latest)' },
];

function llmError(message) {
  const error = new Error(message);
  error.errorCode = 'LLM_ERROR';
  return error;
}

export function isValidModelId(value) {
  return typeof value === 'string' &&
    value.length >= 3 &&
    value.length <= 200 &&
    value.includes('/') &&
    /^[A-Za-z0-9][A-Za-z0-9._:/-]+$/.test(value);
}

function summarize(body, apiKey) {
  let message;
  try {
    const parsed = JSON.parse(body);
    message = parsed.error?.message || parsed.message || '';
  } catch {
    message = typeof body === 'string' ? body : '';
  }
  const normalized = message.replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  const redacted = apiKey ? normalized.replaceAll(apiKey, '[redacted]') : normalized;
  return `: ${redacted.slice(0, 240)}`;
}

function isEnabled(value) {
  return /^(1|true|yes|on)$/i.test(value?.trim() || '');
}

function isAvailable(name) {
  if (typeof name !== 'string' || !Object.hasOwn(PROVIDERS, name)) return false;
  const provider = PROVIDERS[name];
  if (CLI_PROVIDERS[name]) return isEnabled(process.env[`${CLI_PROVIDERS[name].envPrefix}_ENABLED`]);
  return Boolean(process.env[provider.envKey]?.trim());
}

/** The provider used when a request does not pick one: LLM_PROVIDER if usable, else the first available. */
function defaultProviderName() {
  const requested = (process.env.LLM_PROVIDER || '').trim().toLowerCase();
  if (isAvailable(requested)) return requested;
  return Object.keys(PROVIDERS).find(isAvailable) || null;
}

/**
 * Resolve a provider's configuration. Without a name, the default provider is
 * returned. LLM_MODEL and LLM_BASE_URL apply only to the default provider so
 * that, for example, an OpenRouter model ID is never sent to Claude Code.
 * Returns null when the provider is unknown or not configured.
 */
export function getLlmConfig(name) {
  const fallback = defaultProviderName();
  const resolved = name === undefined ? fallback : String(name).trim().toLowerCase();
  if (!resolved || !isAvailable(resolved)) return null;
  const provider = PROVIDERS[resolved];
  const isDefault = resolved === fallback;
  const envModel = isDefault ? process.env.LLM_MODEL?.trim() : '';

  const cli = CLI_PROVIDERS[resolved];
  if (cli) {
    return {
      name: resolved,
      label: PROVIDER_LABELS[resolved],
      kind: provider.kind,
      command: process.env[`${cli.envPrefix}_PATH`]?.trim() || cli.command,
      model: process.env[`${cli.envPrefix}_MODEL`]?.trim() || envModel || provider.model,
      apiKey: '',
    };
  }
  const envBase = isDefault ? process.env.LLM_BASE_URL?.trim() : '';
  return {
    name: resolved,
    label: PROVIDER_LABELS[resolved],
    kind: provider.kind,
    path: provider.path,
    base: (envBase || provider.base).replace(/\/+$/, ''),
    apiKey: process.env[provider.envKey].trim(),
    model: envModel || provider.model,
  };
}

/** Every configured provider, default first, safe to send to the browser. */
export function listLlmProviders() {
  const fallback = defaultProviderName();
  return Object.keys(PROVIDERS)
    .filter(isAvailable)
    .sort((a, b) => (b === fallback) - (a === fallback))
    .map((name) => {
      const config = getLlmConfig(name);
      return { name, label: config.label, model: config.model, default: name === fallback };
    });
}

/** Models a fixed-catalog provider accepts (everything except OpenRouter). */
function fixedModels(config) {
  if (config.kind !== 'claude-code') return [{ id: config.model, name: config.model }];
  return CLAUDE_CODE_MODELS.some((model) => model.id === config.model)
    ? CLAUDE_CODE_MODELS
    : [{ id: config.model, name: config.model }, ...CLAUDE_CODE_MODELS];
}

/**
 * Copilot model IDs look like `claude-sonnet-5.5` or `gpt-6.1-sol`. The CLI rejects
 * IDs your plan cannot use; this check only keeps the argument well-formed (it
 * can never start with "-", so it cannot be read as a flag).
 */
const COPILOT_MODEL_ID = /^[a-z][a-z0-9.-]{0,63}$/;

/** Whether a client-selected model may be used with the given provider config. */
export function isAllowedModel(config, model) {
  if (typeof model !== 'string') return false;
  if (config.name === 'openrouter') return isValidModelId(model);
  if (config.kind === 'copilot') return COPILOT_MODEL_ID.test(model);
  return fixedModels(config).some((entry) => entry.id === model);
}

function openAiHeaders(config) {
  const headers = { Authorization: `Bearer ${config.apiKey}` };
  if (config.name === 'openrouter') {
    headers['HTTP-Referer'] = process.env.OPENROUTER_SITE_URL?.trim() || 'http://localhost:3000';
    headers['X-Title'] = process.env.OPENROUTER_APP_NAME?.trim() || 'Salesforce SOQL Playground';
  }
  return headers;
}

function pricePerMillion(value) {
  const price = Number(value);
  return Number.isFinite(price) ? price * 1_000_000 : null;
}

function normalizeModel(model) {
  const promptPrice = pricePerMillion(model.pricing?.prompt);
  const completionPrice = pricePerMillion(model.pricing?.completion);
  return {
    id: model.id,
    name: model.name || model.id,
    description: typeof model.description === 'string' ? model.description.slice(0, 500) : '',
    contextLength: Number.isFinite(model.context_length) ? model.context_length : null,
    promptPrice,
    completionPrice,
    free: promptPrice === 0 && completionPrice === 0,
  };
}

export async function listLlmModels(providerName) {
  const config = getLlmConfig(providerName);
  if (!config) throw llmError('No AI provider is configured.');
  if (config.kind === 'copilot') {
    return { provider: config.name, defaultModel: config.model, models: await copilotModels(config) };
  }
  if (config.name !== 'openrouter') {
    return {
      provider: config.name,
      defaultModel: config.model,
      models: fixedModels(config),
    };
  }

  const cached = modelCache.get(config.base);
  if (cached?.expiresAt > Date.now()) return cached.value;

  let response;
  try {
    response = await fetch(`${config.base}/models`, {
      headers: openAiHeaders(config),
      signal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
    });
  } catch (error) {
    throw llmError(`Could not load OpenRouter models. ${error.message}`);
  }
  const text = await response.text();
  if (!response.ok) {
    throw llmError(`OpenRouter model catalog returned ${response.status}${summarize(text, config.apiKey)}`);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw llmError('OpenRouter returned an unreadable model catalog.');
  }
  const models = (Array.isArray(data.data) ? data.data : [])
    .filter((model) =>
      isValidModelId(model.id) &&
      (!model.architecture?.output_modalities ||
        model.architecture.output_modalities.includes('text')) &&
      (!model.endpoints || model.endpoints.includes('/api/v1/chat/completions')))
    .map(normalizeModel)
    .sort((a, b) => a.name.localeCompare(b.name));
  if (!models.length) throw llmError('OpenRouter returned no compatible chat models.');

  const value = { provider: config.name, defaultModel: config.model, models };
  modelCache.set(config.base, { expiresAt: Date.now() + MODEL_CACHE_TTL_MS, value });
  return value;
}

function buildRequest(config, prompt) {
  if (config.kind === 'anthropic') {
    return {
      url: `${config.base}${config.path}`,
      headers: { 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01' },
      body: {
        model: config.model,
        max_tokens: 1024,
        system: prompt.system,
        messages: [{ role: 'user', content: prompt.user }],
      },
      pick: (data) => data.content?.find((part) => part.type === 'text')?.text,
    };
  }
  if (config.kind === 'gemini') {
    return {
      url: `${config.base}/${encodeURIComponent(config.model)}:generateContent`,
      headers: { 'x-goog-api-key': config.apiKey },
      body: {
        systemInstruction: { parts: [{ text: prompt.system }] },
        contents: [{ role: 'user', parts: [{ text: prompt.user }] }],
        generationConfig: {
          temperature: 0,
          maxOutputTokens: 1024,
          ...(prompt.json ? { responseMimeType: 'application/json' } : {}),
        },
      },
      pick: (data) => data.candidates?.[0]?.content?.parts?.map((part) => part.text).join(''),
    };
  }
  return {
    url: `${config.base}${config.path}`,
    headers: openAiHeaders(config),
    body: {
      model: config.model,
      temperature: 0,
      ...(prompt.json ? { response_format: { type: 'json_object' } } : {}),
      messages: [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ],
    },
    pick: (data) => data.choices?.[0]?.message?.content,
  };
}

/**
 * Environment for a local CLI: drop server secrets (including ANTHROPIC_API_KEY,
 * so Claude Code uses your login), nested-session markers, and any setting that
 * would auto-approve Copilot tools. GitHub tokens are kept: Copilot may use them
 * to sign in.
 */
function cliEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/API_KEY|SECRET|PASSWORD|^SALESFORCE_|^LLM_|^OPENROUTER_|^CLAUDECODE$|^CLAUDE_CODE_(ENABLED|PATH|MODEL|ENTRYPOINT)$|^COPILOT_(ENABLED|PATH|MODEL|ALLOW_ALL|ASSISTED_APPROVAL)$/i.test(key)) {
      delete env[key];
    }
  }
  return env;
}

const cliName = (config) => config.label.replace(/ \(local\)$/, '');

function runCli(config, args, { input, cwd, timeout }) {
  return new Promise((resolve, reject) => {
    const child = execFile(config.command, args, {
      cwd,
      env: cliEnv(),
      timeout,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error?.code === 'ENOENT') {
        const variable = `${CLI_PROVIDERS[config.name].envPrefix}_PATH`;
        return reject(llmError(`Could not find the ${cliName(config)} CLI ("${config.command}"). Install it or set ${variable}.`));
      }
      resolve({ error, stdout, stderr });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
  });
}

function cliFailure(config, error, stderr) {
  const reason = error.killed
    ? 'timed out'
    : String(stderr || error.message).replace(/\s+/g, ' ').trim().slice(0, 240);
  return llmError(`${cliName(config)} failed: ${reason}`);
}

/**
 * Run Claude Code headlessly as a plain completion backend. It gets no tools,
 * no MCP servers, no settings or skills, and runs outside the project so it
 * cannot read files or act on the untrusted text in the prompt.
 */
async function runClaudeCode(config, prompt) {
  const { error, stdout, stderr } = await runCli(config, [
    '-p',
    '--output-format', 'json',
    '--model', config.model,
    '--system-prompt', prompt.system,
    '--tools', '',
    '--strict-mcp-config',
    '--setting-sources', '',
    '--disable-slash-commands',
    '--no-session-persistence',
  ], { input: prompt.user, cwd: tmpdir(), timeout: CLAUDE_CODE_TIMEOUT_MS });
  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    data = null;
  }
  if (data?.is_error) {
    throw llmError(`Claude Code returned an error: ${String(data.result || data.subtype || 'unknown').slice(0, 240)}`);
  }
  if (error) throw cliFailure(config, error, stderr);
  if (!data) throw llmError('Claude Code returned an unreadable response.');
  if (typeof data.result !== 'string' || !data.result.trim()) {
    throw llmError('Claude Code returned an empty response.');
  }
  return data.result.trim();
}

/** Every Copilot CLI built-in tool, all excluded. Unlisted new tools are still denied: -p never auto-approves. */
const COPILOT_TOOLS = [
  'bash', 'powershell', 'read_bash', 'write_bash', 'stop_bash', 'list_bash',
  'view', 'edit', 'create', 'str_replace_editor', 'grep', 'glob',
  'web_fetch', 'sql', 'session_store_sql', 'skill', 'task',
  'read_agent', 'write_agent', 'list_agents', 'ask_user', 'report_intent',
  'update_todo', 'think', 'fetch_copilot_cli_documentation',
];

/** Read the last assistant message out of Copilot's JSONL event stream. */
function copilotAnswer(stdout) {
  let answer = '';
  let exitCode;
  for (const line of stdout.split('\n')) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === 'assistant.message' && typeof event.data?.content === 'string' && event.data.content.trim()) {
      answer = event.data.content;
    } else if (event.type === 'result') {
      exitCode = event.exitCode;
    }
  }
  return { answer: answer.trim(), exitCode };
}

/**
 * Run the GitHub Copilot CLI headlessly. Copilot has no system-prompt flag, so
 * the instructions and the request go in one prompt. Every tool is excluded,
 * built-in MCP servers and repository instructions are off, and it runs in an
 * empty throwaway directory that is removed afterwards.
 */
async function runCopilot(config, prompt) {
  const workdir = await mkdtemp(join(tmpdir(), 'soql-copilot-'));
  try {
    const { error, stdout, stderr } = await runCli(config, [
      '-C', workdir,
      '-p', `${prompt.system}\n\n---\n\n${prompt.user}`,
      '--model', config.model,
      '--output-format', 'json',
      `--excluded-tools=${COPILOT_TOOLS.join(',')}`,
      '--disable-builtin-mcps',
      '--no-custom-instructions',
      '--no-ask-user',
      '--disallow-temp-dir',
      '--no-auto-update',
      '--no-color',
    ], { cwd: workdir, timeout: COPILOT_TIMEOUT_MS });
    const { answer, exitCode } = copilotAnswer(stdout || '');
    if (error || (exitCode !== undefined && exitCode !== 0)) {
      throw cliFailure(config, error || { message: `exit code ${exitCode}` }, stderr);
    }
    if (!answer) throw llmError('GitHub Copilot returned an empty response.');
    return answer;
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
}

const COPILOT_CATALOG_TTL_MS = 60 * 60 * 1000;
let copilotCatalog;

/**
 * Copilot's model IDs, read from `copilot help config` so the list follows CLI
 * updates. Falls back to just "auto" when the help text cannot be read.
 */
async function copilotModels(config) {
  if (copilotCatalog?.command === config.command && copilotCatalog.expiresAt > Date.now()) {
    return withDefault(copilotCatalog.models, config.model);
  }
  let ids = [];
  try {
    const { error, stdout } = await runCli(config, ['help', 'config'], { cwd: tmpdir(), timeout: MODEL_TIMEOUT_MS });
    if (!error) {
      const section = stdout.match(/`model`:[\s\S]*?(?=\n\s*`[A-Za-z]+`:)/)?.[0] || '';
      ids = [...section.matchAll(/^\s*-\s*"([^"]+)"/gm)].map((match) => match[1]).filter((id) => COPILOT_MODEL_ID.test(id));
    }
  } catch {
    ids = [];
  }
  const models = [{ id: 'auto', name: 'Auto (Copilot picks)' }, ...ids.map((id) => ({ id, name: id }))];
  if (ids.length) copilotCatalog = { command: config.command, models, expiresAt: Date.now() + COPILOT_CATALOG_TTL_MS };
  return withDefault(models, config.model);
}

function withDefault(models, model) {
  return models.some((entry) => entry.id === model) ? models : [{ id: model, name: model }, ...models];
}

export async function completeText(prompt, options = {}) {
  const baseConfig = getLlmConfig(options.provider);
  if (!baseConfig) {
    throw llmError(options.provider
      ? `The ${options.provider} provider is not configured.`
      : 'No AI provider is configured.');
  }
  const selectedModel = options.model?.trim();
  if (selectedModel && !isAllowedModel(baseConfig, selectedModel)) {
    throw llmError(`Invalid model for ${baseConfig.label}.`);
  }
  const config = { ...baseConfig, model: selectedModel || baseConfig.model };
  if (config.kind === 'claude-code') return runClaudeCode(config, prompt);
  if (config.kind === 'copilot') return runCopilot(config, prompt);
  const { url, headers, body, pick } = buildRequest(config, prompt);

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw llmError(`Could not reach the ${config.name} API. ${error.message}`);
  }

  const text = await response.text();
  if (!response.ok) {
    throw llmError(`The ${config.name} API returned ${response.status}${summarize(text, config.apiKey)}`);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw llmError(`The ${config.name} API returned an unreadable response.`);
  }

  const content = pick(data);
  if (typeof content !== 'string' || !content.trim()) {
    throw llmError(`The ${config.name} API returned an empty response.`);
  }
  return content.trim();
}
