import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.js';

async function serve(t, run, refresh, assist, getModels) {
  const server = createApp(run, refresh, assist, getModels).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

const LLM_KEYS = [
  'LLM_PROVIDER', 'LLM_MODEL', 'LLM_BASE_URL', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY',
  'GOOGLE_API_KEY', 'OPEN_ROUTER_API_KEY', 'OPENROUTER_SITE_URL', 'OPENROUTER_APP_NAME',
  'CLAUDE_CODE_ENABLED', 'CLAUDE_CODE_PATH', 'CLAUDE_CODE_MODEL', 'COPILOT_ENABLED', 'COPILOT_PATH', 'COPILOT_MODEL',
];

function clearLlmEnv() {
  LLM_KEYS.forEach((key) => { delete process.env[key]; });
}

function useLlmProvider(t, envKey = 'OPENAI_API_KEY', extra = {}) {
  const previous = Object.fromEntries(LLM_KEYS.map((key) => [key, process.env[key]]));
  clearLlmEnv();
  process.env[envKey] = 'private-test-key';
  Object.assign(process.env, extra);
  t.after(() => LLM_KEYS.forEach((key) => {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }));
}

test('rejects non-query statements and arbitrary pagination URLs before contacting Salesforce', async (t) => {
  const base = await serve(t, () => { throw new Error('Must not contact Salesforce'); });
  for (const payload of [
    { query: 'DELETE FROM Account' },
    { query: 'SELECT Id FROM Account; DELETE FROM Account' },
    { query: '' },
    { nextRecordsUrl: 'https://example.com' },
    { nextRecordsUrl: '/services/data/v66.0/sobjects/Account' },
  ]) {
    const response = await fetch(`${base}/api/query`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    assert.equal(response.status, 400);
  }
});

test('refresh requests a new session and exposes only connection metadata', async (t) => {
  let refreshes = 0;
  const base = await serve(t, () => { throw new Error('Must not reuse the cached session'); }, async () => {
    refreshes += 1;
    return {
      instanceUrl: 'https://example.my.salesforce.com', version: '66.0',
      sessionCreatedAt: '2026-11-17T12:00:00.000Z', accessToken: 'private-token', oauth2: { clientSecret: 'private-secret' },
    };
  });
  const response = await fetch(`${base}/api/auth/refresh`, { method: 'POST' });
  assert.equal(response.status, 200);
  assert.equal(refreshes, 1);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), {
    connected: true, instanceUrl: 'https://example.my.salesforce.com',
    apiVersion: '66.0', authenticatedAt: '2026-11-17T12:00:00.000Z',
  });
});

test('refresh reports authorization failure', async (t) => {
  const base = await serve(t, undefined, async () => { throw new Error('Client credentials flow is disabled'); });
  const response = await fetch(`${base}/api/auth/refresh`, { method: 'POST' });
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error, 'Client credentials flow is disabled');
});

test('returns records and forwards pagination to jsforce', async (t) => {
  const calls = [];
  const page = { totalSize: 2, done: false, records: [{ Id: '001', Name: 'Example' }], nextRecordsUrl: '/services/data/v66.0/query/locator-1' };
  const base = await serve(t, (operation) => operation({
    query: async (query) => { calls.push(query); return page; },
    queryMore: async (url) => { calls.push(url); return { totalSize: 2, done: true, records: [{ Id: '002' }] }; },
  }));
  for (const payload of [{ query: 'SELECT Id, Name FROM Account' }, { nextRecordsUrl: page.nextRecordsUrl }]) {
    const response = await fetch(`${base}/api/query`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.totalSize, 2);
    assert.equal(data.records.length, 1);
    assert.equal(typeof data.elapsedMs, 'number');
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  assert.deepEqual(calls, ['SELECT Id, Name FROM Account', page.nextRecordsUrl]);
});

test('returns a useful Salesforce error without serializing connection data', async (t) => {
  const base = await serve(t, async () => {
    throw Object.assign(new Error('No such column Example on Account'), {
      errorCode: 'INVALID_FIELD', accessToken: 'private-test-token',
    });
  });
  const response = await fetch(`${base}/api/status`);
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: 'No such column Example on Account', code: 'INVALID_FIELD' });
});

