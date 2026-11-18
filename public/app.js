const $ = (id) => document.getElementById(id);
const MIN_EDITOR_HEIGHT = 120;
const MAX_EDITOR_HEIGHT = 720;
const DEFAULT_EDITOR_HEIGHT = 182;

const storage = {
  get(key, fallback) {
    try {
      const value = localStorage.getItem(`soql.${key}`);
      return value === null ? fallback : value;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`soql.${key}`, value);
    } catch {
      // Storage can be unavailable in private or embedded contexts.
    }
  },
};

let objects = [];
let result;
let format = storage.get('format', 'table') === 'json' ? 'json' : 'table';
let busy = false;
let aiBusy = false;
let describeRequest = 0;
let currentObject;
let selectedObject = '';
const expandedPicklists = new Set();
let recordTypesOpen = storage.get('recordTypesOpen', 'true') === 'true';
let sessionBusy = false;
let resultQuery = '';
const history = [];
const aiModels = new Map();
const aiProviders = new Map();

function notify(message, type = 'success') {
  const toast = document.createElement('div');
  toast.className = type === 'error' ? 'toast toast-error' : 'toast';
  toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
  const text = document.createElement('span');
  text.textContent = message;
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'toast-close';
  close.textContent = '×';
  close.setAttribute('aria-label', 'Dismiss notification');
  let timer;
  const dismiss = () => {
    clearTimeout(timer);
    toast.remove();
  };
  close.addEventListener('click', dismiss);
  toast.append(text, close);
  $('toasts').append(toast);
  timer = setTimeout(dismiss, 5000);
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  storage.set('theme', theme);
  const toggle = $('theme-toggle');
  toggle.setAttribute('aria-pressed', String(theme === 'dark'));
  toggle.title = theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
}

function setEditorHeight(height, persist = true) {
  const clamped = Math.min(MAX_EDITOR_HEIGHT, Math.max(MIN_EDITOR_HEIGHT, Math.round(height)));
  document.documentElement.style.setProperty('--editor-height', `${clamped}px`);
  if (persist) storage.set('editorHeight', String(clamped));
}

const SOQL_KEYWORDS = new Set(`SELECT FROM WHERE AND OR NOT IN LIKE LIMIT OFFSET ORDER BY GROUP HAVING ASC DESC
  NULLS FIRST LAST WITH TYPEOF WHEN THEN ELSE END INCLUDES EXCLUDES USING SCOPE ROLLUP CUBE FOR VIEW REFERENCE
  UPDATE TRACKING VIEWSTAT SECURITY_ENFORCED USER_MODE SYSTEM_MODE DATA CATEGORY AT ABOVE BELOW ABOVE_OR_BELOW
  FORMAT CONVERTCURRENCY TOLABEL`.split(/\s+/));
const SOQL_LITERALS = /^(TRUE|FALSE|NULL|TODAY|YESTERDAY|TOMORROW|(THIS|LAST|NEXT)_(WEEK|MONTH|QUARTER|YEAR|FISCAL_QUARTER|FISCAL_YEAR|90_DAYS)|(LAST|NEXT)_N_[A-Z_]+|N_[A-Z_]+_AGO)$/;
const escapeHtml = (text) => text.replace(/[&<>]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[char]);

/** Lightweight SOQL tokenizer for the editor's highlight layer. */
function highlightSoql(source) {
  const pattern = /('(?:\\.|[^'\\])*'?)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][A-Za-z0-9_]*)(\s*\()?/g;
  let html = '';
  let last = 0;
  for (const match of source.matchAll(pattern)) {
    html += escapeHtml(source.slice(last, match.index));
    last = match.index + match[0].length;
    const [token, string, number, word, call] = match;
    if (string) html += `<span class="tok-string">${escapeHtml(string)}</span>`;
    else if (number) html += `<span class="tok-number">${number}</span>`;
    else {
      const upper = word.toUpperCase();
      const kind = call ? (SOQL_KEYWORDS.has(upper) ? 'keyword' : 'function')
        : SOQL_KEYWORDS.has(upper) ? 'keyword'
          : SOQL_LITERALS.test(upper) ? 'literal'
            : /__(c|r|mdt|e|x)$/i.test(word) ? 'custom' : '';
      html += kind ? `<span class="tok-${kind}">${escapeHtml(word)}</span>` : escapeHtml(word);
      if (call) html += escapeHtml(call);
    }
    void token;
  }
  // A trailing newline needs content after it to keep the layers the same height.
  return `${html}${escapeHtml(source.slice(last))}\n`;
}

