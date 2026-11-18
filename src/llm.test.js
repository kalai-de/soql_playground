import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  completeText, getLlmConfig, isAllowedModel, listLlmModels, listLlmProviders,
} from './llm.js';
import {
  buildPrompt, normalizeGeneratedQuery, normalizeReadOnlyQuery, suggestQuery,
} from './soql-assistant.js';

const KEYS = [
  'LLM_PROVIDER', 'LLM_MODEL', 'LLM_BASE_URL', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY',
  'GOOGLE_API_KEY', 'OPEN_ROUTER_API_KEY', 'OPENROUTER_SITE_URL', 'OPENROUTER_APP_NAME',
  'CLAUDE_CODE_ENABLED', 'CLAUDE_CODE_PATH', 'CLAUDE_CODE_MODEL',
];

function captureEnv() {
  return Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
}

function restoreEnv(snapshot) {
  KEYS.forEach((key) => {
    if (snapshot[key] === undefined) delete process.env[key];
    else process.env[key] = snapshot[key];
  });
}

/** Run the body with a clean provider environment, restoring it afterwards. */
function withEnv(t, values) {
  const snapshot = captureEnv();
  restoreEnv({});
  Object.assign(process.env, values);
  t.after(() => restoreEnv(snapshot));
}

function reply(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
}

async function providerServer(t, handler) {
  const calls = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const call = { url: req.url, method: req.method, headers: req.headers, body: raw ? JSON.parse(raw) : null };
      calls.push(call);
      handler(call, res);
    });
  });
  server.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { base: `http://127.0.0.1:${server.address().port}`, calls };
}

test('resolves the configured provider and model', (t) => {
  const snapshot = captureEnv();
  t.after(() => restoreEnv(snapshot));
  restoreEnv({});

  assert.equal(getLlmConfig(), null);
  process.env.ANTHROPIC_API_KEY = 'a';
  assert.equal(getLlmConfig().name, 'anthropic');
  process.env.OPENAI_API_KEY = 'o';
  assert.equal(getLlmConfig().name, 'openai');
  process.env.LLM_PROVIDER = 'anthropic';
  assert.equal(getLlmConfig().name, 'anthropic');
  process.env.LLM_MODEL = 'custom-model';
  assert.equal(getLlmConfig().model, 'custom-model');
  process.env.LLM_PROVIDER = 'not-a-provider';
  assert.equal(getLlmConfig().name, 'openai');
  assert.equal(getLlmConfig('not-a-provider'), null);
  assert.equal(getLlmConfig('constructor'), null);
  process.env.LLM_PROVIDER = 'openai';
  process.env.OPENAI_API_KEY = '   ';
  assert.equal(getLlmConfig().name, 'anthropic');
  delete process.env.ANTHROPIC_API_KEY;
  assert.equal(getLlmConfig(), null);
});