test('rejects an unusable AI request before contacting Salesforce', async (t) => {
  const base = await serve(t, () => { throw new Error('Must not contact Salesforce'); });
  for (const payload of [
    {},
    { question: '' },
    { question: '   ' },
    { question: 'x'.repeat(501) },
    { question: 'Newest accounts', object: 'Not A Name' },
    { question: 'Newest accounts', previousQuery: 'x'.repeat(20001) },
  ]) {
    const response = await fetch(`${base}/api/ai/query`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    assert.equal(response.status, 400);
  }
});

test('reports a missing AI provider without exposing any key', async (t) => {
  clearLlmEnv();
  const base = await serve(t, () => { throw new Error('Must not contact Salesforce'); });
  const status = await (await fetch(`${base}/api/ai/status`)).json();
  assert.deepEqual(status, { configured: false, provider: null, model: null, providers: [] });
  const response = await fetch(`${base}/api/ai/query`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: 'Newest accounts' }),
  });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'LLM_NOT_CONFIGURED');
});

test('generates a SELECT query from the schema and rejects unsafe model output', async (t) => {
  useLlmProvider(t);
  let suggestion = { query: 'SELECT Id, Name FROM Account LIMIT 10', explanation: 'Ten accounts.' };
  const base = await serve(t, (operation) => operation({
    describeGlobal: async () => ({ sobjects: [
      { name: 'Account', label: 'Account', queryable: true },
      { name: 'Hidden', label: 'Hidden', queryable: false },
    ] }),
    sobject: () => ({
      describe: async () => ({
        name: 'Account',
        fields: [{
          name: 'OwnerId',
          label: 'Owner',
          type: 'reference',
          relationshipName: 'Owner',
          referenceTo: ['User'],
          filterable: true,
        }],
      }),
    }),
  }), undefined, async ({ question, objectNames, objectFields, model }) => {
    assert.equal(question, 'Newest accounts');
    assert.equal(model, 'gpt-4o-mini');
    assert.deepEqual(objectNames, [{ name: 'Account', label: 'Account' }]);
    assert.equal(objectFields.name, 'Account');
    assert.deepEqual(objectFields.fields[0], {
      name: 'OwnerId',
      label: 'Owner',
      type: 'reference',
      relationshipName: 'Owner',
      referenceTo: ['User'],
      filterable: true,
    });
    return suggestion;
  });
  const send = () => fetch(`${base}/api/ai/query`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: 'Newest accounts', object: 'Account' }),
  });
  const ok = await send();
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), suggestion);

  suggestion = { query: 'DELETE FROM Account', explanation: 'Not a query.' };
  const unsafe = await send();
  assert.equal(unsafe.status, 502);
  assert.equal((await unsafe.json()).code, 'INVALID_SOQL');

  suggestion = { query: '', explanation: 'Contact fields are missing from the schema.', declined: true };
  const declined = await send();
  assert.equal(declined.status, 422);
  assert.deepEqual(await declined.json(), { error: 'Contact fields are missing from the schema.', code: 'AI_DECLINED' });

  suggestion = { query: 'SELECT Id FROM Account; DELETE FROM Account', explanation: 'Unsafe.' };
  const multiple = await send();
  assert.equal(multiple.status, 502);
  assert.equal((await multiple.json()).code, 'INVALID_SOQL');
});

