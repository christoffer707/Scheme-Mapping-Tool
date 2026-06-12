/**
 * live-compare.js
 * Frontend logic for the Live Dual-Instance Comparison page.
 */

'use strict';

// ── State ──────────────────────────────────────────────────────────────────
const state = {
  inst1: { schema: null, network: null, connected: false, filterType: 'all', searchQuery: '' },
  inst2: { schema: null, network: null, connected: false, filterType: 'all', searchQuery: '' },
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

function toggleAccordion(id) {
  const body  = $(id);
  const key   = id.replace('acc-', '');
  const arrow = $(`arr-${key}`);
  if (!body) return;
  const open = body.classList.toggle('open');
  if (arrow) arrow.classList.toggle('open', open);
}
window.toggleAccordion = toggleAccordion;

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

function getCredentials(n) {
  return {
    instance_url: $(`inst${n}-url`).value.trim(),
    username:      $(`inst${n}-user`).value.trim(),
    password:      $(`inst${n}-pass`).value,
  };
}

function validateCredentials(creds, label) {
  if (!creds.instance_url) throw new Error(`${label}: Instance URL is required.`);
  if (!creds.username)     throw new Error(`${label}: Username is required.`);
  if (!creds.password)     throw new Error(`${label}: Password is required.`);
}

function getTableType(tableName, tableObj) {
  if (tableName.startsWith('u_') || tableName.startsWith('x_')) return 'custom';
  if (tableObj && tableObj.super_class) return 'extended';
  if (
    tableName.startsWith('sys_') ||
    tableName.startsWith('cmdb_') ||
    tableName.startsWith('sn_') ||
    ['incident', 'change_request', 'problem', 'request', 'sc_req_item', 'task'].includes(tableName)
  ) return 'core';
  return 'standard';
}

function getTableColor(tableName, tableObj) {
  const type = getTableType(tableName, tableObj);
  if (type === 'custom') return { bg: '#1a7a4a', border: '#155f3a' };
  if (type === 'extended') return { bg: '#e67e22', border: '#b9661a' }; 
  if (type === 'core') return { bg: '#7c3aed', border: '#6d28d9' };
  return { bg: '#0066cc', border: '#003d99' };
}

function filterTables(schema, filterType, searchQuery) {
  let filtered = schema.raw_tables || schema.tables || [];

  if (filterType === 'user_custom') {
    filtered = filtered.filter(t => t.name.startsWith('u_') || t.name.startsWith('x_'));
  } else if (filterType === 'with_relationships') {
    const relatedNames = new Set((schema.relationships || []).flatMap(r => [r.from, r.to]));
    filtered = filtered.filter(t => relatedNames.has(t.name));
  }

  if (searchQuery && searchQuery.trim()) {
    const q = searchQuery.trim().toLowerCase();
    filtered = filtered.filter(t => t.name.toLowerCase().includes(q) || (t.label || '').toLowerCase().includes(q));
  }
  return filtered;
}

// ── ERD Rendering Engine ───────────────────────────────────────────────────

function renderERD(containerId, schema, highlights = {}, tableList, noticeId, instanceNum) {
  const container = $(containerId);
  if (!container) return null;

  const tables = tableList || schema.tables || [];
  
  // RESTORED: This was missing and causing the ReferenceError crash
  const visibleTableNames = new Set(tables.map(t => t.name));
  
  const nodes = new vis.DataSet();
  const edges = new vis.DataSet(); 

  const addedSet    = highlights.added    || new Set();
  const removedSet  = highlights.removed  || new Set();
  const modifiedSet = highlights.modified || new Set();

  const isLargeGraph = tables.length > 200;
  const goldenAngle = 137.508 * (Math.PI / 180);

  tables.forEach((table, index) => {
    let bg, border;
    if (addedSet.has(table.name)) { bg = '#1a7a4a'; border = '#155f3a'; }
    else if (removedSet.has(table.name)) { bg = '#c0392b'; border = '#a93226'; }
    else if (modifiedSet.has(table.name)) { bg = '#d68910'; border = '#b7770d'; }
    else {
      const c = getTableColor(table.name, table);
      bg = c.bg; border = c.border;
    }

    const colCount = (schema.columns?.[table.name] || []).length;
    let nodeProps = {
      id:    table.name,
      label: table.name,
      title: `Table: ${table.name}\nColumns: ${colCount}`,
      color: {
        background: bg,
        border,
        highlight: { background: bg, border },
        hover:     { background: bg, border },
      },
      font:  { color: '#ffffff', size: 10 },
      shape: 'box',
      margin: 6
    };

    // Apply Fermat's Spiral math if large
    if (isLargeGraph) {
      const r = 30 * Math.sqrt(index);
      const theta = index * goldenAngle;
      nodeProps.x = r * Math.cos(theta);
      nodeProps.y = r * Math.sin(theta);
    }

    nodes.push(nodeProps);
  });

  if (!isLargeGraph) {
    (schema.relationships || []).forEach(rel => {
      if (!visibleTableNames.has(rel.from) || !visibleTableNames.has(rel.to)) return;
      edges.push({
        from:   rel.from,
        to:     rel.to,
        label:  rel.field,
        arrows: 'to',
        color:  { color: '#666666', highlight: '#00aaff', hover: '#00aaff' },
        font:   { size: 9, color: '#aaaaaa', strokeWidth: 0 },
        smooth: false
      });
    });
  } else {
    // Faint edges for big graphs
    (schema.relationships || []).forEach(rel => {
      if (!visibleTableNames.has(rel.from) || !visibleTableNames.has(rel.to)) return;
      edges.push({
        from:   rel.from,
        to:     rel.to,
        arrows: 'to',
        color:  { color: 'rgba(136,136,136,0.3)', highlight: '#00aaff', hover: '#00aaff' },
        smooth: false
      });
    });
  }

  const data = { nodes: new vis.DataSet(nodes), edges: new vis.DataSet(edges) };

  const options = {
    physics: { enabled: !isLargeGraph },
    layout: { improvedLayout: false },
    interaction: {
      navigationButtons: true,
      keyboard: false,
      zoomView: true,
      hideEdgesOnDrag: isLargeGraph,
      hideEdgesOnZoom: isLargeGraph
    },
    nodes: { borderWidth: 1, shadow: !isLargeGraph },
    edges: { width: 1, selectionWidth: 2 }
  };

  if (noticeId) {
    const noticeEl = $(noticeId);
    if (noticeEl) noticeEl.classList.toggle('visible', isLargeGraph);
  }

  const network = new vis.Network(container, data, options);

  if (!isLargeGraph) {
    network.once('stabilizationIterationsDone', () => {
      network.setOptions({ physics: { enabled: false } });
      network.fit();
    });
  } else {
    network.fit();
  }

  network.on("click", (params) => {
    if (params.nodes.length > 0) {
      focusTableOnInstance(instanceNum, params.nodes[0], schema, highlights, tables);

      // Highlight the list item 
      const listId = `table-list-inst${instanceNum}`;
      document.querySelectorAll(`#${listId} .table-list-item`).forEach(el => el.style.background = '');
      const listItem = $(`tli-${instanceNum}-${params.nodes[0]}`);
      if (listItem) {
        listItem.style.background = '#e6f2ff';
        listItem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }
  });

  return network;
}

function focusTableOnInstance(n, targetTableName, schema, highlights, tables) {
  const btn = $(`btn-back-macro-inst${n}`);
  if (btn) btn.classList.remove('hidden');

  const addedSet    = highlights.added    || new Set();
  const removedSet  = highlights.removed  || new Set();
  const modifiedSet = highlights.modified || new Set();

  const nodes = new vis.DataSet();
  const edges = new vis.DataSet();
  const addedNodes = new Set();
  const validTables = new Set(tables.map(t=>t.name));

  function addNode(tableName, isCenter = false) {
    if (addedNodes.has(tableName)) return;
    if (!validTables.has(tableName) && !addedSet.has(tableName) && !removedSet.has(tableName)) return;

    let bg, border;
    if (addedSet.has(tableName)) { bg = '#1a7a4a'; border = '#155f3a'; }
    else if (removedSet.has(tableName)) { bg = '#c0392b'; border = '#a93226'; }
    else if (modifiedSet.has(tableName)) { bg = '#d68910'; border = '#b7770d'; }
    else {
      // Find the table object to see if it's extended
      const tableObj = tables.find(t => t.name === tableName);
      const c = getTableColor(tableName, tableObj); 
      bg = c.bg; border = c.border;
    }

    nodes.add({
      id: tableName, label: tableName,
      color: { background: bg, border },
      font: { color: 'white', size: isCenter ? 16 : 12 },
      shape: 'box', margin: 10, borderWidth: isCenter ? 3 : 1, shadow: true
    });
    addedNodes.add(tableName);
  }

  addNode(targetTableName, true);

  (schema.relationships || []).forEach(rel => {
    if (rel.from === targetTableName || rel.to === targetTableName) {
      addNode(rel.from === targetTableName ? rel.to : rel.from);
      if (addedNodes.has(rel.from) && addedNodes.has(rel.to)) {
          edges.add({
            from: rel.from, to: rel.to, label: rel.field, arrows: 'to',
            color: { color: '#00aaff', highlight: '#ff9900' }, width: 2,
            font: { size: 11, color: '#111', background: '#ffffff', strokeWidth: 0, align: 'middle' },
            smooth: { type: 'curvedCW', roundness: 0.15 } 
          });
      }
    }
  });

  const network = state[`inst${n}`].network;
  network.setData({ nodes, edges });
  network.setOptions({
    physics: {
      enabled: true, solver: 'forceAtlas2Based',
      forceAtlas2Based: { gravitationalConstant: -100, centralGravity: 0.01, springConstant: 0.08, springLength: 200 },
      stabilization: { enabled: true, iterations: 150, updateInterval: 50 }
    },
    interaction: { hover: true, dragNodes: true, hideEdgesOnDrag: true }
  });

  network.once('stabilizationIterationsDone', () => {
    network.setOptions({ physics: { enabled: false } });
    network.fit({ animation: { duration: 500, easingFunction: 'easeInOutQuad' } });
  });
}

window.resetToMacroView = function(n) {
  const btn = $(`btn-back-macro-inst${n}`);
  if (btn) btn.classList.add('hidden');
  
  // Clear any list highlights
  document.querySelectorAll(`#table-list-inst${n} .table-list-item`).forEach(el => el.style.background = '');

  const schema = state[`inst${n}`].schema;
  const filterType = state[`inst${n}`].filterType;
  const searchQuery = state[`inst${n}`].searchQuery;
  
  let highlights = {};
  if (state.schemaCompareResult) {
     const addedSet    = new Set((state.schemaCompareResult.added_tables    || []).map(t => t.name));
     const removedSet  = new Set((state.schemaCompareResult.removed_tables || []).map(t => t.name));
     const modifiedSet = new Set((state.schemaCompareResult.modified_tables || []).map(t => t.table));
     if (n === 1) highlights = { removed: removedSet, modified: modifiedSet };
     if (n === 2) highlights = { added: addedSet, modified: modifiedSet };
  }

  const filteredTables = filterTables(schema, filterType, searchQuery);
  
  if (state[`inst${n}`].network) {
    state[`inst${n}`].network.destroy();
  }
  state[`inst${n}`].network = renderERD(`erd-net-inst${n}`, schema, highlights, filteredTables, `erd-large-notice-inst${n}`, n);
}

// ── Table list rendering ───────────────────────────────────────────────────

function renderTableList(listId, tables, highlights = {}, n) {
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
    div.id = `tli-${n}-${table.name}`; // Allows targeting on click

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

    div.onclick = () => {
      document.querySelectorAll(`#${listId} .table-list-item`).forEach(el => el.style.background = '');
      div.style.background = '#e6f2ff';

      if (n) {
        const schema = state[`inst${n}`].schema;
        focusTableOnInstance(n, table.name, schema, highlights, tables);
      }
    };

    container.appendChild(div);
  });
}