function syncEditorScroll() {
  $('highlight').scrollTop = $('query').scrollTop;
  $('highlight').scrollLeft = $('query').scrollLeft;
  $('line-numbers').scrollTop = $('query').scrollTop;
}

function updateEditor() {
  $('highlight').innerHTML = highlightSoql($('query').value);
  syncEditorScroll();
  const lines = $('query').value.split('\n').length;
  $('line-numbers').textContent = Array.from({ length: lines }, (_, index) => index + 1).join('\n');
  $('editor-meta').textContent = `${lines} ${lines === 1 ? 'line' : 'lines'}`;
  $('run').disabled = busy || sessionBusy || !$('query').value.trim();
}

function setQuery(query) {
  $('query').value = query;
  storage.set('query', query);
  updateEditor();
  $('query').focus();
}

function hideError() {
  $('error').hidden = true;
}

function showError(error) {
  $('error-text').textContent = error.message;
  $('error').hidden = false;
}

function showSession(status) {
  $('connection').textContent = 'Connected';
  $('connection').classList.add('connected');
  $('connection').title = 'Check Salesforce connection';
  $('org-name').textContent = new URL(status.instanceUrl).hostname;
  $('api-version').textContent = `API ${status.apiVersion}`;
  $('session-info').textContent = status.authenticatedAt
    ? `Token issued ${new Date(status.authenticatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
    : 'Session active';
  document.querySelector('.session-dot').classList.add('active');
}

async function api(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error || 'Request failed.');
    error.code = data.code;
    throw error;
  }
  return data;
}

async function checkConnection(refresh = false) {
  if (sessionBusy || busy) return;
  sessionBusy = true;
  $('connection').disabled = true;
  $('refresh-token').disabled = true;
  $('refresh-token').textContent = refresh ? 'Refreshing…' : 'Refresh token';
  hideError();
  updateEditor();
  try {
    const status = await api(refresh ? '/api/auth/refresh' : '/api/status', refresh ? { method: 'POST' } : undefined);
    showSession(status);
    if (refresh) notify('Token refreshed.');
    objects = await api('/api/objects');
    renderObjects();
    const saved = selectedObject || storage.get('object', '');
    if (saved && objects.some((object) => object.name === saved)) await selectObject(saved);
  } catch (error) {
    if (!refresh) {
      $('connection').textContent = 'Retry connection';
      $('connection').classList.remove('connected');
      document.querySelector('.session-dot').classList.remove('active');
      $('session-info').textContent = 'Connection check failed';
    }
    showError(error);
  } finally {
    sessionBusy = false;
    $('connection').disabled = false;
    $('refresh-token').disabled = false;
    $('refresh-token').textContent = 'Refresh token';
    updateEditor();
  }
}

function renderObjects() {
  const filter = $('object-filter').value.trim().toLowerCase();
  const matches = objects.filter((object) => `${object.name} ${object.label}`.toLowerCase().includes(filter));
  $('object-count').textContent = filter
    ? `${matches.length} of ${objects.length}`
    : objects.length.toLocaleString();
  if (!matches.length) {
    const note = document.createElement('p');
    note.className = 'list-note';
    note.textContent = objects.length ? 'No objects match. Try the API name or label.' : 'No queryable objects found.';
    $('object-list').replaceChildren(note);
    return;
  }
  $('object-list').replaceChildren(...matches.map((object) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'list-item';
    button.setAttribute('role', 'listitem');
    if (object.name === selectedObject) button.setAttribute('aria-current', 'true');
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = object.name;
    if (object.label && object.label !== object.name) {
      const label = document.createElement('span');
      label.className = 'sub';
      label.textContent = object.label;
      name.append(label);
    }
    button.append(name);
    button.addEventListener('click', () => selectObject(object.name));
    return button;
  }));
}

function showObjectList() {
  $('field-pane').hidden = true;
  $('object-pane').hidden = false;
  renderObjects();
  $('object-list').querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'nearest' });
  $('object-filter').focus();
}

async function selectObject(name) {
  if (name !== selectedObject) expandedPicklists.clear();
  selectedObject = name;
  const object = objects.find((entry) => entry.name === name);
  $('field-object-name').textContent = name;
  $('field-object-label').textContent = object?.label && object.label !== name ? object.label : '';
  $('object-pane').hidden = true;
  $('field-pane').hidden = false;
  await describeObject();
}

function insertField(name) {
  const editor = $('query');
  editor.setRangeText(name, editor.selectionStart, editor.selectionEnd, 'end');
  editor.focus();
  storage.set('query', editor.value);
  updateEditor();
}

async function describeObject() {
  const request = ++describeRequest;
  const name = selectedObject;
  currentObject = undefined;
  $('field-filter').value = '';
  $('fields').replaceChildren();
  $('record-types').hidden = true;
  storage.set('object', name);
  if (!name) return;
  $('object-info').hidden = false;
  $('object-info').textContent = 'Loading fields…';
  try {
    const object = await api(`/api/objects/${encodeURIComponent(name)}`);
    if (request !== describeRequest) return;
    currentObject = object;
    renderFields();
  } catch (error) {
    if (request === describeRequest) {
      $('object-info').textContent = 'Could not load fields. Check the connection and pick the object again.';
      showError(error);
    }
  }
}

/** SOQL string literal: escape backslashes and single quotes. */
const soqlString = (value) => `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

function fieldButton(field) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'list-item field-item';
  const reference = field.referenceTo?.length && field.relationshipName;
  button.title = reference
    ? `Insert ${field.name}. Use ${field.relationshipName}.<field> to read the related ${field.referenceTo.join(' or ')}.`
    : `Insert ${field.name}`;
  const name = document.createElement('span');
  name.className = 'name';
  // Break long API names after underscores rather than mid-word.
  name.innerHTML = escapeHtml(field.name).replace(/_/g, '_<wbr>');
  const label = document.createElement('span');
  label.className = 'sub';
  label.textContent = field.label && field.label !== field.name ? field.label : '';
  button.append(name, label);
  if (!field.picklistValues) {
    const type = document.createElement('span');
    type.className = reference ? 'type ref' : 'type';
    type.textContent = reference ? `→ ${field.referenceTo.join(', ')}` : field.type;
    button.append(type);
  }
  button.addEventListener('click', () => insertField(field.name));
  return button;
}