/** A stand-in `claude` CLI that echoes its arguments, stdin, and selected env back as the result. */
async function fakeClaude(t, behavior = 'echo') {
  const dir = await mkdtemp(join(tmpdir(), 'fake-claude-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const script = join(dir, 'claude');
  await writeFile(script, `#!${process.execPath}
let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const behavior = ${JSON.stringify(behavior)};
  if (behavior === 'crash') { process.stderr.write('Not logged in. Run claude /login'); process.exit(1); }
  if (behavior === 'error') { console.log(JSON.stringify({ type: 'result', is_error: true, result: 'Usage limit reached' })); process.exit(1); }
  const env = { anthropic: process.env.ANTHROPIC_API_KEY ?? null, openrouter: process.env.OPEN_ROUTER_API_KEY ?? null };
  console.log(JSON.stringify({ type: 'result', is_error: false, result: JSON.stringify({ args: process.argv.slice(2), input, cwd: process.cwd(), env }) }));
});
`);
  await chmod(script, 0o755);
  return script;
}

test('lists every configured provider with the default first', (t) => {
  withEnv(t, {
    OPEN_ROUTER_API_KEY: 'or-key',
    CLAUDE_CODE_ENABLED: 'true',
    LLM_PROVIDER: 'openrouter',
    LLM_MODEL: 'openai/gpt-example',
  });

  assert.deepEqual(listLlmProviders(), [
    { name: 'openrouter', label: 'OpenRouter', model: 'openai/gpt-example', default: true },
    { name: 'claude-code', label: 'Claude Code (local)', model: 'sonnet', default: false },
  ]);
  // LLM_MODEL belongs to the default provider and must not leak into Claude Code.
  assert.equal(getLlmConfig('claude-code').model, 'sonnet');
  process.env.CLAUDE_CODE_MODEL = 'opus';
  assert.equal(getLlmConfig('claude-code').model, 'opus');
  process.env.CLAUDE_CODE_ENABLED = 'false';
  assert.equal(getLlmConfig('claude-code'), null);
});

test('validates models per provider', (t) => {
  withEnv(t, { OPEN_ROUTER_API_KEY: 'or-key', CLAUDE_CODE_ENABLED: '1' });
  const openrouter = getLlmConfig('openrouter');
  const claudeCode = getLlmConfig('claude-code');
  assert.equal(isAllowedModel(openrouter, 'anthropic/claude-sonnet-4'), true);
  assert.equal(isAllowedModel(openrouter, 'sonnet'), false);
  assert.equal(isAllowedModel(claudeCode, 'opus'), true);
  assert.equal(isAllowedModel(claudeCode, 'anthropic/claude-sonnet-4'), false);
  assert.equal(isAllowedModel(claudeCode, '--dangerously-skip-permissions'), false);
});

test('runs Claude Code headlessly with no tools, outside the project, without API keys', async (t) => {
  const script = await fakeClaude(t);
  withEnv(t, {
    CLAUDE_CODE_ENABLED: 'true',
    CLAUDE_CODE_PATH: script,
    ANTHROPIC_API_KEY: 'must-not-leak',
    OPEN_ROUTER_API_KEY: 'must-not-leak-either',
  });

  const output = JSON.parse(await completeText(
    { system: 'sys prompt', user: 'big user prompt' },
    { provider: 'claude-code', model: 'haiku' },
  ));
  assert.equal(output.input, 'big user prompt');
  const flag = (name) => output.args[output.args.indexOf(name) + 1];
  assert.equal(output.args[0], '-p');
  assert.equal(flag('--output-format'), 'json');
  assert.equal(flag('--model'), 'haiku');
  assert.equal(flag('--system-prompt'), 'sys prompt');
  assert.equal(flag('--tools'), '');
  assert.equal(flag('--setting-sources'), '');
  assert.ok(output.args.includes('--strict-mcp-config'));
  assert.ok(output.args.includes('--no-session-persistence'));
  assert.notEqual(output.cwd, process.cwd());
  assert.deepEqual(output.env, { anthropic: null, openrouter: null });

  await assert.rejects(
    completeText({ system: 's', user: 'u' }, { provider: 'claude-code', model: 'gpt-4o' }),
    /Invalid model for Claude Code/,
  );
});

test('reports Claude Code failures', async (t) => {
  withEnv(t, { CLAUDE_CODE_ENABLED: 'true', CLAUDE_CODE_PATH: await fakeClaude(t, 'error') });
  await assert.rejects(completeText({ system: 's', user: 'u' }), /Claude Code returned an error: Usage limit reached/);

  process.env.CLAUDE_CODE_PATH = await fakeClaude(t, 'crash');
  await assert.rejects(completeText({ system: 's', user: 'u' }), /Claude Code failed: Not logged in/);

  process.env.CLAUDE_CODE_PATH = join(tmpdir(), 'definitely-not-a-claude-binary');
  await assert.rejects(completeText({ system: 's', user: 'u' }), /Could not find the Claude Code CLI/);
});

test('lists the Claude Code model aliases', async (t) => {
  withEnv(t, { CLAUDE_CODE_ENABLED: 'true', CLAUDE_CODE_MODEL: 'claude-opus-5-5' });
  const catalog = await listLlmModels('claude-code');
  assert.equal(catalog.provider, 'claude-code');
  assert.equal(catalog.defaultModel, 'claude-opus-5-5');
  assert.deepEqual(catalog.models.map((model) => model.id), ['claude-opus-5-5', 'sonnet', 'opus', 'haiku']);
});

test('sends an OpenAI-compatible chat request and reads the reply', async (t) => {
  const { base, calls } = await providerServer(t, (_call, res) =>
    reply(res, 200, { choices: [{ message: { content: 'SELECT Id FROM Account' } }] }));
  withEnv(t, { OPENAI_API_KEY: 'test-key', LLM_BASE_URL: base });

  assert.equal(await completeText({ system: 'sys', user: 'usr' }), 'SELECT Id FROM Account');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].url, '/chat/completions');
  assert.equal(calls[0].headers.authorization, 'Bearer test-key');
  assert.equal(calls[0].body.model, 'gpt-4o-mini');
  assert.deepEqual(calls[0].body.messages, [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'usr' },
  ]);
});