function wireTableSearch(searchId, listId, tables, highlights, n) {
  const input = $(searchId);
  if (!input) return;
  input.addEventListener('input', () => {
    const q = input.value.toLowerCase();
    const filtered = q
      ? tables.filter(t => t.name.toLowerCase().includes(q) || (t.label || '').toLowerCase().includes(q))
      : tables;
    renderTableList(listId, filtered, highlights, n);
  });
}

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
    const schema = await apiPost('fetch-schema', {
      instance_url: creds.instance_url,
      username:      creds.username,
      password:      creds.password,
      include_core: true, 
    });

    stopFakeProgress(prefix, tid, true);
    state[`inst${n}`].schema      = schema;
    state[`inst${n}`].connected   = true;

    const filterType  = state[`inst${n}`].filterType  || 'all';
    const searchQuery = state[`inst${n}`].searchQuery || '';

    const totalTables    = schema.total_tables    ?? (schema.raw_tables || schema.tables).length;
    const filteredTables = filterTables(schema, filterType, searchQuery);

    setStatus(`inst${n}`, 'connected', `✓ Connected — ${totalTables} tables`);

    const card = $(`card-inst${n}`);
    if (card) {
      card.classList.add('connected');
      if (n === 2) card.classList.remove('inst2'); 
    }

    updateErdCounter(n, filteredTables.length, totalTables);

    hideEl(`erd-ph-inst${n}`);
    showEl(`erd-net-inst${n}`);
    state[`inst${n}`].network = renderERD(`erd-net-inst${n}`, schema, {}, filteredTables, `erd-large-notice-inst${n}`, n);

    const allTables = schema.raw_tables || schema.tables || [];
    showEl(`table-list-inst${n}-wrap`);
    $(`table-count-inst${n}`).textContent = allTables.length;
    renderTableList(`table-list-inst${n}`, allTables, {}, n);
    wireTableSearch(`table-search-inst${n}`, `table-list-inst${n}`, allTables, {}, n);

    wireErdFilter(n);

    showAlert(`alert-inst${n}`, 'success',
      `Connected to ${creds.instance_url}. Showing ${filteredTables.length} of ${totalTables} tables.`
    );

    updateActionBar();
  } catch (err) {
    stopFakeProgress(prefix, tid, false);
    setStatus(`inst${n}`, 'error', '✗ Error');
    showAlert(`alert-inst${n}`, 'error', err.message);
  }
}