function picklistBlock(field, filter, matchedByValue) {
  const values = field.picklistValues;
  const open = expandedPicklists.has(field.name) || matchedByValue;
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'values-toggle';
  toggle.setAttribute('aria-expanded', String(open));
  toggle.title = open ? 'Hide values' : 'Show values';
  toggle.textContent = `${field.type === 'multipicklist' ? 'multi-picklist' : 'picklist'} · ${values.length}`;

  const list = document.createElement('div');
  list.className = 'values';
  list.hidden = !open;
  list.id = `values-${field.name}`;
  toggle.setAttribute('aria-controls', list.id);
  // A field found only through its values lists just the values that matched.
  const shown = matchedByValue
    ? values.filter((entry) => `${entry.value} ${entry.label}`.toLowerCase().includes(filter))
    : values;
  if (!values.length) {
    const note = document.createElement('p');
    note.className = 'list-note';
    note.textContent = 'No active values.';
    list.append(note);
  }
  shown.forEach((entry) => {
    const value = document.createElement('button');
    value.type = 'button';
    value.className = 'value';
    if (filter && !matchedByValue && `${entry.value} ${entry.label}`.toLowerCase().includes(filter)) value.classList.add('match');
    value.title = `Insert ${soqlString(entry.value)}`;
    const code = document.createElement('span');
    code.className = 'value-code';
    code.textContent = entry.value;
    value.append(code);
    if (entry.label !== entry.value) {
      const label = document.createElement('span');
      label.className = 'sub';
      label.textContent = entry.label;
      value.append(label);
    }
    if (entry.default) {
      const tag = document.createElement('span');
      tag.className = 'default-tag';
      tag.textContent = 'default';
      value.append(tag);
    }
    value.addEventListener('click', () => insertField(soqlString(entry.value)));
    list.append(value);
  });

  toggle.addEventListener('click', () => {
    const next = list.hidden;
    list.hidden = !next;
    toggle.setAttribute('aria-expanded', String(next));
    toggle.title = next ? 'Hide values' : 'Show values';
    if (next) expandedPicklists.add(field.name);
    else expandedPicklists.delete(field.name);
  });
  return [toggle, list];
}