test('infers the primary object from the question when none is selected', async (t) => {
  useLlmProvider(t);
  const described = [];
  const base = await serve(t, (operation) => operation({
    describeGlobal: async () => ({ sobjects: [
      { name: 'Account', label: 'Account', queryable: true },
      { name: 'Asset', label: 'Asset', queryable: true },
    ] }),
    sobject: (name) => ({
      describe: async () => {
        described.push(name);
        return { name, fields: [{ name: 'Id', label: 'Asset ID', type: 'id', filterable: true }] };
      },
    }),
  }), undefined, async ({ objectFields }) => ({
    query: `SELECT Id FROM ${objectFields.name} LIMIT 10`,
    explanation: 'Matching records.',
  }));

  const response = await fetch(`${base}/api/ai/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: 'Show me the newest assets' }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(described, ['Asset']);
  assert.equal((await response.json()).query, 'SELECT Id FROM Asset LIMIT 10');
});

test('lists OpenRouter models and forwards the selected model to the assistant', async (t) => {
  useLlmProvider(t, 'OPEN_ROUTER_API_KEY');
  const selected = [];
  const models = [{
    id: 'anthropic/claude-sonnet-4',
    name: 'Anthropic: Claude Sonnet 4',
    contextLength: 200000,
    promptPrice: 3,
    completionPrice: 15,
    free: false,
  }];
  const base = await serve(t, (operation) => operation({
    describeGlobal: async () => ({ sobjects: [{ name: 'Account', label: 'Account', queryable: true }] }),
    sobject: () => ({ describe: async () => ({ name: 'Account', fields: [] }) }),
  }), undefined, async ({ model }) => {
    selected.push(model);
    return { query: 'SELECT Id FROM Account LIMIT 10', explanation: 'Accounts.' };
  }, async () => ({
    provider: 'openrouter',
    defaultModel: 'openai/gpt-4o-mini',
    models,
  }));

  const catalogResponse = await fetch(`${base}/api/ai/models`);
  assert.equal(catalogResponse.status, 200);
  assert.deepEqual(await catalogResponse.json(), {
    provider: 'openrouter',
    defaultModel: 'openai/gpt-4o-mini',
    models,
  });

  const queryResponse = await fetch(`${base}/api/ai/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      question: 'Show accounts',
      object: 'Account',
      model: 'anthropic/claude-sonnet-4',
    }),
  });
  assert.equal(queryResponse.status, 200);
  assert.deepEqual(selected, ['anthropic/claude-sonnet-4']);

  const invalidResponse = await fetch(`${base}/api/ai/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: 'Show accounts', model: '../../invalid model' }),
  });
  assert.equal(invalidResponse.status, 400);
});

test('switches between OpenRouter and Claude Code per request', async (t) => {
  useLlmProvider(t, 'OPEN_ROUTER_API_KEY', { CLAUDE_CODE_ENABLED: 'true', LLM_PROVIDER: 'openrouter' });
  const calls = [];
  const catalogs = [];
  const base = await serve(t, (operation) => operation({
    describeGlobal: async () => ({ sobjects: [{ name: 'Account', label: 'Account', queryable: true }] }),
    sobject: () => ({ describe: async () => ({ name: 'Account', fields: [] }) }),
  }), undefined, async ({ model, provider }) => {
    calls.push({ model, provider });
    return { query: 'SELECT Id FROM Account LIMIT 10', explanation: 'Accounts.' };
  }, async (provider) => {
    catalogs.push(provider);
    return { provider, defaultModel: 'sonnet', models: [] };
  });

  const status = await (await fetch(`${base}/api/ai/status`)).json();
  assert.equal(status.provider, 'openrouter');
  assert.deepEqual(status.providers.map((provider) => provider.name), ['openrouter', 'claude-code']);
  assert.equal(JSON.stringify(status).includes('private-test-key'), false);

  assert.equal((await fetch(`${base}/api/ai/models?provider=claude-code`)).status, 200);
  assert.equal((await fetch(`${base}/api/ai/models?provider=gemini`)).status, 400);
  assert.equal((await fetch(`${base}/api/ai/models?provider=Bad%20Name`)).status, 400);
  assert.deepEqual(catalogs, ['claude-code']);

  const ask = (body) => fetch(`${base}/api/ai/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: 'Show accounts', object: 'Account', ...body }),
  });
  assert.equal((await ask({ provider: 'claude-code', model: 'opus' })).status, 200);
  assert.equal((await ask({ provider: 'claude-code' })).status, 200);
  assert.equal((await ask({ model: 'openai/gpt-4o-mini' })).status, 200);
  assert.equal((await ask({ provider: 'claude-code', model: 'openai/gpt-4o-mini' })).status, 400);
  assert.equal((await ask({ provider: 'openrouter', model: 'opus' })).status, 400);
  assert.equal((await ask({ provider: 'gemini' })).status, 400);
  assert.deepEqual(calls, [
    { model: 'opus', provider: 'claude-code' },
    { model: 'sonnet', provider: 'claude-code' },
    { model: 'openai/gpt-4o-mini', provider: 'openrouter' },
  ]);
});

