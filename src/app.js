import express from 'express';
import { fileURLToPath } from 'node:url';
import { withSalesforce, refreshSalesforceConnection } from './salesforce.js';
import { getLlmConfig, isAllowedModel, listLlmModels, listLlmProviders } from './llm.js';
import { normalizeGeneratedQuery, normalizeReadOnlyQuery, suggestQuery } from './soql-assistant.js';

function sessionStatus(client) {
  return {
    connected: true,
    instanceUrl: client.instanceUrl,
    apiVersion: client.version,
    authenticatedAt: client.sessionCreatedAt,
  };
}

const NOT_CONFIGURED = {
  error: 'No AI provider is configured. Add an API key or set CLAUDE_CODE_ENABLED=true in .env, then restart the server.',
  code: 'LLM_NOT_CONFIGURED',
};
const PROVIDER_NAME = /^[a-z][a-z0-9-]{0,39}$/;

/** Resolve the provider a request asked for (or the default) and the status to send when it fails. */
function resolveProvider(provider) {
  if (provider !== undefined && (typeof provider !== 'string' || !PROVIDER_NAME.test(provider))) {
    return { status: 400, body: { error: 'Invalid AI provider.' } };
  }
  const config = getLlmConfig(provider);
  if (config) return { config };
  if (provider !== undefined && listLlmProviders().length) {
    return { status: 400, body: { error: `The ${provider} provider is not configured.`, code: 'LLM_PROVIDER_UNAVAILABLE' } };
  }
  return { status: 503, body: NOT_CONFIGURED };
}

function searchableObjectTerms(object) {
  return [...new Set([object.name.replace(/__c$/i, ''), object.label]
    .filter(Boolean)
    .map((value) => value.replace(/[_\W]+/g, ' ').trim().toLowerCase()))];
}

function inferObject(question, previousQuery, objects) {
  const byName = new Map(objects.map((object) => [object.name.toLowerCase(), object]));
  const fromMatches = [...previousQuery.matchAll(/\bFROM\s+([A-Za-z][A-Za-z0-9_]*)/gi)];
  for (let index = fromMatches.length - 1; index >= 0; index -= 1) {
    const match = byName.get(fromMatches[index][1].toLowerCase());
    if (match) return match.name;
  }

  const request = ` ${question.replace(/[_\W]+/g, ' ').toLowerCase()} `;
  const matches = objects
    .flatMap((object) => searchableObjectTerms(object).map((term) => ({ object, term })))
    .filter(({ term }) => request.includes(` ${term} `) || request.includes(` ${term}s `))
    .sort((a, b) => b.term.length - a.term.length);
  return matches[0]?.object.name;
}

const PICKLIST_TYPES = new Set(['picklist', 'multipicklist']);

/** Active picklist entries only; inactive values cannot be set on new records. */
function picklistValues(field) {
  if (!PICKLIST_TYPES.has(field.type) || !Array.isArray(field.picklistValues)) return undefined;
  return field.picklistValues
    .filter((entry) => entry.active !== false && typeof entry.value === 'string')
    .map(({ value, label, defaultValue }) => ({
      value,
      label: label || value,
      ...(defaultValue ? { default: true } : {}),
    }));
}

/** Real record types only: every object also reports a synthetic "Master" entry. */
function recordTypes(described) {
  return (Array.isArray(described.recordTypeInfos) ? described.recordTypeInfos : [])
    .filter((info) => !info.master && info.recordTypeId)
    .map((info) => ({
      id: info.recordTypeId,
      name: info.name,
      developerName: info.developerName,
      active: info.active !== false,
      ...(info.defaultRecordTypeMapping ? { default: true } : {}),
    }))
    .sort((a, b) => (b.active - a.active) || a.name.localeCompare(b.name));
}

function describeFields(described) {
  return {
    name: described.name,
    recordTypes: recordTypes(described),
    fields: described.fields.map((field) => {
      const values = picklistValues(field);
      return {
        name: field.name,
        label: field.label,
        type: field.type,
        relationshipName: field.relationshipName || undefined,
        referenceTo: field.referenceTo?.length ? field.referenceTo : undefined,
        filterable: field.filterable,
        ...(values ? { picklistValues: values } : {}),
      };
    }),
  };
}

