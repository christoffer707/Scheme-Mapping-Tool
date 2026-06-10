/**
 * comparison.js — Frontend logic for the Instance Comparison & Analysis page.
 * Handles file uploads, API calls, progress tracking, and results rendering.
 */

'use strict';

// ── State ──────────────────────────────────────────────────────────────────
const state = {
  schemaResult:  null,
  dataResult:    null,
  analyzeResult: null,
  keysResult:    null,
  scrubColumns:  new Set(),
  keysColumns:   new Set(),
  // Loaded column lists for interactive pickers
  scrubAllCols:  [],
  keysAllCols:   [],
};

// ── Helpers ────────────────────────────────────────────────────────────────

function $(id) { return document.getElementById(id); }

function showAlert(containerId, type, message) {
  const el = $(containerId);
  if (!el) return;
  el.innerHTML = `<div class="alert alert-${type}"><span>${message}</span></div>`;
}

function clearAlert(containerId) {
  const el = $(containerId);
  if (el) el.innerHTML = '';
}

function setProgress(prefix, pct, label) {
  const wrap  = $(`prog-${prefix}`);
  const fill  = $(`prog-${prefix}-fill`);
  const lbl   = $(`prog-${prefix}-label`);
  if (!wrap) return;
  wrap.classList.add('visible');
  if (fill) fill.style.width = `${pct}%`;
  if (lbl)  lbl.textContent  = label || `${pct}%`;
}

function hideProgress(prefix) {
  const wrap = $(`prog-${prefix}`);
  if (wrap) wrap.classList.remove('visible');
}

function showResults(id) {
  const el = $(id);
  if (el) el.classList.add('visible');
}

function hideResults(id) {
  const el = $(id);
  if (el) el.classList.remove('visible');
}

function badge(text, cls) {
  return `<span class="badge badge-${cls}">${text}</span>`;
}

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function typeBadge(type) {
  const map = {
    email: 'blue', phone: 'blue', ssn: 'red', credit_card: 'red',
    ip_address: 'amber', uuid: 'gray', url: 'blue', date: 'green',
    currency: 'green', boolean: 'amber', integer: 'green', float: 'green',
    string: 'gray', name: 'blue', address: 'blue', zip_code: 'amber',
    unknown: 'gray',
  };
  return badge(escHtml(type), map[type] || 'gray');
}

function confBar(conf) {
  const pct = Math.round((conf || 0) * 100);
  const col = pct >= 80 ? '#1a7a4a' : pct >= 50 ? '#d68910' : '#c0392b';
  return `<div style="display:flex;align-items:center;gap:6px;">
    <div style="flex:1;background:#eee;border-radius:99px;height:6px;overflow:hidden;">
      <div style="width:${pct}%;background:${col};height:100%;border-radius:99px;"></div>
    </div>
    <span style="font-size:11px;color:#666;min-width:30px;">${pct}%</span>
  </div>`;
}

// ── Tab switching ──────────────────────────────────────────────────────────

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.mode-panel').forEach(p => p.classList.add('hidden'));
    btn.classList.add('active');
    const panel = $(`panel-${btn.dataset.mode}`);
    if (panel) panel.classList.remove('hidden');
  });
});

// ── Accordion ──────────────────────────────────────────────────────────────

function toggleAccordion(id) {
  const body  = $(id);
  const arrow = $(`arr-${id.replace('acc-', '')}`);
  if (!body) return;
  const open = body.classList.toggle('open');
  if (arrow) arrow.classList.toggle('open', open);
}
window.toggleAccordion = toggleAccordion;

// ── Drop-zone wiring ───────────────────────────────────────────────────────

document.querySelectorAll('.drop-zone').forEach(zone => {
  const inputId = zone.dataset.target;
  const input   = $(inputId);
  if (!input) return;

  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('drag-over');
    if (e.dataTransfer.files.length) {
      input.files = e.dataTransfer.files;
      input.dispatchEvent(new Event('change'));
    }
  });

  input.addEventListener('change', () => {
    const nameEl = $(`${inputId}-name`);
    if (nameEl && input.files.length) {
      nameEl.textContent = `✓ ${input.files[0].name}`;
      // If this is the scrub or keys file, load column list
      if (inputId === 'scrub-file')   loadColumnsForScrub(input.files[0]);
      if (inputId === 'keys-file')    loadColumnsForKeys(input.files[0]);
      if (inputId === 'analyze-file') { /* nothing extra */ }
    }
  });
});