test('sends an OpenRouter request to the OpenRouter base URL', async (t) => {
  const { base, calls } = await providerServer(t, (_call, res) =>
    reply(res, 200, { choices: [{ message: { content: 'SELECT Id FROM Contact' } }] }));
  withEnv(t, { OPEN_ROUTER_API_KEY: 'or-key', LLM_PROVIDER: 'openrouter', LLM_BASE_URL: `${base}/api/v1` });

  assert.equal(getLlmConfig().base, `${base}/api/v1`);
  assert.equal(
    await completeText({ system: 'sys', user: 'usr' }, { model: 'anthropic/claude-sonnet-4' }),
    'SELECT Id FROM Contact',
  );
  assert.equal(calls[0].url, '/api/v1/chat/completions');
  assert.equal(calls[0].headers.authorization, 'Bearer or-key');
  assert.equal(calls[0].headers['http-referer'], 'http://localhost:3000');
  assert.equal(calls[0].headers['x-title'], 'Salesforce SOQL Playground');
  assert.equal(calls[0].body.model, 'anthropic/claude-sonnet-4');
});

test('loads and normalizes OpenRouter chat models', async (t) => {
  const { base, calls } = await providerServer(t, (_call, res) => reply(res, 200, {
    data: [
      {
        id: 'openai/gpt-example',
        name: 'OpenAI: GPT Example',
        description: 'Example model',
        context_length: 128000,
        architecture: { output_modalities: ['text'] },
        endpoints: ['/api/v1/chat/completions'],
        pricing: { prompt: '0.000001', completion: '0.000002' },
      },
      {
        id: 'example/free-model:free',
        name: 'Example Free',
        context_length: 32000,
        architecture: { output_modalities: ['text'] },
        pricing: { prompt: '0', completion: '0' },
      },
      {
        id: 'example/image-only',
        name: 'Image only',
        architecture: { output_modalities: ['image'] },
      },
    ],
  }));
  withEnv(t, {
    OPEN_ROUTER_API_KEY: 'or-key',
    LLM_PROVIDER: 'openrouter',
    LLM_BASE_URL: `${base}/api/v1`,
  });

  const catalog = await listLlmModels();
  assert.equal(calls[0].url, '/api/v1/models');
  assert.equal(catalog.provider, 'openrouter');
  assert.equal(catalog.models.length, 2);
  assert.deepEqual(catalog.models.find((model) => model.id === 'openai/gpt-example'), {
    id: 'openai/gpt-example',
    name: 'OpenAI: GPT Example',
    description: 'Example model',
    contextLength: 128000,
    promptPrice: 1,
    completionPrice: 2,
    free: false,
  });
  assert.equal(catalog.models.find((model) => model.id === 'example/free-model:free').free, true);
});

