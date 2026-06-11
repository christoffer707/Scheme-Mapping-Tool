/**
 * live-compare.js
 * Frontend logic for the Live Dual-Instance Comparison page.
 * Handles credential input, API calls, ERD rendering, and results display.
 */

'use strict';

// ── State ──────────────────────────────────────────────────────────────────
const state = {
  inst1: { schema: null, network: null, connected: false, filterType: 'user_custom', searchQuery: '' },
  inst2: { schema: null, network: null, connected: false, filterType: 'user_custom', searchQuery: '' },
  schemaCompareResult: null,
  dataCompareResult:   null,
};

// ── DOM helpers ────────────────────────────────────────────────────────────

function $(id) { return document.getElementById(id); }

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function showAlert(containerId, type, message) {
  const el = $(containerId);
  if (!el) return;
  el.innerHTML = `<div class="alert alert-${type}"><span>${escHtml(message)}</span></div>`;
}

function clearAlert(containerId) {
  const el = $(containerId);
  if (el) el.innerHTML = '';
}

function showEl(id)  { const el = $(id); if (el) el.classList.remove('hidden'); }
function hideEl(id)  { const el = $(id); if (el) el.classList.add('hidden'); }
function showResults(id) { const el = $(id); if (el) el.classList.add('visible'); }
function hideResults(id) { const el = $(id); if (el) el.classList.remove('visible'); }

function setProgress(prefix, pct, label) {
  const wrap = $(`prog-${prefix}`);
  const fill = $(`prog-${prefix}-fill`);
  const lbl  = $(`prog-${prefix}-label`);
  if (!wrap) return;
  wrap.classList.add('visible');
  if (fill) fill.style.width = `${pct}%`;
  if (lbl)  lbl.textContent  = label || `${pct}%`;
}

function hideProgress(prefix) {
  const wrap = $(`prog-${prefix}`);
  if (wrap) wrap.classList.remove('visible');
}

function startFakeProgress(prefix, label) {
  setProgress(prefix, 5, label || 'Working…');
  let pct = 5;
  const id = setInterval(() => {
    pct = Math.min(pct + Math.random() * 10, 88);
    setProgress(prefix, Math.round(pct), label || 'Working…');
  }, 500);
  return id;
}

function stopFakeProgress(prefix, timerId, success) {
  clearInterval(timerId);
  setProgress(prefix, 100, success ? 'Done ✓' : 'Failed ✗');
  setTimeout(() => hideProgress(prefix), 1500);
}

function setStatus(inst, cls, text) {
  const el = $(`status-${inst}`);
  if (!el) return;
  el.className = `status-badge status-${cls}`;
  el.textContent = text;
}

// ── Accordion ──────────────────────────────────────────────────────────────

function toggleAccordion(id) {
  const body  = $(id);
  const key   = id.replace('acc-', '');
  const arrow = $(`arr-${key}`);
  if (!body) return;
  const open = body.classList.toggle('open');
  if (arrow) arrow.classList.toggle('open', open);
}
window.toggleAccordion = toggleAccordion;

// ── API helpers ────────────────────────────────────────────────────────────