// ── Column preview (client-side header sniff) ──────────────────────────────

async function sniffColumns(file) {
  return new Promise((resolve) => {
    const ext = file.name.split('.').pop().toLowerCase();
    if (ext === 'csv') {
      const reader = new FileReader();
      reader.onload = e => {
        const firstLine = e.target.result.split('\n')[0];
        const cols = firstLine.split(',').map(c => c.trim().replace(/^"|"$/g, ''));
        resolve(cols);
      };
      reader.readAsText(file.slice(0, 4096));
    } else {
      // For Excel we can't easily sniff client-side without a library;
      // return empty and let the server handle it.
      resolve([]);
    }
  });
}

async function loadColumnsForScrub(file) {
  const cols = await sniffColumns(file);
  state.scrubAllCols = cols;
  state.scrubColumns.clear();
  renderScrubPills(cols);
}

async function loadColumnsForKeys(file) {
  const cols = await sniffColumns(file);
  state.keysAllCols = cols;
  state.keysColumns.clear();
  renderKeysPills(cols);
}

function renderScrubPills(cols) {
  const container = $('scrub-col-pills');
  if (!container) return;
  container.innerHTML = '';
  cols.forEach(col => {
    const pill = document.createElement('span');
    pill.className = 'pill pill-select';
    pill.textContent = col;
    pill.dataset.col = col;
    pill.addEventListener('click', () => {
      if (state.scrubColumns.has(col)) {
        state.scrubColumns.delete(col);
        pill.classList.remove('selected');
      } else {
        state.scrubColumns.add(col);
        pill.classList.add('selected');
      }
      syncScrubInput();
    });
    container.appendChild(pill);
  });
}

function renderKeysPills(cols) {
  const container = $('keys-col-pills');
  if (!container) return;
  container.innerHTML = '';
  cols.forEach(col => {
    const pill = document.createElement('span');
    pill.className = 'pill pill-select';
    pill.textContent = col;
    pill.dataset.col = col;
    pill.addEventListener('click', () => {
      if (state.keysColumns.has(col)) {
        state.keysColumns.delete(col);
        pill.classList.remove('selected');
      } else {
        state.keysColumns.add(col);
        pill.classList.add('selected');
      }
    });
    container.appendChild(pill);
  });
}

function syncScrubInput() {
  const input = $('scrub-cols-input');
  if (input) input.value = [...state.scrubColumns].join(', ');
}

// ── API helpers ────────────────────────────────────────────────────────────

async function apiPost(endpoint, formData) {
  const res = await fetch(`/api/${endpoint}`, { method: 'POST', body: formData });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const j = await res.json(); msg = j.error || msg; } catch { /* ignore */ }
    throw new Error(msg);
  }
  return res;
}

async function apiPostJSON(endpoint, formData) {
  const res = await apiPost(endpoint, formData);
  return res.json();
}