export function createApp(
  run = withSalesforce,
  refresh = refreshSalesforceConnection,
  assist = suggestQuery,
  getModels = listLlmModels,
) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));
  app.use('/api', (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  app.get('/api/status', async (_req, res) => {
    const status = await run(async (client) => {
      await client.describeGlobal();
      return sessionStatus(client);
    });
    res.json(status);
  });

  app.post('/api/auth/refresh', async (_req, res) => {
    const client = await refresh();
    res.json(sessionStatus(client));
  });

  app.get('/api/objects', async (_req, res) => {
    const result = await run((client) => client.describeGlobal());
    res.json(result.sobjects.filter((object) => object.queryable)
      .map(({ name, label }) => ({ name, label }))
      .sort((a, b) => a.name.localeCompare(b.name)));
  });

  app.get('/api/objects/:name', async (req, res) => {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(req.params.name)) {
      return res.status(400).json({ error: 'Invalid object name.' });
    }
    const result = await run((client) => client.sobject(req.params.name).describe());
    res.json(describeFields(result));
  });

  app.get('/api/ai/status', (_req, res) => {
    const config = getLlmConfig();
    res.json(config
      ? { configured: true, provider: config.name, model: config.model, providers: listLlmProviders() }
      : { configured: false, provider: null, model: null, providers: [] });
  });

  app.get('/api/ai/models', async (req, res) => {
    const { config, status, body } = resolveProvider(req.query.provider);
    if (!config) return res.status(status).json(body);
    res.json(await getModels(config.name));
  });

  app.post('/api/ai/query', async (req, res) => {
    const { question, object, previousQuery, model, provider } = req.body || {};
    if (typeof question !== 'string' || !question.trim() || question.length > 500) {
      return res.status(400).json({ error: 'Describe what you want in 1 to 500 characters.' });
    }
    if (object !== undefined && !/^[A-Za-z][A-Za-z0-9_]*$/.test(object)) {
      return res.status(400).json({ error: 'Invalid object name.' });
    }
    if (previousQuery !== undefined && (typeof previousQuery !== 'string' || previousQuery.length > 20000)) {
      return res.status(400).json({ error: 'Invalid editor contents.' });
    }
    const { config: llmConfig, status, body } = resolveProvider(provider);
    if (!llmConfig) return res.status(status).json(body);
    if (model !== undefined && !isAllowedModel(llmConfig, model)) {
      return res.status(400).json({ error: 'Select a valid model for the configured AI provider.' });
    }
    const context = await run(async (client) => {
      const global = await client.describeGlobal();
      const objectNames = global.sobjects
        .filter((entry) => entry.queryable)
        .map(({ name, label }) => ({ name, label }));
      const primaryObject = object || inferObject(question, previousQuery || '', objectNames);
      let objectFields;
      if (primaryObject) {
        objectFields = describeFields(await client.sobject(primaryObject).describe());
      }
      return { objectNames, objectFields };
    });
    const suggestion = await assist({
      question: question.trim(),
      objectNames: context.objectNames,
      objectFields: context.objectFields,
      previousQuery: previousQuery || '',
      model: model || llmConfig.model,
      provider: llmConfig.name,
    });
    if (suggestion.declined && suggestion.explanation) {
      return res.status(422).json({ error: suggestion.explanation, code: 'AI_DECLINED' });
    }
    const query = normalizeGeneratedQuery(suggestion.query);
    if (!query || query.length > 20000) {
      return res.status(502).json({
        error: 'The AI did not return a valid read-only SELECT query. Try rephrasing your question.',
        code: 'INVALID_SOQL',
      });
    }
    res.json({ ...suggestion, query });
  });

  app.post('/api/query', async (req, res) => {
    const { query, nextRecordsUrl } = req.body || {};
    if (nextRecordsUrl !== undefined) {
      if (typeof nextRecordsUrl !== 'string' ||
          !/^\/services\/data\/v\d+\.\d+\/query\/[A-Za-z0-9-]+$/.test(nextRecordsUrl)) {
        return res.status(400).json({ error: 'Invalid query pagination URL.' });
      }
    } else if (!normalizeReadOnlyQuery(query) || query.length > 20000) {
      return res.status(400).json({ error: 'Enter a SOQL SELECT query (maximum 20,000 characters).' });
    }
    const started = performance.now();
    const result = await run((client) => nextRecordsUrl
      ? client.queryMore(nextRecordsUrl)
      : client.query(normalizeReadOnlyQuery(query)));
    res.json({ ...result, elapsedMs: Math.round(performance.now() - started) });
  });

  app.use(express.static(fileURLToPath(new URL('../public', import.meta.url))));
  app.use((error, _req, res, next) => {
    if (res.headersSent) return next(error);
    const status = error.status === 400 ? 400 : 502;
    // Do not serialize the Salesforce connection, request, or credentials.
    const message = error.type === 'entity.parse.failed'
      ? 'Request body must be valid JSON.'
      : error.message || 'Salesforce request failed.';
    res.status(status).json({ error: message, code: error.errorCode || error.name });
  });
  return app;
}