function recordTypeChip(text, insert, title, className) {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = `rt-chip ${className}`;
  chip.textContent = text;
  chip.title = title;
  chip.addEventListener('click', () => insertField(soqlString(insert)));
  return chip;
}

function renderRecordTypes(filter) {
  const all = currentObject.recordTypes || [];
  const block = $('record-types');
  const matches = all.filter((type) => !filter || `${type.name} ${type.developerName} ${type.id}`.toLowerCase().includes(filter));
  block.hidden = !all.length || (filter && !matches.length);
  if (block.hidden) return;
  const open = recordTypesOpen || Boolean(filter);
  const toggle = $('record-types-toggle');
  toggle.setAttribute('aria-expanded', String(open));
  $('record-types-count').textContent = filter ? `${matches.length} of ${all.length}` : all.length;
  $('record-types-list').hidden = !open;
  $('record-types-list').replaceChildren(...matches.map((type) => {
    const row = document.createElement('div');
    row.className = 'rt-row';
    row.setAttribute('role', 'listitem');
    const name = document.createElement('span');
    name.className = 'rt-name';
    name.textContent = type.name;
    if (type.default) {
      const tag = document.createElement('span');
      tag.className = 'default-tag';
      tag.textContent = 'default';
      name.append(' ', tag);
    }
    if (!type.active) {
      const tag = document.createElement('span');
      tag.className = 'default-tag';
      tag.textContent = 'inactive';
      name.append(' ', tag);
    }
    row.append(
      name,
      recordTypeChip(type.developerName, type.developerName, `Insert '${type.developerName}' (use with RecordType.DeveloperName)`, 'rt-dev'),
      recordTypeChip(type.id, type.id, `Insert '${type.id}' (use with RecordTypeId)`, 'rt-id'),
    );
    return row;
  }));
}

function renderFields() {
  if (!currentObject) return;
  renderRecordTypes($('field-filter').value.trim().toLowerCase());
  const { fields } = currentObject;
  const filter = $('field-filter').value.trim().toLowerCase();
  const valueText = (field) => (field.picklistValues || []).map((entry) => `${entry.value} ${entry.label}`).join(' ').toLowerCase();
  const matches = fields
    .map((field) => {
      const direct = `${field.name} ${field.label} ${field.type}`.toLowerCase().includes(filter);
      const byValue = Boolean(filter) && !direct && valueText(field).includes(filter);
      return { field, direct, byValue };
    })
    .filter(({ direct, byValue }) => direct || byValue);
  $('object-info').hidden = !filter || matches.length > 0;
  $('object-info').textContent = 'No fields match. Try the API name, label, type, or a picklist value.';
  if (filter && !matches.length && !$('record-types').hidden) $('object-info').hidden = true;
  $('fields').replaceChildren(...matches.map(({ field, byValue }) => {
    const row = document.createElement('div');
    row.className = field.picklistValues ? 'field-row has-values' : 'field-row';
    row.setAttribute('role', 'listitem');
    row.append(fieldButton(field));
    if (field.picklistValues) row.append(...picklistBlock(field, filter, byValue));
    return row;
  }));
}

function flatten(record, prefix = '', output = {}) {
  for (const [key, value] of Object.entries(record)) {
    if (key === 'attributes') continue;
    const name = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value) && !('records' in value)) {
      flatten(value, name, output);
    } else {
      output[name] = value;
    }
  }
  return output;
}