async function apiPostBlob(endpoint, formData) {
  const res = await apiPost(endpoint, formData);
  return res.blob();
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href     = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── Fake SSE progress (simulated while waiting for response) ───────────────

function startFakeProgress(prefix, label) {
  setProgress(prefix, 5, label || 'Uploading…');
  let pct = 5;
  const id = setInterval(() => {
    pct = Math.min(pct + Math.random() * 8, 90);
    setProgress(prefix, Math.round(pct), label || 'Processing…');
  }, 400);
  return id;
}

function stopFakeProgress(prefix, timerId, success) {
  clearInterval(timerId);
  setProgress(prefix, 100, success ? 'Done ✓' : 'Failed ✗');
  setTimeout(() => hideProgress(prefix), 1500);
}

// ══════════════════════════════════════════════════════════════════════════
// SCHEMA COMPARE
// ══════════════════════════════════════════════════════════════════════════

$('btn-compare-schemas').addEventListener('click', async () => {
  const f1 = $('schema-file1').files[0];
  const f2 = $('schema-file2').files[0];
  clearAlert('alert-schemas');
  hideResults('results-schemas');

  if (!f1 || !f2) {
    showAlert('alert-schemas', 'error', 'Please upload both files before comparing.');
    return;
  }

  const fd = new FormData();
  fd.append('file1', f1);
  fd.append('file2', f2);

  const tid = startFakeProgress('schemas', 'Comparing schemas…');
  try {
    const data = await apiPostJSON('compare/schemas', fd);
    stopFakeProgress('schemas', tid, true);
    state.schemaResult = data;
    renderSchemaResults(data);
    $('btn-schema-report').disabled = false;
  } catch (err) {
    stopFakeProgress('schemas', tid, false);
    showAlert('alert-schemas', 'error', err.message);
  }
});

$('btn-schema-report').addEventListener('click', async () => {
  if (!state.schemaResult) return;
  const f1 = $('schema-file1').files[0];
  const f2 = $('schema-file2').files[0];
  if (!f1 || !f2) return;

  const fd = new FormData();
  fd.append('file1', f1);
  fd.append('file2', f2);
  fd.append('include_schema', 'true');
  fd.append('include_data', 'false');
  fd.append('key_columns', '[]');

  try {
    const blob = await apiPostBlob('compare/report', fd);
    downloadBlob(blob, 'schema_comparison_report.xlsx');
  } catch (err) {
    showAlert('alert-schemas', 'error', err.message);
  }
});

function renderSchemaResults(data) {
  showResults('results-schemas');

  // Stats
  const s = data.summary;
  $('schema-stats').innerHTML = `
    <div class="stat-box"><div class="stat-val">${s.total_file1}</div><div class="stat-lbl">File 1 Cols</div></div>
    <div class="stat-box"><div class="stat-val">${s.total_file2}</div><div class="stat-lbl">File 2 Cols</div></div>
    <div class="stat-box blue"><div class="stat-val">${s.common_count}</div><div class="stat-lbl">Common</div></div>
    <div class="stat-box green"><div class="stat-val">${s.added_count}</div><div class="stat-lbl">Added</div></div>
    <div class="stat-box red"><div class="stat-val">${s.removed_count}</div><div class="stat-lbl">Removed</div></div>
    <div class="stat-box amber"><div class="stat-val">${s.type_mismatches}</div><div class="stat-lbl">Type Mismatches</div></div>
  `.replace(/class="stat-box blue"/, 'class="stat-box"')
   .replace(/class="stat-box green"/, 'class="stat-box green"')
   .replace(/class="stat-box red"/, 'class="stat-box red"')
   .replace(/class="stat-box amber"/, 'class="stat-box amber"');

  // Re-render with proper classes
  $('schema-stats').innerHTML = `
    <div class="stat-box"><div class="stat-val">${s.total_file1}</div><div class="stat-lbl">File 1 Cols</div></div>
    <div class="stat-box"><div class="stat-val">${s.total_file2}</div><div class="stat-lbl">File 2 Cols</div></div>
    <div class="stat-box"><div class="stat-val" style="color:#0066cc">${s.common_count}</div><div class="stat-lbl">Common</div></div>
    <div class="stat-box green"><div class="stat-val">${s.added_count}</div><div class="stat-lbl">Added</div></div>
    <div class="stat-box red"><div class="stat-val">${s.removed_count}</div><div class="stat-lbl">Removed</div></div>
    <div class="stat-box amber"><div class="stat-val">${s.type_mismatches}</div><div class="stat-lbl">Type Mismatches</div></div>
  `;

  // Common columns table
  $('badge-common').textContent = s.common_count;
  const tbody = $('tbl-common').querySelector('tbody');
  tbody.innerHTML = '';
  (data.comparison_data || []).forEach(row => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="mono">${escHtml(row.column)}</td>
      <td>${typeBadge(row.type_file1)}</td>
      <td>${typeBadge(row.type_file2)}</td>
      <td>${row.type_match ? badge('✓ Match', 'green') : badge('✗ Mismatch', 'red')}</td>
      <td>${confBar(row.conf_file1)}</td>
      <td>${confBar(row.conf_file2)}</td>
    `;
    tbody.appendChild(tr);
  });

  // Added pills
  const addedEl = $('pills-added');
  addedEl.innerHTML = data.added.length === 0
    ? '<span class="text-muted">None</span>'
    : data.added.map(c => `<span class="pill pill-added">${escHtml(c)}</span>`).join('');

  // Removed pills
  const removedEl = $('pills-removed');
  removedEl.innerHTML = data.removed.length === 0
    ? '<span class="text-muted">None</span>'
    : data.removed.map(c => `<span class="pill pill-removed">${escHtml(c)}</span>`).join('');
}

// ══════════════════════════════════════════════════════════════════════════
// DATA COMPARE
// ══════════════════════════════════════════════════════════════════════════

$('btn-compare-data').addEventListener('click', async () => {
  const f1 = $('data-file1').files[0];
  const f2 = $('data-file2').files[0];
  const keyCols     = $('data-key-cols').value.trim();
  const compareCols = $('data-compare-cols').value.trim();
  clearAlert('alert-data');
  hideResults('results-data');

  if (!f1 || !f2) {
    showAlert('alert-data', 'error', 'Please upload both files before comparing.');
    return;
  }
  if (!keyCols) {
    showAlert('alert-data', 'error', 'Key columns are required. Enter at least one column name.');
    return;
  }

  const keyArr     = keyCols.split(',').map(s => s.trim()).filter(Boolean);
  const compareArr = compareCols ? compareCols.split(',').map(s => s.trim()).filter(Boolean) : [];

  const fd = new FormData();
  fd.append('file1', f1);
  fd.append('file2', f2);
  fd.append('key_columns',     JSON.stringify(keyArr));
  fd.append('compare_columns', JSON.stringify(compareArr));

  const tid = startFakeProgress('data', 'Comparing data rows…');
  try {
    const data = await apiPostJSON('compare/data', fd);
    stopFakeProgress('data', tid, true);
    state.dataResult = data;
    renderDataResults(data);
    $('btn-data-report').disabled = false;
  } catch (err) {
    stopFakeProgress('data', tid, false);
    showAlert('alert-data', 'error', err.message);
  }
});

$('btn-data-report').addEventListener('click', async () => {
  if (!state.dataResult) return;
  const f1 = $('data-file1').files[0];
  const f2 = $('data-file2').files[0];
  if (!f1 || !f2) return;

  const keyCols     = $('data-key-cols').value.trim();
  const compareCols = $('data-compare-cols').value.trim();
  const keyArr      = keyCols.split(',').map(s => s.trim()).filter(Boolean);
  const compareArr  = compareCols ? compareCols.split(',').map(s => s.trim()).filter(Boolean) : [];

  const fd = new FormData();
  fd.append('file1', f1);
  fd.append('file2', f2);
  fd.append('key_columns',     JSON.stringify(keyArr));
  fd.append('compare_columns', JSON.stringify(compareArr));
  fd.append('include_schema', 'true');
  fd.append('include_data',   'true');

  try {
    const blob = await apiPostBlob('compare/report', fd);
    downloadBlob(blob, 'data_comparison_report.xlsx');
  } catch (err) {
    showAlert('alert-data', 'error', err.message);
  }
});

function renderDataResults(data) {
  showResults('results-data');
  const s = data.summary;

  $('data-stats').innerHTML = `
    <div class="stat-box"><div class="stat-val">${s.total_file1}</div><div class="stat-lbl">File 1 Rows</div></div>
    <div class="stat-box"><div class="stat-val">${s.total_file2}</div><div class="stat-lbl">File 2 Rows</div></div>
    <div class="stat-box green"><div class="stat-val">${s.added_count}</div><div class="stat-lbl">Added</div></div>
    <div class="stat-box red"><div class="stat-val">${s.removed_count}</div><div class="stat-lbl">Removed</div></div>
    <div class="stat-box amber"><div class="stat-val">${s.changed_count}</div><div class="stat-lbl">Changed</div></div>
    <div class="stat-box"><div class="stat-val">${s.unchanged_count}</div><div class="stat-lbl">Unchanged</div></div>
  `;

  $('badge-added').textContent   = s.added_count;
  $('badge-removed').textContent = s.removed_count;
  $('badge-changed').textContent = s.changed_count;

  // Added rows table
  renderGenericTable('tbl-added', data.added_rows);
  // Removed rows table
  renderGenericTable('tbl-removed', data.removed_rows);

  // Changed rows table
  const changedTbody = $('tbl-changed').querySelector('tbody');
  changedTbody.innerHTML = '';
  (data.changed_rows || []).forEach(row => {
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

function renderGenericTable(tableId, rows) {
  const table = $(tableId);
  if (!table) return;
  const thead = table.querySelector('thead tr');
  const tbody = table.querySelector('tbody');
  thead.innerHTML = '';
  tbody.innerHTML = '';

  if (!rows || rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="99" class="empty-state">No rows</td></tr>';
    return;
  }

  const cols = Object.keys(rows[0]);
  cols.forEach(c => {
    const th = document.createElement('th');
    th.textContent = c;
    thead.appendChild(th);
  });

  const MAX_ROWS = 200;
  rows.slice(0, MAX_ROWS).forEach(row => {
    const tr = document.createElement('tr');
    cols.forEach(c => {
      const td = document.createElement('td');
      td.textContent = row[c] ?? '';
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });

  if (rows.length > MAX_ROWS) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td colspan="${cols.length}" class="text-muted" style="text-align:center;padding:10px;">
      … and ${rows.length - MAX_ROWS} more rows (download report for full data)
    </td>`;
    tbody.appendChild(tr);
  }
}

// ══════════════════════════════════════════════════════════════════════════
// ANONYMIZE
// ══════════════════════════════════════════════════════════════════════════

$('btn-detect-cols').addEventListener('click', async () => {
  const file = $('scrub-file').files[0];
  if (!file) {
    showAlert('alert-scrub', 'error', 'Please upload a file first.');
    return;
  }

  // Run analyze to get detected types, then pre-select sensitive ones
  const fd = new FormData();
  fd.append('file', file);

  const tid = startFakeProgress('scrub', 'Detecting sensitive columns…');
  try {
    const data = await apiPostJSON('analyze-data', fd);
    stopFakeProgress('scrub', tid, true);

    const sensitiveTypes = new Set(['email','phone','ssn','credit_card','name','address','ip_address']);
    const detected = [];
    for (const [col, info] of Object.entries(data.detected_types || {})) {
      if (sensitiveTypes.has(info.type)) detected.push(col);
    }

    // If we have column pills already, select the sensitive ones
    if (state.scrubAllCols.length === 0) {
      // Load from analysis result
      state.scrubAllCols = Object.keys(data.detected_types || {});
      renderScrubPills(state.scrubAllCols);
    }

    // Select detected sensitive columns
    state.scrubColumns = new Set(detected);
    document.querySelectorAll('#scrub-col-pills .pill').forEach(pill => {
      if (state.scrubColumns.has(pill.dataset.col)) {
        pill.classList.add('selected');
      } else {
        pill.classList.remove('selected');
      }
    });
    syncScrubInput();

    if (detected.length > 0) {
      showAlert('alert-scrub', 'success', `Auto-detected ${detected.length} sensitive column(s): ${detected.join(', ')}`);
    } else {
      showAlert('alert-scrub', 'info', 'No obviously sensitive columns detected. Select columns manually.');
    }
  } catch (err) {
    stopFakeProgress('scrub', tid, false);
    showAlert('alert-scrub', 'error', err.message);
  }
});

// Sync pill selection when user types in the input
$('scrub-cols-input').addEventListener('input', () => {
  const typed = $('scrub-cols-input').value.split(',').map(s => s.trim()).filter(Boolean);
  state.scrubColumns = new Set(typed);
  document.querySelectorAll('#scrub-col-pills .pill').forEach(pill => {
    pill.classList.toggle('selected', state.scrubColumns.has(pill.dataset.col));
  });
});

$('btn-scrub').addEventListener('click', async () => {
  const file = $('scrub-file').files[0];
  clearAlert('alert-scrub');

  if (!file) {
    showAlert('alert-scrub', 'error', 'Please upload a file first.');
    return;
  }

  // Merge typed input with pill selection
  const typed = $('scrub-cols-input').value.split(',').map(s => s.trim()).filter(Boolean);
  const cols  = [...new Set([...state.scrubColumns, ...typed])];

  if (cols.length === 0) {
    showAlert('alert-scrub', 'error', 'Select at least one column to anonymize.');
    return;
  }

  const fd = new FormData();
  fd.append('file', file);
  fd.append('columns_to_scrub',      JSON.stringify(cols));
  fd.append('preserve_relationships', $('scrub-preserve').checked ? 'true' : 'false');
  fd.append('export_mapping',         $('scrub-export-map').checked ? 'true' : 'false');

  const tid = startFakeProgress('scrub', 'Anonymizing data…');
  try {
    const blob = await apiPostBlob('scrub-data', fd);
    stopFakeProgress('scrub', tid, true);
    const baseName = file.name.replace(/\.[^.]+$/, '');
    downloadBlob(blob, `scrubbed_${baseName}.xlsx`);
    showAlert('alert-scrub', 'success', `Anonymized file downloaded: scrubbed_${baseName}.xlsx`);
  } catch (err) {
    stopFakeProgress('scrub', tid, false);
    showAlert('alert-scrub', 'error', err.message);
  }
});

// ══════════════════════════════════════════════════════════════════════════
// ANALYZE
// ══════════════════════════════════════════════════════════════════════════

$('btn-analyze').addEventListener('click', async () => {
  const file = $('analyze-file').files[0];
  clearAlert('alert-analyze');
  hideResults('results-analyze');

  if (!file) {
    showAlert('alert-analyze', 'error', 'Please upload a file first.');
    return;
  }

  const fd = new FormData();
  fd.append('file', file);

  const tid = startFakeProgress('analyze', 'Analyzing data…');
  try {
    const data = await apiPostJSON('analyze-data', fd);
    stopFakeProgress('analyze', tid, true);
    state.analyzeResult = data;
    renderAnalyzeResults(data);
  } catch (err) {
    stopFakeProgress('analyze', tid, false);
    showAlert('alert-analyze', 'error', err.message);
  }
});

function renderAnalyzeResults(data) {
  showResults('results-analyze');
  const ov = data.overview;

  $('analyze-stats').innerHTML = `
    <div class="stat-box"><div class="stat-val">${ov.row_count.toLocaleString()}</div><div class="stat-lbl">Rows</div></div>
    <div class="stat-box"><div class="stat-val">${ov.column_count}</div><div class="stat-lbl">Columns</div></div>
    <div class="stat-box red"><div class="stat-val">${ov.duplicate_rows}</div><div class="stat-lbl">Duplicate Rows</div></div>
    <div class="stat-box amber"><div class="stat-val">${ov.total_nulls.toLocaleString()}</div><div class="stat-lbl">Total Nulls</div></div>
    <div class="stat-box"><div class="stat-val">${data.memory_info.estimated_kb} KB</div><div class="stat-lbl">Est. Size</div></div>
  `;

  const tbody = $('tbl-analyze').querySelector('tbody');
  tbody.innerHTML = '';

  for (const [col, info] of Object.entries(data.columns || {})) {
    const topVal = info.top_values?.[0];
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="mono">${escHtml(col)}</td>
      <td>${typeBadge(info.semantic_type)}</td>
      <td>${confBar(info.type_confidence)}</td>
      <td>${info.non_null.toLocaleString()}</td>
      <td>${nullPctCell(info.null_pct)}</td>
      <td>${info.unique_count.toLocaleString()}</td>
      <td>${uniquenessPctCell(info.uniqueness, info.is_unique)}</td>
      <td class="mono">${escHtml(info.stats?.min ?? '—')}</td>
      <td class="mono">${escHtml(info.stats?.max ?? '—')}</td>
      <td class="mono">${escHtml(info.stats?.mean ?? '—')}</td>
      <td class="mono" title="${topVal ? `${topVal.count} occurrences (${topVal.pct}%)` : ''}">${escHtml(topVal?.value ?? '—')}</td>
    `;
    tbody.appendChild(tr);
  }
}

function nullPctCell(pct) {
  if (pct === 0) return `<span style="color:#1a7a4a;font-weight:600;">0%</span>`;
  if (pct > 20)  return `<span style="color:#c0392b;font-weight:600;">${pct}%</span>`;
  return `<span style="color:#d68910;">${pct}%</span>`;
}

function uniquenessPctCell(pct, isUnique) {
  if (isUnique) return `<span style="color:#1a7a4a;font-weight:600;">100% 🔑</span>`;
  if (pct > 90)  return `<span style="color:#1a7a4a;">${pct}%</span>`;
  return `<span>${pct}%</span>`;
}

// ══════════════════════════════════════════════════════════════════════════
// FIND KEYS
// ══════════════════════════════════════════════════════════════════════════

$('btn-find-keys').addEventListener('click', async () => {
  const file = $('keys-file').files[0];
  clearAlert('alert-keys');
  hideResults('results-keys');

  if (!file) {
    showAlert('alert-keys', 'error', 'Please upload a file first.');
    return;
  }

  const selectedCols = [...state.keysColumns];

  const fd = new FormData();
  fd.append('file', file);
  fd.append('selected_columns', JSON.stringify(selectedCols));

  const tid = startFakeProgress('keys', 'Running Apriori key search…');
  try {
    const data = await apiPostJSON('find-keys', fd);
    stopFakeProgress('keys', tid, true);
    state.keysResult = data;
    renderKeysResults(data);
  } catch (err) {
    stopFakeProgress('keys', tid, false);
    showAlert('alert-keys', 'error', err.message);
  }
});

function renderKeysResults(data) {
  showResults('results-keys');

  // Primary key
  const primaryEl = $('keys-primary');
  if (data.primary_key && data.primary_key.length > 0) {
    primaryEl.innerHTML = `
      <div class="alert alert-success">
        <div>
          <strong>Recommended Primary Key:</strong>
          <div class="pill-list mt-8">
            ${data.primary_key.map(c => `<span class="pill pill-added">${escHtml(c)}</span>`).join('')}
          </div>
        </div>
      </div>
    `;
  } else {
    primaryEl.innerHTML = `<div class="alert alert-info">No single minimal key found within the search limit. Try selecting fewer columns or check data quality.</div>`;
  }

  // All combinations
  const combosEl = $('keys-combos');
  if (data.minimal_combinations && data.minimal_combinations.length > 0) {
    combosEl.innerHTML = data.minimal_combinations.map((combo, i) => `
      <div style="margin-bottom:10px;">
        <span class="text-muted" style="margin-right:8px;">Option ${i + 1}:</span>
        ${combo.map(c => `<span class="pill pill-select selected" style="margin-right:4px;">${escHtml(c)}</span>`).join('')}
      </div>
    `).join('');
  } else {
    combosEl.innerHTML = '<div class="empty-state"><div class="es-icon">🔍</div>No unique combinations found in the selected columns.</div>';
  }

  // Stats table
  const tbody = $('tbl-keys-stats').querySelector('tbody');
  tbody.innerHTML = '';
  const rowCount = data.row_count || 1;

  for (const [col, info] of Object.entries(data.stats || {})) {
    const isKey = data.minimal_combinations?.some(combo => combo.length === 1 && combo[0] === col);
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="mono">${escHtml(col)}</td>
      <td>${info.unique_count.toLocaleString()}</td>
      <td>${uniquenessPctCell(+(info.uniqueness * 100).toFixed(1), info.unique_count === rowCount)}</td>
      <td>${isKey ? badge('✓ Yes', 'green') : badge('No', 'gray')}</td>
    `;
    tbody.appendChild(tr);
  }
}