async function apiPost(endpoint, body) {
  const res = await fetch(`/api/live/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ── Credential readers ─────────────────────────────────────────────────────

function getCredentials(n) {
  return {
    instance_url: $(`inst${n}-url`).value.trim(),
    username:     $(`inst${n}-user`).value.trim(),
    password:     $(`inst${n}-pass`).value,
  };
}

function validateCredentials(creds, label) {
  if (!creds.instance_url) throw new Error(`${label}: Instance URL is required.`);
  if (!creds.username)     throw new Error(`${label}: Username is required.`);
  if (!creds.password)     throw new Error(`${label}: Password is required.`);
}

// ── ERD Helpers ────────────────────────────────────────────────────────────

/**
 * Classify a table name into 'custom', 'core', or 'standard'.
 * - custom  : user-created (u_*) or custom-scoped (x_*) tables — green
 * - core    : built-in ServiceNow tables (sys_*, cmdb_*, well-known names) — purple
 * - standard: everything else — blue
 * @param {string} tableName
 * @returns {'custom'|'core'|'standard'}
 */
function getTableType(tableName) {
  if (tableName.startsWith('u_') || tableName.startsWith('x_')) return 'custom';
  if (
    tableName.startsWith('sys_') ||
    tableName.startsWith('cmdb_') ||
    tableName.startsWith('sn_') ||
    tableName.startsWith('sc_') ||
    tableName.startsWith('wf_') ||
    tableName.startsWith('kb_') ||
    ['incident', 'change_request', 'problem', 'request', 'sc_request',
     'catalog_item', 'sc_cat_item', 'task', 'approval', 'syslog',
     'sys_user', 'sys_user_group', 'sys_choice', 'sys_script'].includes(tableName)
  ) return 'core';
  return 'standard';
}

/**
 * Return vis.js colour config for a table based on its type.
 * Highlight overrides (added/removed/modified) take precedence in renderERD.
 * @param {string} tableName
 * @returns {{ bg: string, border: string }}
 */
function getTableColor(tableName) {
  switch (getTableType(tableName)) {
    case 'custom':   return { bg: '#1a7a4a', border: '#155f3a' }; // green
    case 'core':     return { bg: '#7c3aed', border: '#6d28d9' }; // purple
    default:         return { bg: '#0066cc', border: '#003d99' }; // blue
  }
}

// ── Table filtering ────────────────────────────────────────────────────────

/**
 * Filter a schema's table list for ERD display.
 *
 * @param {object} schema        Full schema object (must include raw_tables for full set)
 * @param {string} filterType    'user_custom' | 'all' | 'with_relationships'
 * @param {string} [searchQuery] Optional search string matched against name/label
 * @returns {object[]}           Filtered table array
 */
function filterTables(schema, filterType, searchQuery) {
  // Start from the full table list so the user can switch filters without re-fetching
  let filtered = schema.raw_tables || schema.tables || [];

  // Apply type filter
  if (filterType === 'user_custom') {
    filtered = filtered.filter(t => t.name.startsWith('u_') || t.name.startsWith('x_'));
  } else if (filterType === 'with_relationships') {
    const relatedNames = new Set(
      (schema.relationships || []).flatMap(r => [r.from, r.to])
    );
    filtered = filtered.filter(t => relatedNames.has(t.name));
  }
  // 'all' — no prefix filter

  // Apply search query
  if (searchQuery && searchQuery.trim()) {
    const q = searchQuery.trim().toLowerCase();
    filtered = filtered.filter(t =>
      t.name.toLowerCase().includes(q) ||
      (t.label || '').toLowerCase().includes(q)
    );
  }

  return filtered;
}

// ── ERD Rendering ──────────────────────────────────────────────────────────

/**
 * Render a vis.js network graph inside the given container element.
 *
 * @param {string}   containerId  ID of the .erd-network div
 * @param {object}   schema       Full schema object { tables, raw_tables, columns, relationships }
 * @param {object}   [highlights] { added: Set, removed: Set, modified: Set }
 * @param {object[]} [tableList]  Pre-filtered table list to render; if omitted, uses schema.tables
 * @returns {vis.Network}
 */
function renderERD(containerId, schema, highlights = {}, tableList) {
  const container = $(containerId);
  if (!container) return null;

  const nodes = [];
  const edges = [];

  const addedSet    = highlights.added    || new Set();
  const removedSet  = highlights.removed  || new Set();
  const modifiedSet = highlights.modified || new Set();

  // Use the provided pre-filtered list, or fall back to schema.tables
  const tables = tableList || schema.tables || [];

  // Build a set of visible table names for edge filtering
  const visibleTableNames = new Set(tables.map(t => t.name));

  // For large graphs (>200 nodes) disable physics entirely and use a
  // deterministic random layout to keep the browser responsive.
  const isLargeGraph = tables.length > 200;

  // Show / hide the large-graph notice banner (element may not exist for all containers)
  const noticeId = containerId.replace('erd-net-', 'erd-large-notice-');
  const noticeEl = $(noticeId);
  if (noticeEl) {
    if (isLargeGraph) {
      noticeEl.classList.remove('hidden');
    } else {
      noticeEl.classList.add('hidden');
    }
  }

  // Deterministic pseudo-random layout seed for large graphs so the positions
  // are stable across re-renders without running the physics engine.
  let seed = 42;
  function seededRand() {
    seed = (seed * 1664525 + 1013904223) & 0xffffffff;
    return (seed >>> 0) / 0xffffffff;
  }
  const SPREAD = 3000;

  tables.forEach((table, idx) => {
    // Highlight overrides take precedence over type-based colour
    let bg, border;
    if (addedSet.has(table.name)) {
      bg = '#1a7a4a'; border = '#155f3a';
    } else if (removedSet.has(table.name)) {
      bg = '#c0392b'; border = '#a93226';
    } else if (modifiedSet.has(table.name)) {
      bg = '#d68910'; border = '#b7770d';
    } else {
      const c = getTableColor(table.name);
      bg = c.bg; border = c.border;
    }

    const colCount = (schema.columns?.[table.name] || []).length;
    const node = {
      id:    table.name,
      label: table.label || table.name,
      title: `Table: ${table.name}\nColumns: ${colCount}`,
      color: {
        background: bg,
        border,
        highlight: { background: bg, border },
        hover:      { background: bg, border },
      },
      font:  { color: '#ffffff', size: 13 },
    };
    // Assign deterministic positions for large graphs so vis.js skips layout
    if (isLargeGraph) {
      node.x = (seededRand() - 0.5) * SPREAD;
      node.y = (seededRand() - 0.5) * SPREAD;
    }
    nodes.push(node);
  });

  // Only draw edges where both endpoints are visible
  (schema.relationships || []).forEach(rel => {
    if (!visibleTableNames.has(rel.from) || !visibleTableNames.has(rel.to)) return;
    edges.push({
      from:   rel.from,
      to:     rel.to,
      label:  rel.field,
      arrows: 'to',
      color:  { color: '#666666', highlight: '#0066cc', hover: '#0066cc' },
      font:   { size: 9, color: '#aaaaaa', strokeWidth: 0 },
      smooth: isLargeGraph ? false : { type: 'continuous' },
    });
  });

  const data    = { nodes: new vis.DataSet(nodes), edges: new vis.DataSet(edges) };
  const options = {
    physics: {
      enabled: !isLargeGraph,
      solver: 'forceAtlas2Based',
      forceAtlas2Based: {
        gravitationalConstant: -80,
        centralGravity: 0.005,
        springLength: 150,
        springConstant: 0.05,
        damping: 0.5,
      },
      stabilization: {
        enabled: !isLargeGraph,
        iterations: 200,
        updateInterval: 25,
        onlyDynamicEdges: false,
        fit: true,
      },
    },
    interaction: {
      navigationButtons: true,
      keyboard: false,
      zoomView: true,
      hover: true,
      tooltipDelay: 150,
    },
    nodes: {
      shape: 'box',
      margin: 8,
      borderWidth: 1,
      shadow: isLargeGraph ? false : { enabled: true, color: 'rgba(0,0,0,0.4)', size: 6, x: 2, y: 2 },
    },
    edges: {
      width: 1,
      selectionWidth: 2,
    },
    configure: false,
  };

  const network = new vis.Network(container, data, options);

  // For large graphs physics is already off; just fit the viewport once rendered.
  if (isLargeGraph) {
    network.once('afterDrawing', () => { network.fit(); });
  }

  return network;
}

// ── Table list rendering ───────────────────────────────────────────────────

function renderTableList(listId, tables, highlights = {}) {
  const container = $(listId);

  if (!container) return;

  const addedSet    = highlights.added    || new Set();
  const removedSet  = highlights.removed  || new Set();
  const modifiedSet = highlights.modified || new Set();

  container.innerHTML = '';

  if (!tables || tables.length === 0) {
    container.innerHTML = '<div class="empty-state">No tables found.</div>';
    return;
  }

  tables.forEach(table => {
    const div = document.createElement('div');
    div.className = 'table-list-item';
    if (addedSet.has(table.name))    div.classList.add('highlight-added');
    if (removedSet.has(table.name))  div.classList.add('highlight-removed');
    if (modifiedSet.has(table.name)) div.classList.add('highlight-modified');

    const colCount = table.column_count ?? 0;
    div.innerHTML = `
      <div>
        <div class="tli-name">${escHtml(table.name)}</div>
        <div class="tli-label">${escHtml(table.label || '')}</div>
      </div>
      <div class="tli-cols">${colCount} cols</div>
    `;
    container.appendChild(div);
  });
}

// ── Table search filter ────────────────────────────────────────────────────

function wireTableSearch(searchId, listId, tables, highlights) {
  const input = $(searchId);
  if (!input) return;
  input.addEventListener('input', () => {
    const q = input.value.toLowerCase();
    const filtered = q
      ? tables.filter(t => t.name.toLowerCase().includes(q) || (t.label || '').toLowerCase().includes(q))
      : tables;
    renderTableList(listId, filtered, highlights);
  });
}

// ── Connect instance ───────────────────────────────────────────────────────

async function connectInstance(n) {
  const prefix = `inst${n}`;
  const creds  = getCredentials(n);
  clearAlert(`alert-inst${n}`);

  try {
    validateCredentials(creds, `Instance ${n}`);
  } catch (err) {
    showAlert(`alert-inst${n}`, 'error', err.message);
    return;
  }

  setStatus(`inst${n}`, 'connecting', '⏳ Connecting…');
  const tid = startFakeProgress(prefix, 'Fetching schema from ServiceNow…');

  try {
    // Always fetch all tables from the server; client-side filtering handles display
    const schema = await apiPost('fetch-schema', {
      instance_url: creds.instance_url,
      username:     creds.username,
      password:     creds.password,
      include_core: false, // fetch u_*/x_* columns; raw_tables has everything
    });

    stopFakeProgress(prefix, tid, true);
    state[`inst${n}`].schema      = schema;
    state[`inst${n}`].connected   = true;
    // Preserve any filter the user already selected; default to user_custom
    const filterType  = state[`inst${n}`].filterType  || 'user_custom';
    const searchQuery = state[`inst${n}`].searchQuery || '';

    const totalTables    = schema.total_tables    ?? (schema.raw_tables || schema.tables).length;
    const filteredTables = filterTables(schema, filterType, searchQuery);

    setStatus(`inst${n}`, 'connected', `✓ Connected — ${totalTables} tables`);

    // Mark card as connected
    const card = $(`card-inst${n}`);
    if (card) { card.classList.add('connected'); card.classList.remove(n === 2 ? 'inst2' : ''); }

    // Update "Showing X of Y" counter
    updateErdCounter(n, filteredTables.length, totalTables);

    // Show ERD with filtered table list
    hideEl(`erd-ph-inst${n}`);
    showEl(`erd-net-inst${n}`);
    const network = renderERD(`erd-net-inst${n}`, schema, {}, filteredTables);
    state[`inst${n}`].network = network;

    // Show table list — use raw_tables (full set) so all tables are listed
    const allTables = schema.raw_tables || schema.tables || [];
    showEl(`table-list-inst${n}-wrap`);
    $(`table-count-inst${n}`).textContent = allTables.length;
    renderTableList(`table-list-inst${n}`, allTables);
    wireTableSearch(`table-search-inst${n}`, `table-list-inst${n}`, allTables, {});

    // Wire up the ERD filter dropdown and search input
    wireErdFilter(n);

    showAlert(`alert-inst${n}`, 'success',
      `Connected to ${creds.instance_url}. ` +
      `Showing ${filteredTables.length} of ${totalTables} tables` +
      `${schema.cached ? ' (cached)' : ''}.`
    );

    updateActionBar();
  } catch (err) {
    stopFakeProgress(prefix, tid, false);
    setStatus(`inst${n}`, 'error', '✗ Error');
    showAlert(`alert-inst${n}`, 'error', err.message);
  }
}

// ── ERD counter helper ─────────────────────────────────────────────────────

function updateErdCounter(n, filtered, total) {
  const filteredEl = $(`erd-filtered-inst${n}`);
  const totalEl    = $(`erd-total-inst${n}`);
  if (filteredEl) filteredEl.textContent = filtered;
  if (totalEl)    totalEl.textContent    = total;
}

// ── ERD filter wiring ──────────────────────────────────────────────────────

/**
 * Wire up the filter dropdown and search input for an instance's ERD.
 * Safe to call multiple times — removes old listeners by replacing elements.
 */
function wireErdFilter(n) {
  const filterSel = $(`table-filter-inst${n}`);
  const searchIn  = $(`erd-search-inst${n}`);
  if (!filterSel && !searchIn) return;

  const applyFilter = () => {
    const schema = state[`inst${n}`].schema;
    if (!schema) return;

    const filterType  = filterSel ? filterSel.value : (state[`inst${n}`].filterType || 'user_custom');
    const searchQuery = searchIn  ? searchIn.value   : (state[`inst${n}`].searchQuery || '');

    state[`inst${n}`].filterType  = filterType;
    state[`inst${n}`].searchQuery = searchQuery;

    const totalTables    = schema.total_tables ?? (schema.raw_tables || schema.tables).length;
    const filteredTables = filterTables(schema, filterType, searchQuery);

    updateErdCounter(n, filteredTables.length, totalTables);

    // Re-render ERD with new filter
    if (state[`inst${n}`].network) {
      state[`inst${n}`].network.destroy();
    }
    showEl(`erd-net-inst${n}`);
    state[`inst${n}`].network = renderERD(`erd-net-inst${n}`, schema, {}, filteredTables);
  };

  // Use a debounced handler for the search input to avoid re-rendering on every keystroke
  let searchTimer = null;
  const debouncedApply = () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(applyFilter, 250);
  };

  if (filterSel) {
    // Clone to remove any previously attached listeners
    const newSel = filterSel.cloneNode(true);
    filterSel.parentNode.replaceChild(newSel, filterSel);
    newSel.addEventListener('change', applyFilter);
  }

  if (searchIn) {
    const newIn = searchIn.cloneNode(true);
    searchIn.parentNode.replaceChild(newIn, searchIn);
    newIn.addEventListener('input', debouncedApply);
  }
}

// ── Update action bar ──────────────────────────────────────────────────────

function updateActionBar() {
  const both = state.inst1.connected && state.inst2.connected;
  $('btn-compare-schemas').disabled    = !both;
  $('btn-open-data-compare').disabled  = !both;
}

// ── Schema comparison ──────────────────────────────────────────────────────

async function compareSchemas() {
  clearAlert('alert-schemas');
  hideResults('results-schemas');

  const c1 = getCredentials(1);
  const c2 = getCredentials(2);

  const total1 = state.inst1.schema?.total_tables ?? state.inst1.schema?.tables?.length ?? '?';
  const total2 = state.inst2.schema?.total_tables ?? state.inst2.schema?.tables?.length ?? '?';
  const tid = startFakeProgress('inst1', `Comparing ${total1} + ${total2} tables…`);
  try {
    const result = await apiPost('compare-schemas', {
      instance1_url:  c1.instance_url,
      instance1_user: c1.username,
      instance1_pass: c1.password,
      instance2_url:  c2.instance_url,
      instance2_user: c2.username,
      instance2_pass: c2.password,
    });

    stopFakeProgress('inst1', tid, true);
    state.schemaCompareResult = result;
    renderSchemaResults(result);
    $('btn-download-report').disabled = false;
  } catch (err) {
    stopFakeProgress('inst1', tid, false);
    showAlert('alert-schemas', 'error', err.message);
    showResults('results-schemas');
  }
}

function renderSchemaResults(result) {
  showResults('results-schemas');

  const s = result.summary;
  $('schema-stats').innerHTML = `
    <div class="stat-box"><div class="stat-val">${s.total_inst1}</div><div class="stat-lbl">Inst 1 Tables</div></div>
    <div class="stat-box purple"><div class="stat-val">${s.total_inst2}</div><div class="stat-lbl">Inst 2 Tables</div></div>
    <div class="stat-box"><div class="stat-val" style="color:#0066cc">${s.common_count}</div><div class="stat-lbl">Common</div></div>
    <div class="stat-box green"><div class="stat-val">${s.added_count}</div><div class="stat-lbl">Added</div></div>
    <div class="stat-box red"><div class="stat-val">${s.removed_count}</div><div class="stat-lbl">Removed</div></div>
    <div class="stat-box amber"><div class="stat-val">${s.modified_count}</div><div class="stat-lbl">Modified</div></div>
  `;

  // Build highlight sets
  const addedSet    = new Set((result.added_tables   || []).map(t => t.name));
  const removedSet  = new Set((result.removed_tables || []).map(t => t.name));
  const modifiedSet = new Set((result.modified_tables || []).map(t => t.table));

  // Re-render ERDs with highlights, preserving each instance's current filter
  if (state.inst1.schema && state.inst1.network) {
    const filtered1 = filterTables(state.inst1.schema,
      state.inst1.filterType  || 'user_custom',
      state.inst1.searchQuery || '');
    state.inst1.network.destroy();
    state.inst1.network = renderERD('erd-net-inst1', state.inst1.schema,
      { removed: removedSet, modified: modifiedSet },
      filtered1);
  }
  if (state.inst2.schema && state.inst2.network) {
    const filtered2 = filterTables(state.inst2.schema,
      state.inst2.filterType  || 'user_custom',
      state.inst2.searchQuery || '');
    state.inst2.network.destroy();
    state.inst2.network = renderERD('erd-net-inst2', state.inst2.schema,
      { added: addedSet, modified: modifiedSet },
      filtered2);
  }

  // Re-render table lists with highlights — use raw_tables (full set)
  if (state.inst1.schema) {
    const allTables1 = state.inst1.schema.raw_tables || state.inst1.schema.tables || [];
    renderTableList('table-list-inst1', allTables1,
      { removed: removedSet, modified: modifiedSet });
  }
  if (state.inst2.schema) {
    const allTables2 = state.inst2.schema.raw_tables || state.inst2.schema.tables || [];
    renderTableList('table-list-inst2', allTables2,
      { added: addedSet, modified: modifiedSet });
  }

  // Added tables list
  $('badge-added-tables').textContent = s.added_count;
  const addedList = $('list-added-tables');
  addedList.innerHTML = '';
  if (result.added_tables.length === 0) {
    addedList.innerHTML = '<div class="empty-state">None</div>';
  } else {
    result.added_tables.forEach(t => {
      const div = document.createElement('div');
      div.className = 'table-list-item highlight-added';
      div.innerHTML = `<div><div class="tli-name">${escHtml(t.name)}</div><div class="tli-label">${escHtml(t.label || '')}</div></div>`;
      addedList.appendChild(div);
    });
  }

  // Removed tables list
  $('badge-removed-tables').textContent = s.removed_count;
  const removedList = $('list-removed-tables');
  removedList.innerHTML = '';
  if (result.removed_tables.length === 0) {
    removedList.innerHTML = '<div class="empty-state">None</div>';
  } else {
    result.removed_tables.forEach(t => {
      const div = document.createElement('div');
      div.className = 'table-list-item highlight-removed';
      div.innerHTML = `<div><div class="tli-name">${escHtml(t.name)}</div><div class="tli-label">${escHtml(t.label || '')}</div></div>`;
      removedList.appendChild(div);
    });
  }

  // Modified tables table
  $('badge-modified-tables').textContent = s.modified_count;
  const modTbody = $('tbl-modified').querySelector('tbody');
  modTbody.innerHTML = '';
  if (result.modified_tables.length === 0) {
    modTbody.innerHTML = '<tr><td colspan="5" class="empty-state">No column-level changes detected in common tables.</td></tr>';
  } else {
    result.modified_tables.forEach(t => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="mono">${escHtml(t.table)}<br><span class="text-muted">${escHtml(t.label || '')}</span></td>
        <td>${t.columns_added.length > 0
          ? t.columns_added.map(c => `<span class="badge badge-green">${escHtml(c)}</span>`).join(' ')
          : '<span class="text-muted">—</span>'}</td>
        <td>${t.columns_removed.length > 0
          ? t.columns_removed.map(c => `<span class="badge badge-red">${escHtml(c)}</span>`).join(' ')
          : '<span class="text-muted">—</span>'}</td>
        <td>${t.type_mismatches.length > 0
          ? t.type_mismatches.map(m => `<span class="badge badge-amber">${escHtml(m.column)}</span>`).join(' ')
          : '<span class="text-muted">—</span>'}</td>
        <td><strong>${t.change_count}</strong></td>
      `;
      modTbody.appendChild(tr);
    });
  }
}