function renderResult() {
  if (!result) return;
  $('empty').hidden = true;
  $('table-view').hidden = format !== 'table';
  $('json-view').hidden = format !== 'json';
  $('table-tab').setAttribute('aria-pressed', String(format === 'table'));
  $('json-tab').setAttribute('aria-pressed', String(format === 'json'));
  $('json-view').textContent = JSON.stringify(result, null, 2);
  $('result-meta').textContent = `${result.totalSize.toLocaleString()} matching in Salesforce · ${result.elapsedMs} ms`;
  $('pagination-meta').textContent = result.done
    ? ''
    : `${result.records.length.toLocaleString()} of ${result.totalSize.toLocaleString()} records loaded`;
  $('load-more').hidden = result.done || !result.nextRecordsUrl;
  $('download').disabled = false;
  $('download-csv').disabled = false;
  $('result-context').hidden = false;
  $('result-query').textContent = resultQuery.replace(/\s+/g, ' ');
  $('result-query').title = resultQuery;
  $('result-filter').hidden = format !== 'table';
  const allRows = result.records.map((record) => flatten(record));
  const filter = $('result-filter').value.toLowerCase();
  const rows = allRows.map((row, index) => ({ row, index }))
    .filter(({ row }) => !filter || Object.values(row).some((value) => JSON.stringify(value)?.toLowerCase().includes(filter)));
  const columns = [...new Set(allRows.flatMap((row) => Object.keys(row)))];
  $('result-count').hidden = false;
  $('result-count').textContent = filter
    ? `${rows.length.toLocaleString()} of ${allRows.length.toLocaleString()} rows`
    : `${allRows.length.toLocaleString()} rows`;
  const table = document.createElement('table');
  const head = table.createTHead().insertRow();
  ['#', ...columns].forEach((column) => {
    const cell = document.createElement('th');
    cell.textContent = column;
    head.append(cell);
  });
  const body = table.createTBody();
  rows.forEach(({ row, index }) => {
    const tr = body.insertRow();
    [index + 1, ...columns.map((column) => row[column])].forEach((value, cellIndex) => {
      const cell = tr.insertCell();
      cell.textContent = value == null ? 'null' : typeof value === 'object' ? JSON.stringify(value) : String(value);
      if (value == null && cellIndex > 0) cell.classList.add('null');
      if (cellIndex > 0) cell.title = `Click to copy: ${cell.textContent}`;
    });
  });
  $('table-view').replaceChildren(table);
  if (!rows.length) {
    const message = document.createElement('p');
    message.className = 'no-records';
    message.textContent = filter ? 'No loaded records match this filter.' : result.totalSize > 0
      ? `Query returned a count of ${result.totalSize.toLocaleString()}.`
      : 'No records matched this query.';
    $('table-view').append(message);
  }
}

async function runQuery(more = false) {
  if (busy || sessionBusy || (!more && !$('query').value.trim())) return;
  const query = $('query').value;
  busy = true;
  $('refresh-token').disabled = true;
  $('connection').disabled = true;
  hideError();
  $('run').disabled = true;
  $('load-more').disabled = true;
  $('run').textContent = 'Running…';
  $('load-more').textContent = 'Loading…';
  $('query-loading').hidden = false;
  if (!result) $('empty').hidden = true;
  document.querySelector('.results-panel').setAttribute('aria-busy', 'true');
  try {
    const data = await api('/api/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(more ? { nextRecordsUrl: result.nextRecordsUrl } : { query }),
    });
    result = more ? { ...data, records: [...result.records, ...data.records] } : data;
    if (!more) {
      resultQuery = query;
      $('result-filter').value = '';
      const previous = history.indexOf(query);
      if (previous !== -1) history.splice(previous, 1);
      history.unshift(query);
      history.splice(10);
      $('history').replaceChildren(new Option('Restore a recent query…', ''));
      history.forEach((entry, index) => $('history').add(new Option(entry.replace(/\s+/g, ' ').slice(0, 100), String(index))));
      $('history').disabled = false;
    }
    renderResult();
  } catch (error) {
    showError(error);
  } finally {
    busy = false;
    $('refresh-token').disabled = false;
    $('connection').disabled = false;
    $('load-more').disabled = false;
    $('run').textContent = 'Run query';
    $('load-more').textContent = 'Load more records';
    $('query-loading').hidden = true;
    if (!result) $('empty').hidden = false;
    updateEditor();
    document.querySelector('.results-panel').setAttribute('aria-busy', 'false');
  }
}