test('describes picklist fields with their active values', async (t) => {
  const base = await serve(t, (operation) => operation({
    sobject: () => ({
      describe: async () => ({
        name: 'Account',
        fields: [
          { name: 'Name', label: 'Account Name', type: 'string', filterable: true, picklistValues: [] },
          {
            name: 'Industry',
            label: 'Industry',
            type: 'picklist',
            filterable: true,
            picklistValues: [
              { value: 'Banking', label: 'Banking', active: true, defaultValue: false },
              { value: 'Retail', label: 'Retail Trade', active: true, defaultValue: true },
              { value: 'Old', label: 'Old', active: false, defaultValue: false },
            ],
          },
        ],
      }),
    }),
  }));
  const response = await fetch(`${base}/api/objects/Account`);
  assert.equal(response.status, 200);
  const { fields, recordTypes } = await response.json();
  assert.deepEqual(recordTypes, []);
  assert.equal('picklistValues' in fields[0], false);
  assert.deepEqual(fields[1].picklistValues, [
    { value: 'Banking', label: 'Banking' },
    { value: 'Retail', label: 'Retail Trade', default: true },
  ]);
});

test('describes record types without the synthetic master entry', async (t) => {
  const base = await serve(t, (operation) => operation({
    sobject: () => ({
      describe: async () => ({
        name: 'Account',
        fields: [],
        recordTypeInfos: [
          { name: 'Master', developerName: 'Master', recordTypeId: '012000000000000AAA', master: true, active: true, defaultRecordTypeMapping: false },
          { name: 'Retired', developerName: 'Retired', recordTypeId: '012000000000003AAA', master: false, active: false, defaultRecordTypeMapping: false },
          { name: 'Partner', developerName: 'Partner_Account', recordTypeId: '012000000000002AAA', master: false, active: true, defaultRecordTypeMapping: false },
          { name: 'Customer', developerName: 'Customer_Account', recordTypeId: '012000000000001AAA', master: false, active: true, defaultRecordTypeMapping: true },
        ],
      }),
    }),
  }));
  const { recordTypes } = await (await fetch(`${base}/api/objects/Account`)).json();
  assert.deepEqual(recordTypes, [
    { id: '012000000000001AAA', name: 'Customer', developerName: 'Customer_Account', active: true, default: true },
    { id: '012000000000002AAA', name: 'Partner', developerName: 'Partner_Account', active: true },
    { id: '012000000000003AAA', name: 'Retired', developerName: 'Retired', active: false },
  ]);
});

test('sends the selected object plus every object the request names, with child relationships', async (t) => {
  useLlmProvider(t);
  const described = [];
  let received;
  const schemas = {
    Inventory__c: {
      name: 'Inventory__c',
      fields: [{ name: 'Asset__c', label: 'Asset', type: 'reference', relationshipName: 'Asset__r', referenceTo: ['Asset'] }],
      childRelationships: [],
    },
    Asset: {
      name: 'Asset',
      fields: [{ name: 'Name', label: 'Asset Name', type: 'string' }],
      childRelationships: [
        { relationshipName: 'Inventories__r', childSObject: 'Inventory__c', field: 'Asset__c' },
        { relationshipName: null, childSObject: 'AssetHistory', field: 'AssetId' },
      ],
    },
  };
  const base = await serve(t, (operation) => operation({
    describeGlobal: async () => ({ sobjects: [
      { name: 'Asset', label: 'Asset', queryable: true },
      { name: 'Inventory__c', label: 'Physical Inventory', queryable: true },
      { name: 'Name', label: 'Name', queryable: true },
      { name: 'Account', label: 'Account', queryable: true },
    ] }),
    sobject: (name) => ({ describe: async () => { described.push(name); return schemas[name]; } }),
  }), undefined, async (input) => {
    received = input;
    return { query: 'SELECT Id FROM Asset LIMIT 10', explanation: 'Assets.' };
  });

  const response = await fetch(`${base}/api/ai/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      question: 'Fetch all the Assets with physical inventory and the inventory name',
      object: 'Inventory__c',
    }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(described.sort(), ['Asset', 'Inventory__c']);
  assert.deepEqual(received.objectSchemas.map((schema) => schema.name), ['Inventory__c', 'Asset']);
  assert.equal(received.objectFields.name, 'Inventory__c');
  assert.deepEqual(received.objectSchemas[1].childRelationships, [
    { relationshipName: 'Inventories__r', childSObject: 'Inventory__c', field: 'Asset__c' },
  ]);
});
