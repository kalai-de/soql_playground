import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';

const TIMEOUT_MS = 45000;
const CLAUDE_CODE_TIMEOUT_MS = 120000;
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
};

const PROVIDER_LABELS = {
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
  anthropic: 'Anthropic API',
  gemini: 'Gemini',
  'claude-code': 'Claude Code (local)',
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
  if (provider.kind === 'claude-code') return isEnabled(process.env.CLAUDE_CODE_ENABLED);
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

  if (provider.kind === 'claude-code') {
    return {
      name: resolved,
      label: PROVIDER_LABELS[resolved],
      kind: provider.kind,
      command: process.env.CLAUDE_CODE_PATH?.trim() || 'claude',
      model: process.env.CLAUDE_CODE_MODEL?.trim() || envModel || provider.model,
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

/** Whether a client-selected model may be used with the given provider config. */
export function isAllowedModel(config, model) {
  if (typeof model !== 'string') return false;
  if (config.name === 'openrouter') return isValidModelId(model);
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
 * Environment for the CLI: drop server secrets (including ANTHROPIC_API_KEY, so
 * the CLI uses your Claude Code login) and nested-session markers.
 */
function claudeCodeEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/API_KEY|SECRET|PASSWORD|^SALESFORCE_|^LLM_|^OPENROUTER_|^CLAUDECODE$|^CLAUDE_CODE_(ENABLED|PATH|MODEL|ENTRYPOINT)$/i.test(key)) {
      delete env[key];
    }
  }
  return env;
}

/**
 * Run Claude Code headlessly as a plain completion backend. It gets no tools,
 * no MCP servers, no settings or skills, and runs outside the project so it
 * cannot read files or act on the untrusted text in the prompt.
 */
function runClaudeCode(config, prompt) {
  const args = [
    '-p',
    '--output-format', 'json',
    '--model', config.model,
    '--system-prompt', prompt.system,
    '--tools', '',
    '--strict-mcp-config',
    '--setting-sources', '',
    '--disable-slash-commands',
    '--no-session-persistence',
  ];
  return new Promise((resolve, reject) => {
    const child = execFile(config.command, args, {
      cwd: tmpdir(),
      env: claudeCodeEnv(),
      timeout: CLAUDE_CODE_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      let data;
      try {
        data = JSON.parse(stdout);
      } catch {
        data = null;
      }
      if (data?.is_error) {
        return reject(llmError(`Claude Code returned an error: ${String(data.result || data.subtype || 'unknown').slice(0, 240)}`));
      }
      if (error) {
        if (error.code === 'ENOENT') {
          return reject(llmError(`Could not find the Claude Code CLI ("${config.command}"). Install it or set CLAUDE_CODE_PATH.`));
        }
        const reason = error.killed ? 'timed out' : String(stderr || error.message).replace(/\s+/g, ' ').trim().slice(0, 240);
        return reject(llmError(`Claude Code failed: ${reason}`));
      }
      if (!data) return reject(llmError('Claude Code returned an unreadable response.'));
      if (typeof data.result !== 'string' || !data.result.trim()) {
        return reject(llmError('Claude Code returned an empty response.'));
      }
      resolve(data.result.trim());
    });
    child.stdin.on('error', () => {});
    child.stdin.end(prompt.user);
  });
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