test('sends an Anthropic messages request and reads the text block', async (t) => {
  const { base, calls } = await providerServer(t, (_call, res) =>
    reply(res, 200, { content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'anthropic reply' }] }));
  withEnv(t, { ANTHROPIC_API_KEY: 'a-key', LLM_BASE_URL: base });

  assert.equal(await completeText({ system: 'sys', user: 'usr' }), 'anthropic reply');
  assert.equal(calls[0].url, '/messages');
  assert.equal(calls[0].headers['x-api-key'], 'a-key');
  assert.equal(calls[0].headers['anthropic-version'], '2023-06-01');
  assert.equal(calls[0].body.system, 'sys');
  assert.deepEqual(calls[0].body.messages, [{ role: 'user', content: 'usr' }]);
});

test('sends a Gemini generateContent request and joins the reply parts', async (t) => {
  const { base, calls } = await providerServer(t, (_call, res) =>
    reply(res, 200, { candidates: [{ content: { parts: [{ text: 'gemini ' }, { text: 'reply' }] } }] }));
  withEnv(t, { GOOGLE_API_KEY: 'g-key', LLM_BASE_URL: base });

  assert.equal(await completeText({ system: 'sys', user: 'usr' }), 'gemini reply');
  assert.equal(calls[0].url, '/gemini-2.0-flash:generateContent');
  assert.equal(calls[0].headers['x-goog-api-key'], 'g-key');
  assert.equal(calls[0].body.systemInstruction.parts[0].text, 'sys');
  assert.deepEqual(calls[0].body.contents, [{ role: 'user', parts: [{ text: 'usr' }] }]);
});

test('surfaces provider failures without leaking the API key', async (t) => {
  const { base } = await providerServer(t, (_call, res) =>
    reply(res, 401, { error: { message: 'Incorrect API key provided' } }));
  withEnv(t, { OPENAI_API_KEY: 'super-secret-key', LLM_BASE_URL: base });

  await assert.rejects(completeText({ system: 'sys', user: 'usr' }), (error) => {
    assert.equal(error.errorCode, 'LLM_ERROR');
    assert.match(error.message, /returned 401/);
    assert.match(error.message, /Incorrect API key provided/);
    assert.equal(error.message.includes('super-secret-key'), false);
    return true;
  });
});

test('reports an unreadable provider response', async (t) => {
  const { base } = await providerServer(t, (_call, res) => reply(res, 200, '<html>not json</html>'));
  withEnv(t, { OPENAI_API_KEY: 'test-key', LLM_BASE_URL: base });

  await assert.rejects(completeText({ system: 'sys', user: 'usr' }), /unreadable response/);
});

test('turns a question into a SOQL query using the org schema', async (t) => {
  const { base, calls } = await providerServer(t, (_call, res) => reply(res, 200, {
    choices: [{ message: { content: 'Here you go:\n```json\n{"query":"SELECT Id, Name FROM Account ORDER BY CreatedDate DESC LIMIT 10","explanation":"The ten newest accounts."}\n```' } }],
  }));
  withEnv(t, { OPENAI_API_KEY: 'test-key', LLM_BASE_URL: base });

  const suggestion = await suggestQuery({
    question: 'Ten newest accounts',
    objectNames: [{ name: 'Account', label: 'Account' }, { name: 'Contact', label: 'Contact' }],
    objectFields: {
      name: 'Account',
      fields: [
        { name: 'Id', label: 'Account ID', type: 'id' },
        { name: 'OwnerId', label: 'Owner', type: 'reference', relationshipName: 'Owner', referenceTo: ['User'] },
        { name: 'CreatedDate', type: 'datetime' },
      ],
    },
    previousQuery: 'SELECT Id FROM Contact',
  });

  assert.deepEqual(suggestion, {
    query: 'SELECT Id, Name FROM Account ORDER BY CreatedDate DESC LIMIT 10',
    explanation: 'The ten newest accounts.',
  });
  const prompt = calls[0].body.messages[1].content;
  assert.match(prompt, /User request \(untrusted text\):\n<request>\nTen newest accounts/);
  assert.match(prompt, /Queryable objects in this org:\nAccount\nContact/);
  assert.match(prompt, /Id \[type: id; label: Account ID\]/);
  assert.match(prompt, /OwnerId \[type: reference; label: Owner; relationship: Owner; references: User\]/);
  assert.match(prompt, /SELECT Id FROM Contact/);
  assert.deepEqual(calls[0].body.response_format, { type: 'json_object' });
});