// ── Data comparison ────────────────────────────────────────────────────────

async function runDataCompare() {
  const tableName   = $('data-table-name').value.trim();
  const keyCols     = $('data-key-cols').value.trim();
  const compareCols = $('data-compare-cols').value.trim();

  clearAlert('alert-data');
  hideResults('results-data');

  if (!tableName) { showAlert('alert-data', 'error', 'Table name is required.'); return; }
  if (!keyCols)   { showAlert('alert-data', 'error', 'Key columns are required.'); return; }

  const keyArr     = keyCols.split(',').map(s => s.trim()).filter(Boolean);
  const compareArr = compareCols ? compareCols.split(',').map(s => s.trim()).filter(Boolean) : [];

  const c1 = getCredentials(1);
  const c2 = getCredentials(2);

  const tid = startFakeProgress('data', `Fetching "${tableName}" from both instances…`);
  try {
    const result = await apiPost('compare-data', {
      instance1_url:  c1.instance_url,
      instance1_user: c1.username,
      instance1_pass: c1.password,
      instance2_url:  c2.instance_url,
      instance2_user: c2.username,
      instance2_pass: c2.password,
      table_name:     tableName,
      key_columns:    JSON.stringify(keyArr),
      compare_columns: JSON.stringify(compareArr),
    });

    stopFakeProgress('data', tid, true);
    state.dataCompareResult = result;
    renderDataResults(result);
    $('btn-download-report').disabled = false;
  } catch (err) {
    stopFakeProgress('data', tid, false);
    showAlert('alert-data', 'error', err.message);
  }
}