function showAiAnswer(message, isError = false) {
  $('ai-answer').textContent = message;
  $('ai-answer').classList.toggle('is-error', isError);
  $('ai-answer').hidden = false;
}

function showAiUnavailable(message) {
  $('ai-panel').classList.add('unavailable');
  $('ai-question').disabled = true;
  $('ai-submit').disabled = true;
  $('ai-model').disabled = true;
  $('ai-provider-select').disabled = true;
  showAiAnswer(message, true);
}

function currentProvider() {
  return $('ai-provider-select').value;
}

function modelStorageKey(provider) {
  return `aiModel:${provider}`;
}

function formatModelPrice(model) {
  if (model.free) return 'Free';
  if (model.promptPrice == null || model.completionPrice == null) return 'Pricing unavailable';
  const format = (price) => price < 0.01 ? price.toFixed(3) : price.toFixed(2);
  return `$${format(model.promptPrice)}/M input · $${format(model.completionPrice)}/M output`;
}

function updateAiModelMeta() {
  const model = aiModels.get($('ai-model').value);
  if (!model) return;
  storage.set(modelStorageKey(currentProvider()), model.id);
  if (currentProvider() === 'claude-code') {
    $('ai-model-meta').textContent = 'Runs on this machine with your Claude Code login';
    $('ai-model-meta').title = model.name;
    return;
  }
  const context = model.contextLength
    ? `${Math.round(model.contextLength / 1000).toLocaleString()}K context`
    : 'Context unknown';
  $('ai-model-meta').textContent = `${context} · ${formatModelPrice(model)}`;
  $('ai-model-meta').title = model.description || model.name;
}

async function loadAiModels() {
  const provider = aiProviders.get(currentProvider());
  if (!provider) return;
  $('ai-model').disabled = true;
  $('ai-model').replaceChildren(new Option('Loading models…', ''));
  $('ai-model-meta').textContent = 'Fetching models…';
  try {
    const catalog = await api(`/api/ai/models?provider=${encodeURIComponent(provider.name)}`);
    if (currentProvider() !== provider.name) return;
    aiModels.clear();
    catalog.models.forEach((model) => aiModels.set(model.id, model));
    $('ai-model').replaceChildren(...catalog.models.map((model) => {
      const suffix = model.free ? ' · Free' : '';
      return new Option(`${model.name}${suffix}`, model.id);
    }));
    // 'aiModel' is the key used before providers could be switched.
    const saved = storage.get(modelStorageKey(provider.name), provider.name === 'openrouter' ? storage.get('aiModel', '') : '');
    $('ai-model').value = aiModels.has(saved)
      ? saved
      : aiModels.has(catalog.defaultModel) ? catalog.defaultModel : catalog.models[0]?.id || '';
    $('ai-model').disabled = false;
    updateAiModelMeta();
  } catch (error) {
    if (currentProvider() !== provider.name) return;
    const fallback = {
      id: provider.model,
      name: provider.model,
      contextLength: null,
      promptPrice: null,
      completionPrice: null,
      free: false,
    };
    aiModels.clear();
    aiModels.set(fallback.id, fallback);
    $('ai-model').replaceChildren(new Option(fallback.name, fallback.id));
    $('ai-model').disabled = false;
    updateAiModelMeta();
    notify(`Could not load the model catalog: ${error.message}`, 'error');
  }
}