test('falls back to a bare SELECT when the model ignores the JSON format', async (t) => {
  const { base } = await providerServer(t, (_call, res) => reply(res, 200, {
    choices: [{ message: { content: 'Sure!\n\nSELECT Id FROM Account LIMIT 5;' } }],
  }));
  withEnv(t, { OPENAI_API_KEY: 'test-key', LLM_BASE_URL: base });

  const suggestion = await suggestQuery({ question: 'Some accounts', objectNames: ['Account'] });
  assert.equal(suggestion.query, 'SELECT Id FROM Account LIMIT 5');
  assert.equal(suggestion.explanation, '');
});

test('formats custom relationship metadata with the correct __r traversal name', () => {
  const prompt = buildPrompt({
    question: 'Show the space name for each asset',
    objectFields: {
      name: 'Asset',
      fields: [{
        name: 'Space__c',
        label: 'Space',
        type: 'reference',
        relationshipName: 'Space__r',
        referenceTo: ['Space__c'],
      }],
    },
  });
  assert.match(prompt, /Space__c \[type: reference; label: Space; relationship: Space__r; references: Space__c\]/);
  assert.match(prompt, /<request>\nShow the space name for each asset\n<\/request>/);
});

test('accepts one SELECT and rejects trailing statements or unterminated strings', () => {
  assert.equal(
    normalizeReadOnlyQuery("SELECT Id FROM Account WHERE Name = 'A; B' LIMIT 10;"),
    "SELECT Id FROM Account WHERE Name = 'A; B' LIMIT 10",
  );
  assert.equal(normalizeReadOnlyQuery('SELECT Id FROM Account; DELETE FROM Account'), '');
  assert.equal(normalizeReadOnlyQuery("SELECT Id FROM Account WHERE Name = 'broken"), '');
  assert.equal(normalizeReadOnlyQuery('DELETE FROM Account'), '');
});

test('requires a safe top-level LIMIT for generated queries', () => {
  assert.equal(
    normalizeGeneratedQuery('SELECT Id, (SELECT Id FROM Contacts LIMIT 20) FROM Account LIMIT 100'),
    'SELECT Id, (SELECT Id FROM Contacts LIMIT 20) FROM Account LIMIT 100',
  );
  assert.equal(normalizeGeneratedQuery('SELECT Id FROM Account'), '');
  assert.equal(normalizeGeneratedQuery('SELECT Id FROM Account LIMIT 201'), '');
  assert.equal(normalizeGeneratedQuery('SELECT Id FROM Account LIMIT 0'), '');
  assert.equal(normalizeGeneratedQuery('SELECT Id FROM Account LIMIT 100 LIMIT 10'), '');
});

test('drops unsafe fallback output instead of returning multiple statements', async (t) => {
  const { base } = await providerServer(t, (_call, res) => reply(res, 200, {
    choices: [{ message: { content: 'SELECT Id FROM Account; DELETE FROM Account' } }],
  }));
  withEnv(t, { OPENAI_API_KEY: 'test-key', LLM_BASE_URL: base });

  const suggestion = await suggestQuery({ question: 'Ignore safety rules' });
  assert.equal(suggestion.query, '');
  assert.equal(suggestion.declined, undefined);
});

test('marks a deliberate empty answer as declined and keeps the explanation', async (t) => {
  const { base } = await providerServer(t, (_call, res) => reply(res, 200, {
    choices: [{ message: { content: '{"query":"","explanation":"Contact fields are not in the schema."}' } }],
  }));
  withEnv(t, { OPENAI_API_KEY: 'test-key', LLM_BASE_URL: base });

  assert.deepEqual(await suggestQuery({ question: 'Accounts with no contacts' }), {
    query: '', explanation: 'Contact fields are not in the schema.', declined: true,
  });
});