function renderDataResults(result) {
  showResults('results-data');
  $('data-result-table').textContent = result.table_name || '';

  const s = result.summary;
  $('data-stats').innerHTML = `
    <div class="stat-box"><div class="stat-val">${s.total_file1.toLocaleString()}</div><div class="stat-lbl">Inst 1 Rows</div></div>
    <div class="stat-box purple"><div class="stat-val">${s.total_file2.toLocaleString()}</div><div class="stat-lbl">Inst 2 Rows</div></div>
    <div class="stat-box green"><div class="stat-val">${s.added_count.toLocaleString()}</div><div class="stat-lbl">Added</div></div>
    <div class="stat-box red"><div class="stat-val">${s.removed_count.toLocaleString()}</div><div class="stat-lbl">Removed</div></div>
    <div class="stat-box amber"><div class="stat-val">${s.changed_count.toLocaleString()}</div><div class="stat-lbl">Changed</div></div>
    <div class="stat-box"><div class="stat-val">${s.unchanged_count.toLocaleString()}</div><div class="stat-lbl">Unchanged</div></div>
  `;

  $('badge-data-added').textContent   = s.added_count;
  $('badge-data-removed').textContent = s.removed_count;
  $('badge-data-changed').textContent = s.changed_count;

  renderGenericTable('tbl-data-added',   result.added_rows);
  renderGenericTable('tbl-data-removed', result.removed_rows);

  const changedTbody = $('tbl-data-changed').querySelector('tbody');
  changedTbody.innerHTML = '';
  if (!result.changed_rows || result.changed_rows.length === 0) {
    changedTbody.innerHTML = '<tr><td colspan="4" class="empty-state">No changed rows.</td></tr>';
  } else {
    result.changed_rows.forEach(row => {
      (row.changes || []).forEach((ch, i) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td class="mono">${i === 0 ? escHtml(row.key) : ''}</td>
          <td class="mono">${escHtml(ch.column)}</td>
          <td style="color:#c0392b">${escHtml(ch.old_value)}</td>
          <td style="color:#1a7a4a">${escHtml(ch.new_value)}</td>
        `;
        changedTbody.appendChild(tr);
      });
    });
  }
}

function renderGenericTable(tableId, rows) {
  const table = $(tableId);
  if (!table) return;
  const thead = table.querySelector('thead tr');
  const tbody = table.querySelector('tbody');
  thead.innerHTML = '';
  tbody.innerHTML = '';

  if (!rows || rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="99" class="empty-state">No rows.</td></tr>';
    return;
  }

  const cols = Object.keys(rows[0]);
  cols.forEach(c => {
    const th = document.createElement('th');
    th.textContent = c;
    thead.appendChild(th);
  });

  const MAX = 200;
  rows.slice(0, MAX).forEach(row => {
    const tr = document.createElement('tr');
    cols.forEach(c => {
      const td = document.createElement('td');
      td.textContent = row[c] ?? '';
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });

  if (rows.length > MAX) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td colspan="${cols.length}" class="text-muted" style="text-align:center;padding:10px;">
      … and ${rows.length - MAX} more rows (download report for full data)
    </td>`;
    tbody.appendChild(tr);
  }
}

// ── Report download ────────────────────────────────────────────────────────

function downloadReport() {
  const rows = [];

  // Schema summary
  if (state.schemaCompareResult) {
    const r = state.schemaCompareResult;
    const s = r.summary;
    rows.push(['=== SCHEMA COMPARISON ===']);
    rows.push(['Instance 1', r.instance1_url]);
    rows.push(['Instance 2', r.instance2_url]);
    rows.push(['Instance 1 Tables', s.total_inst1]);
    rows.push(['Instance 2 Tables', s.total_inst2]);
    rows.push(['Common Tables', s.common_count]);
    rows.push(['Added Tables', s.added_count]);
    rows.push(['Removed Tables', s.removed_count]);
    rows.push(['Modified Tables', s.modified_count]);
    rows.push([]);
    rows.push(['--- Added Tables (Instance 2 only) ---']);
    (r.added_tables || []).forEach(t => rows.push([t.name, t.label]));
    rows.push([]);
    rows.push(['--- Removed Tables (Instance 1 only) ---']);
    (r.removed_tables || []).forEach(t => rows.push([t.name, t.label]));
    rows.push([]);
    rows.push(['--- Modified Tables ---']);
    rows.push(['Table', 'Cols Added', 'Cols Removed', 'Type Changes', 'Total Changes']);
    (r.modified_tables || []).forEach(t => rows.push([
      t.table,
      t.columns_added.join('; '),
      t.columns_removed.join('; '),
      t.type_mismatches.map(m => `${m.column}: ${m.type_inst1}→${m.type_inst2}`).join('; '),
      t.change_count,
    ]));
    rows.push([]);
  }

  // Data summary
  if (state.dataCompareResult) {
    const r = state.dataCompareResult;
    const s = r.summary;
    rows.push(['=== DATA COMPARISON ===']);
    rows.push(['Table', r.table_name]);
    rows.push(['Key Columns', (r.key_columns || []).join(', ')]);
    rows.push(['Instance 1 Rows', s.total_file1]);
    rows.push(['Instance 2 Rows', s.total_file2]);
    rows.push(['Added Rows', s.added_count]);
    rows.push(['Removed Rows', s.removed_count]);
    rows.push(['Changed Rows', s.changed_count]);
    rows.push(['Unchanged Rows', s.unchanged_count]);
  }

  if (rows.length === 0) {
    showAlert('global-alert', 'warn', 'No comparison results to download yet. Run a comparison first.');
    return;
  }

  const csv = rows.map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `live_comparison_report_${new Date().toISOString().slice(0,10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── Event wiring ───────────────────────────────────────────────────────────

$('btn-connect-inst1').addEventListener('click', () => connectInstance(1));
$('btn-connect-inst2').addEventListener('click', () => connectInstance(2));

// Allow Enter key in credential fields
['inst1-url','inst1-user','inst1-pass'].forEach(id => {
  $(id)?.addEventListener('keydown', e => { if (e.key === 'Enter') connectInstance(1); });
});
['inst2-url','inst2-user','inst2-pass'].forEach(id => {
  $(id)?.addEventListener('keydown', e => { if (e.key === 'Enter') connectInstance(2); });
});

$('btn-compare-schemas').addEventListener('click', compareSchemas);

$('btn-open-data-compare').addEventListener('click', () => {
  showEl('data-compare-panel');
  $('data-compare-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
});

$('btn-close-data-panel').addEventListener('click', () => {
  hideEl('data-compare-panel');
});

$('btn-run-data-compare').addEventListener('click', runDataCompare);

$('btn-download-report').addEventListener('click', downloadReport);

// ── ERD filter controls are wired in wireErdFilter() called from connectInstance() ──