async function loadAiStatus() {
  let status;
  try {
    status = await api('/api/ai/status');
  } catch {
    $('ai-model-meta').textContent = 'Could not check AI settings. Reload the page to try again.';
    return;
  }
  if (!status.configured) {
    showAiUnavailable('Add an AI provider key to .env (OPENAI_API_KEY, ANTHROPIC_API_KEY, GOOGLE_API_KEY, or OPEN_ROUTER_API_KEY) or set CLAUDE_CODE_ENABLED=true, restart the server, and ask a question here.');
    return;
  }
  const providers = status.providers?.length
    ? status.providers
    : [{ name: status.provider, label: status.provider, model: status.model, default: true }];
  aiProviders.clear();
  providers.forEach((provider) => aiProviders.set(provider.name, provider));
  $('ai-provider-select').replaceChildren(...providers.map((provider) => new Option(provider.label, provider.name)));
  const saved = storage.get('aiProvider', '');
  $('ai-provider-select').value = aiProviders.has(saved) ? saved : status.provider;
  $('ai-provider-select').disabled = providers.length < 2;
  await loadAiModels();
}

function changeAiProvider() {
  storage.set('aiProvider', currentProvider());
  $('ai-answer').hidden = true;
  loadAiModels();
}

async function askAi(question) {
  aiBusy = true;
  hideError();
  $('ai-answer').hidden = true;
  $('ai-submit').disabled = true;
  $('ai-model').disabled = true;
  $('ai-provider-select').disabled = true;
  $('ai-submit').textContent = 'Writing…';
  try {
    const suggestion = await api('/api/ai/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question,
        object: currentObject?.name,
        previousQuery: $('query').value,
        model: $('ai-model').value || undefined,
        provider: currentProvider() || undefined,
      }),
    });
    setQuery(suggestion.query);
    showAiAnswer(suggestion.explanation || 'SOQL written into the editor. Review it, then run it.');
  } catch (error) {
    if (error.code === 'LLM_NOT_CONFIGURED') {
      showAiUnavailable(error.message);
    } else if (error.code === 'AI_DECLINED') {
      showAiAnswer(`No query written. ${error.message}`);
    } else {
      showAiAnswer(error.message, true);
    }
  } finally {
    aiBusy = false;
    const unavailable = $('ai-question').disabled;
    $('ai-submit').disabled = unavailable;
    $('ai-model').disabled = unavailable;
    $('ai-provider-select').disabled = unavailable || aiProviders.size < 2;
    $('ai-submit').textContent = 'Write SOQL';
  }
}