function updateErdCounter(n, filtered, total) {
  const filteredEl = $(`erd-filtered-inst${n}`);
  const totalEl    = $(`erd-total-inst${n}`);
  if (filteredEl) filteredEl.textContent = filtered;
  if (totalEl)    totalEl.textContent    = total;
}

function wireErdFilter(n) {
  const filterSel = $(`table-filter-inst${n}`);
  const searchIn  = $(`erd-search-inst${n}`);
  if (!filterSel && !searchIn) return;

  const applyFilter = () => {
    const schema = state[`inst${n}`].schema;
    if (!schema) return;

    const filterType  = filterSel ? filterSel.value : (state[`inst${n}`].filterType || 'all');
    const searchQuery = searchIn  ? searchIn.value   : (state[`inst${n}`].searchQuery || '');

    state[`inst${n}`].filterType  = filterType;
    state[`inst${n}`].searchQuery = searchQuery;

    const totalTables    = schema.total_tables ?? (schema.raw_tables || schema.tables).length;
    const filteredTables = filterTables(schema, filterType, searchQuery);

    updateErdCounter(n, filteredTables.length, totalTables);

    if (state[`inst${n}`].network) {
      state[`inst${n}`].network.destroy();
    }
    showEl(`erd-net-inst${n}`);
    state[`inst${n}`].network = renderERD(`erd-net-inst${n}`, schema, {}, filteredTables, `erd-large-notice-inst${n}`, n);
  };

  let searchTimer = null;
  const debouncedApply = () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(applyFilter, 250);
  };

  if (filterSel) {
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

function updateActionBar() {
  const both = state.inst1.connected && state.inst2.connected;
  $('btn-compare-schemas').disabled    = !both;
  $('btn-open-data-compare').disabled  = !both;
}

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

  const addedSet    = new Set((result.added_tables    || []).map(t => t.name));
  const removedSet  = new Set((result.removed_tables || []).map(t => t.name));
  const modifiedSet = new Set((result.modified_tables || []).map(t => t.table));

  if (state.inst1.schema && state.inst1.network) {
    const filtered1 = filterTables(state.inst1.schema, state.inst1.filterType || 'all', state.inst1.searchQuery || '');
    state.inst1.network.destroy();
    state.inst1.network = renderERD('erd-net-inst1', state.inst1.schema, { removed: removedSet, modified: modifiedSet }, filtered1, 'erd-large-notice-inst1', 1);
  }
  if (state.inst2.schema && state.inst2.network) {
    const filtered2 = filterTables(state.inst2.schema, state.inst2.filterType || 'all', state.inst2.searchQuery || '');
    state.inst2.network.destroy();
    state.inst2.network = renderERD('erd-net-inst2', state.inst2.schema, { added: addedSet, modified: modifiedSet }, filtered2, 'erd-large-notice-inst2', 2);
  }

  if (state.inst1.schema) {
    const list1 = state.inst1.schema.raw_tables || state.inst1.schema.tables;
    renderTableList('table-list-inst1', list1, { removed: removedSet, modified: modifiedSet }, 1);
  }
  if (state.inst2.schema) {
    const list2 = state.inst2.schema.raw_tables || state.inst2.schema.tables;
    renderTableList('table-list-inst2', list2, { added: addedSet, modified: modifiedSet }, 2);
  }

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
        <td>${t.columns_added.length > 0 ? t.columns_added.map(c => `<span class="badge badge-green">${escHtml(c)}</span>`).join(' ') : '<span class="text-muted">—</span>'}</td>
        <td>${t.columns_removed.length > 0 ? t.columns_removed.map(c => `<span class="badge badge-red">${escHtml(c)}</span>`).join(' ') : '<span class="text-muted">—</span>'}</td>
        <td>${t.type_mismatches.length > 0 ? t.type_mismatches.map(m => `<span class="badge badge-amber">${escHtml(m.column)}</span>`).join(' ') : '<span class="text-muted">—</span>'}</td>
        <td><strong>${t.change_count}</strong></td>
      `;
      modTbody.appendChild(tr);
    });
  }
}

// ── Data comparison ────────────────────────────────────────────────────────

async function runDataCompare() {
  const tableName   = $('data-table-name').value.trim();
  const keyCols      = $('data-key-cols').value.trim();
  const compareCols = $('data-compare-cols').value.trim();

  clearAlert('alert-data');
  hideResults('results-data');

  if (!tableName) { showAlert('alert-data', 'error', 'Table name is required.'); return; }

  const keyArr     = keyCols ? keyCols.split(',').map(s => s.trim()).filter(Boolean) : [];
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
      table_name:      tableName,
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

  const warningsDiv = $('data-schema-warnings');
  warningsDiv.innerHTML = '';
  let warnHtml = '';
  if (result.missing_in_1 && result.missing_in_1.length > 0) {
    warnHtml += `<div class="alert alert-warn"><strong>Warning:</strong> Instance 1 is missing columns present in Instance 2: <span class="mono">${result.missing_in_1.join(', ')}</span></div>`;
  }
  if (result.missing_in_2 && result.missing_in_2.length > 0) {
    warnHtml += `<div class="alert alert-warn"><strong>Warning:</strong> Instance 2 is missing columns present in Instance 1: <span class="mono">${result.missing_in_2.join(', ')}</span></div>`;
  }
  warningsDiv.innerHTML = warnHtml;

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