$('theme-toggle').addEventListener('click', () => {
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
});
$('connection').addEventListener('click', () => checkConnection());
$('refresh-token').addEventListener('click', () => checkConnection(true));
$('error-dismiss').addEventListener('click', hideError);
$('field-filter').addEventListener('input', renderFields);
$('result-filter').addEventListener('input', renderResult);
$('query').addEventListener('input', () => {
  storage.set('query', $('query').value);
  updateEditor();
});
$('query').addEventListener('scroll', syncEditorScroll);
$('select-query').addEventListener('click', () => { $('query').focus(); $('query').select(); });
$('clear-query').addEventListener('click', () => setQuery(''));
$('copy-query').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('query').value);
    notify('Query copied to clipboard.');
  } catch {
    $('query').focus();
    $('query').select();
    notify('Query selected. Press ⌘C / Ctrl+C to copy.');
  }
});
$('editor-resize').addEventListener('pointerdown', (event) => {
  event.preventDefault();
  const handle = event.currentTarget;
  const startY = event.clientY;
  const startHeight = $('query').offsetHeight;
  handle.setPointerCapture(event.pointerId);
  const onMove = (moveEvent) => setEditorHeight(startHeight + moveEvent.clientY - startY, false);
  const onUp = () => {
    handle.removeEventListener('pointermove', onMove);
    handle.removeEventListener('pointerup', onUp);
    setEditorHeight($('query').offsetHeight);
  };
  handle.addEventListener('pointermove', onMove);
  handle.addEventListener('pointerup', onUp);
});
$('editor-resize').addEventListener('keydown', (event) => {
  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
  event.preventDefault();
  setEditorHeight($('query').offsetHeight + (event.key === 'ArrowDown' ? 26 : -26));
});
$('editor-resize').addEventListener('dblclick', () => setEditorHeight(DEFAULT_EDITOR_HEIGHT));
$('table-view').addEventListener('click', async (event) => {
  const cell = event.target.closest('td');
  if (!cell || cell.cellIndex === 0) return;
  const value = cell.textContent;
  if (!value || cell.classList.contains('null')) return;
  try {
    await navigator.clipboard.writeText(value);
    cell.classList.add('copied');
    setTimeout(() => cell.classList.remove('copied'), 900);
  } catch {
    notify('Clipboard unavailable in this browser.', 'error');
  }
});
$('history').addEventListener('change', () => {
  if ($('history').value !== '') setQuery(history[Number($('history').value)]);
});
$('object-filter').addEventListener('input', renderObjects);
$('object-filter').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') $('object-list').querySelector('.list-item')?.click();
});
$('object-back').addEventListener('click', showObjectList);
$('record-types-toggle').addEventListener('click', () => {
  recordTypesOpen = $('record-types-toggle').getAttribute('aria-expanded') !== 'true';
  storage.set('recordTypesOpen', String(recordTypesOpen));
  renderRecordTypes($('field-filter').value.trim().toLowerCase());
});
$('use-object').addEventListener('click', () => {
  if (!selectedObject) return;
  const hasName = currentObject?.fields.some((field) => field.name === 'Name');
  setQuery(`SELECT Id${hasName ? ', Name' : ''}\nFROM ${selectedObject}\nLIMIT 25`);
});
$('run').addEventListener('click', () => runQuery());
$('ai-model').addEventListener('change', updateAiModelMeta);
$('ai-provider-select').addEventListener('change', changeAiProvider);
$('ai-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const question = $('ai-question').value.trim();
  if (!question || aiBusy) return;
  askAi(question);
});
$('load-more').addEventListener('click', () => runQuery(true));
$('query').addEventListener('keydown', (event) => {
  if (!(event.metaKey || event.ctrlKey)) return;
  if (event.key.toLowerCase() === 'a') {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.select();
  } else if (event.key === 'Enter') {
    event.preventDefault();
    event.stopPropagation();
    runQuery();
  }
});
document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
    event.preventDefault();
    runQuery();
  } else if (event.key === 'Escape' && !$('error').hidden) {
    hideError();
  }
});
document.querySelectorAll('[data-query]').forEach((button) => {
  button.addEventListener('click', () => setQuery(button.dataset.query.replace(/ FROM /, '\nFROM ').replace(/ LIMIT /, '\nLIMIT ')));
});
for (const view of ['table', 'json']) {
  $(`${view}-tab`).addEventListener('click', () => {
    format = view;
    storage.set('format', view);
    renderResult();
  });
}
function saveFile(contents, type, extension) {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const link = document.createElement('a');
  link.href = url;
  const object = resultQuery.match(/\bFROM\s+([A-Za-z0-9_]+)/i)?.[1] || 'soql';
  link.download = `${object}-results.${extension}`;
  link.click();
  URL.revokeObjectURL(url);
}

function toCsv(records) {
  const rows = records.map((record) => flatten(record));
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const cell = (value) => {
    if (value == null) return '';
    const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [columns.map(cell).join(','), ...rows.map((row) => columns.map((column) => cell(row[column])).join(','))].join('\r\n');
}

$('download').addEventListener('click', () => {
  if (result) saveFile(JSON.stringify(result.records, null, 2), 'application/json', 'json');
});
$('download-csv').addEventListener('click', () => {
  if (result) saveFile(toCsv(result.records), 'text/csv', 'csv');
});

if (!/Mac|iPhone|iPad/.test(navigator.platform)) document.querySelector('.shortcut kbd').textContent = 'Ctrl';
applyTheme(storage.get('theme', window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
setEditorHeight(Number(storage.get('editorHeight', DEFAULT_EDITOR_HEIGHT)), false);
const restoredQuery = storage.get('query', '');
if (restoredQuery) $('query').value = restoredQuery;
updateEditor();
checkConnection();
loadAiStatus();
