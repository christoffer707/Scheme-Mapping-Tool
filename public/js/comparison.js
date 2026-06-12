/**
 * comparison.js
 * Frontend logic for the unified Data Pipelines & Compare grid.
 */

'use strict';

const state = {
  credentials: { url: '', user: '', pass: '' },
  currentTool: null,
  currentMode: 'file' 
};

function $(id) { return document.getElementById(id); }

function escHtml(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function saveGlobalCredentials() {
  state.credentials.url = $('g-url').value.trim();
  state.credentials.user = $('g-user').value.trim();
  state.credentials.pass = $('g-pass').value;
  
  const status = $('cred-status');
  status.style.display = 'block';
  setTimeout(() => status.style.display = 'none', 3000);
}

function openTool(toolId) {
  state.currentTool = toolId;
  $('dashboard').style.display = 'none';
  $('workspace').style.display = 'block';
  $('ws-alert').className = 'alert';
  $('ws-alert').innerHTML = '';
  
  const resultsEl = $('ws-results');
  resultsEl.innerHTML = '';
  resultsEl.classList.add('hidden');

  const titleEl = $('ws-title');
  const optionsEl = $('ws-options');
  
  if (toolId === 'duplicate-finder') {
    titleEl.innerText = 'Duplicate Finder';
    optionsEl.innerHTML = `
      <div class="form-group">
        <label>Columns to Check for Duplicates <span style="color:#888;">(Comma-separated. Leave blank to check entire row)</span></label>
        <input type="text" id="ws-opt-cols" placeholder="e.g. email, employee_number">
      </div>
    `;
    $('btn-run-tool').onclick = runDuplicateFinder;
    $('btn-run-tool').innerText = 'Find Duplicates & Download';
  } 
  else if (toolId === 'data-anonymizer') {
    titleEl.innerText = 'Data Anonymizer';
    optionsEl.innerHTML = `
      <div class="form-group">
        <label>Columns to Anonymize <span style="color:#888;">(Comma-separated required)</span></label>
        <input type="text" id="ws-opt-cols" placeholder="e.g. email, phone, u_social_security">
      </div>
      <div class="checkbox-group">
        <label class="checkbox-row"><input type="checkbox" id="ws-opt-preserve" checked> Preserve foreign key relationships (Consistent Substitution)</label>
        <label class="checkbox-row"><input type="checkbox" id="ws-opt-map" checked> Include mapping key sheet in download</label>
      </div>
    `;
    $('btn-run-tool').onclick = runAnonymizer;
    $('btn-run-tool').innerText = 'Anonymize & Download';
  }
  else if (toolId === 'column-analyzer') {
    titleEl.innerText = 'Column Analyzer';
    optionsEl.innerHTML = `<p style="color:#8f9bb3; font-size:13px; margin:0;">No additional options required. The analyzer will profile all columns in the dataset.</p>`;
    $('btn-run-tool').onclick = runColumnAnalyzer;
    $('btn-run-tool').innerText = 'Run Analysis';
  }
  else if (toolId === 'natural-key-finder') {
    titleEl.innerText = 'Natural Key Finder';
    optionsEl.innerHTML = `
      <div class="form-group">
        <label>Columns to Consider <span style="color:#888;">(Comma-separated. Leave blank to test all combinations)</span></label>
        <input type="text" id="ws-opt-cols" placeholder="e.g. number, state, sys_created_on">
      </div>
    `;
    $('btn-run-tool').onclick = runKeyFinder;
    $('btn-run-tool').innerText = 'Find Natural Keys';
  }
  else if (toolId === 'file-splitter') {
    titleEl.innerText = 'File Splitter';
    optionsEl.innerHTML = `
      <div class="form-group" style="max-width: 300px;">
        <label>Rows per Sheet/Chunk <span style="color:#888;">(Max recommended: 15,000)</span></label>
        <input type="number" id="ws-opt-chunk" value="5000">
      </div>
    `;
    $('btn-run-tool').onclick = runFileSplitter;
    $('btn-run-tool').innerText = 'Split File & Download';
  }
  else if (toolId === 'column-normalizer') {
    titleEl.innerText = 'Column Normalizer';
    optionsEl.innerHTML = `
      <div class="row-flex">
        <div class="form-group">
          <label>Columns to Normalize <span style="color:#888;">(Comma-separated required)</span></label>
          <input type="text" id="ws-opt-cols" placeholder="e.g. short_description, comments">
        </div>
        <div class="form-group">
          <label>Normalization Action</label>
          <select id="ws-opt-action">
            <option value="trim">Trim Whitespace</option>
            <option value="lowercase">Convert to Lowercase</option>
            <option value="uppercase">Convert to Uppercase</option>
            <option value="remove_special">Remove Special Characters</option>
            <option value="extract_numbers">Extract Numbers Only</option>
          </select>
        </div>
      </div>
    `;
    $('btn-run-tool').onclick = runColumnNormalizer;
    $('btn-run-tool').innerText = 'Normalize & Download';
  }
  else if (toolId === 'find-replace') {
    titleEl.innerText = 'Find & Replace';
    optionsEl.innerHTML = `
      <div class="form-group">
        <label>Target Columns <span style="color:#888;">(Comma-separated. Leave blank for all columns)</span></label>
        <input type="text" id="ws-opt-cols" placeholder="e.g. description, short_description">
      </div>
      <div class="row-flex">
        <div class="form-group"><label>Find what</label><input type="text" id="ws-opt-find" placeholder="Text or Regex"></div>
        <div class="form-group"><label>Replace with</label><input type="text" id="ws-opt-replace" placeholder="Replacement text"></div>
      </div>
      <div class="checkbox-group">
        <label class="checkbox-row"><input type="checkbox" id="ws-opt-regex"> Use Regular Expressions</label>
        <label class="checkbox-row"><input type="checkbox" id="ws-opt-case"> Match Case</label>
      </div>
    `;
    $('btn-run-tool').onclick = runFindReplace;
    $('btn-run-tool').innerText = 'Find & Replace';
  }
  else if (toolId === 'column-operations') {
    titleEl.innerText = 'Column Operations';
    optionsEl.innerHTML = `
      <div class="form-group">
        <label>Drop Columns <span style="color:#888;">(Comma-separated. Columns to remove)</span></label>
        <input type="text" id="ws-opt-drop" placeholder="e.g. sys_created_on, sys_updated_on">
      </div>
      <div class="form-group">
        <label>Rename Columns <span style="color:#888;">(Format: old_name=new_name. One per line)</span></label>
        <textarea id="ws-opt-rename" placeholder="e.g.&#10;sys_id=source_sys_id&#10;u_custom_field=mapped_field"></textarea>
      </div>
    `;
    $('btn-run-tool').onclick = runColumnOperations;
    $('btn-run-tool').innerText = 'Apply Operations & Download';
  }
}

function closeTool() {
  state.currentTool = null;
  $('workspace').style.display = 'none';
  $('dashboard').style.display = 'block';
}

function setMode(mode) {
  state.currentMode = mode;
  if (mode === 'file') {
    $('btn-mode-file').classList.add('active');
    $('btn-mode-live').classList.remove('active');
    $('panel-file').classList.remove('hidden');
    $('panel-live').classList.add('hidden');
  } else {
    $('btn-mode-live').classList.add('active');
    $('btn-mode-file').classList.remove('active');
    $('panel-live').classList.remove('hidden');
    $('panel-file').classList.add('hidden');
  }
}

function buildPayload() {
  const fd = new FormData();
  if (state.currentMode === 'file') {
    const file = $('ws-file').files[0];
    if (!file) throw new Error("Please select a file to upload.");
    fd.append('file', file);
  } else {
    if (!state.credentials.url || !state.credentials.user || !state.credentials.pass) {
      throw new Error("Missing Global Credentials. Please save them in the left sidebar.");
    }
    const table = $('ws-table').value.trim();
    if (!table) throw new Error("Table Name is required for Live Pull.");
    
    fd.append('instance_url', state.credentials.url);
    fd.append('username', state.credentials.user);
    fd.append('password', state.credentials.pass);
    fd.append('table_name', table);
    fd.append('limit', $('ws-limit').value.trim());
    
    const query = $('ws-query').value.trim();
    if (query) fd.append('query', query);
  }
  return fd;
}

// ── NEW: Find & Replace ────────────────────────────────────────────────────
async function runFindReplace() {
  const alertEl = $('ws-alert');
  alertEl.className = 'alert info';
  alertEl.innerHTML = '⏳ Finding and replacing data...';

  try {
    const fd = buildPayload();
    const cols = $('ws-opt-cols').value.trim();
    const colArr = cols ? cols.split(',').map(c => c.trim()).filter(Boolean) : [];
    
    fd.append('columns', JSON.stringify(colArr));
    fd.append('search_str', $('ws-opt-find').value);
    fd.append('replace_str', $('ws-opt-replace').value);
    fd.append('use_regex', $('ws-opt-regex').checked);
    fd.append('match_case', $('ws-opt-case').checked);

    const res = await fetch('/api/find-replace', { method: 'POST', body: fd });
    if (!res.ok) throw new Error(await extractError(res));

    triggerDownload(await res.blob(), 'find_replace_export.xlsx');
    alertEl.className = 'alert success';
    alertEl.innerHTML = '✅ Success! Your modified file has been downloaded.';
  } catch (err) {
    alertEl.className = 'alert error';
    alertEl.innerHTML = `❌ Error: ${err.message}`;
  }
}

// ── NEW: Column Operations ─────────────────────────────────────────────────
async function runColumnOperations() {
  const alertEl = $('ws-alert');
  alertEl.className = 'alert info';
  alertEl.innerHTML = '⏳ Applying operations...';

  try {
    const fd = buildPayload();
    const drop = $('ws-opt-drop').value.trim();
    const dropArr = drop ? drop.split(',').map(c => c.trim()).filter(Boolean) : [];
    
    const renameText = $('ws-opt-rename').value.trim();
    const renameMap = {};
    if (renameText) {
      renameText.split('\n').forEach(line => {
        const parts = line.split('=');
        if (parts.length === 2) {
          renameMap[parts[0].trim()] = parts[1].trim();
        }
      });
    }

    fd.append('drop_columns', JSON.stringify(dropArr));
    fd.append('rename_columns', JSON.stringify(renameMap));

    const res = await fetch('/api/column-ops', { method: 'POST', body: fd });
    if (!res.ok) throw new Error(await extractError(res));

    triggerDownload(await res.blob(), 'col_ops_export.xlsx');
    alertEl.className = 'alert success';
    alertEl.innerHTML = '✅ Success! Your modified file has been downloaded.';
  } catch (err) {
    alertEl.className = 'alert error';
    alertEl.innerHTML = `❌ Error: ${err.message}`;
  }
}

// ── Existing Tools ─────────────────────────────────────────────────────────

async function runFileSplitter() {
  const alertEl = $('ws-alert');
  alertEl.className = 'alert info';
  alertEl.innerHTML = '⏳ Splitting data...';

  try {
    const fd = buildPayload();
    fd.append('chunk_size', $('ws-opt-chunk').value);

    const res = await fetch('/api/split-data', { method: 'POST', body: fd });
    if (!res.ok) throw new Error(await extractError(res));

    triggerDownload(await res.blob(), 'split_export.xlsx');
    alertEl.className = 'alert success';
    alertEl.innerHTML = '✅ Success! Your split workbook has been downloaded.';
  } catch (err) {
    alertEl.className = 'alert error';
    alertEl.innerHTML = `❌ Error: ${err.message}`;
  }
}

async function runColumnNormalizer() {
  const alertEl = $('ws-alert');
  alertEl.className = 'alert info';
  alertEl.innerHTML = '⏳ Normalizing columns...';

  try {
    const fd = buildPayload();
    const cols = $('ws-opt-cols').value.trim();
    const colArr = cols ? cols.split(',').map(c => c.trim()).filter(Boolean) : [];
    if(colArr.length === 0) throw new Error("Please specify at least one column to normalize.");
    
    fd.append('columns', JSON.stringify(colArr));
    fd.append('action', $('ws-opt-action').value);

    const res = await fetch('/api/normalize-data', { method: 'POST', body: fd });
    if (!res.ok) throw new Error(await extractError(res));

    triggerDownload(await res.blob(), 'normalized_export.xlsx');
    alertEl.className = 'alert success';
    alertEl.innerHTML = '✅ Success! Your normalized file has been downloaded.';
  } catch (err) {
    alertEl.className = 'alert error';
    alertEl.innerHTML = `❌ Error: ${err.message}`;
  }
}

async function runDuplicateFinder() {
  const alertEl = $('ws-alert');
  alertEl.className = 'alert info';
  alertEl.innerHTML = '⏳ Processing data...';

  try {
    const fd = buildPayload();
    const cols = $('ws-opt-cols').value.trim();
    const colArr = cols ? cols.split(',').map(c => c.trim()).filter(Boolean) : [];
    fd.append('check_columns', JSON.stringify(colArr));

    const res = await fetch('/api/find-duplicates', { method: 'POST', body: fd });
    if (!res.ok) throw new Error(await extractError(res));

    triggerDownload(await res.blob(), 'deduplicated_export.xlsx');
    alertEl.className = 'alert success';
    alertEl.innerHTML = '✅ Success! Your deduplicated Excel file has been downloaded.';
  } catch (err) {
    alertEl.className = 'alert error';
    alertEl.innerHTML = `❌ Error: ${err.message}`;
  }
}

async function runAnonymizer() {
  const alertEl = $('ws-alert');
  alertEl.className = 'alert info';
  alertEl.innerHTML = '⏳ Anonymizing data...';

  try {
    const fd = buildPayload();
    const cols = $('ws-opt-cols').value.trim();
    const colArr = cols ? cols.split(',').map(c => c.trim()).filter(Boolean) : [];
    if(colArr.length === 0) throw new Error("Please specify at least one column to anonymize.");
    
    fd.append('columns_to_scrub', JSON.stringify(colArr));
    fd.append('preserve_relationships', $('ws-opt-preserve').checked);
    fd.append('export_mapping', $('ws-opt-map').checked);

    const res = await fetch('/api/scrub-data', { method: 'POST', body: fd });
    if (!res.ok) throw new Error(await extractError(res));

    triggerDownload(await res.blob(), 'anonymized_export.xlsx');
    alertEl.className = 'alert success';
    alertEl.innerHTML = '✅ Success! Your anonymized file has been downloaded.';
  } catch (err) {
    alertEl.className = 'alert error';
    alertEl.innerHTML = `❌ Error: ${err.message}`;
  }
}

async function runColumnAnalyzer() {
  const alertEl = $('ws-alert');
  const resultsEl = $('ws-results');
  alertEl.className = 'alert info';
  alertEl.innerHTML = '⏳ Analyzing columns...';
  resultsEl.classList.add('hidden');

  try {
    const fd = buildPayload();
    const res = await fetch('/api/analyze-data', { method: 'POST', body: fd });
    if (!res.ok) throw new Error(await extractError(res));
    
    const data = await res.json();
    alertEl.style.display = 'none';
    
    const ov = data.overview;
    let html = `
      <div class="results-grid">
        <div class="stat-card"><div class="stat-val">${ov.row_count.toLocaleString()}</div><div class="stat-lbl">Total Rows</div></div>
        <div class="stat-card"><div class="stat-val">${ov.column_count}</div><div class="stat-lbl">Columns</div></div>
        <div class="stat-card"><div class="stat-val">${ov.duplicate_rows}</div><div class="stat-lbl">Duplicate Rows</div></div>
        <div class="stat-card"><div class="stat-val">${ov.total_nulls.toLocaleString()}</div><div class="stat-lbl">Total Nulls</div></div>
      </div>
      <div class="table-container">
        <table>
          <thead><tr><th>Column</th><th>Type</th><th>Confidence</th><th>Non-Null</th><th>Null %</th><th>Unique</th><th>Min</th><th>Max</th><th>Top Value</th></tr></thead>
          <tbody>
    `;
    
    for (const [col, info] of Object.entries(data.columns || {})) {
      const topVal = info.top_values?.[0];
      html += `<tr>
        <td class="mono">${escHtml(col)}</td>
        <td><span class="badge">${escHtml(info.semantic_type)}</span></td>
        <td>${Math.round(info.type_confidence * 100)}%</td>
        <td>${info.non_null.toLocaleString()}</td>
        <td style="color:${info.null_pct > 20 ? '#e74c3c' : '#a0aec0'}">${info.null_pct}%</td>
        <td><span class="badge ${info.is_unique ? 'green' : ''}">${info.unique_count.toLocaleString()} ${info.is_unique ? '🔑' : ''}</span></td>
        <td>${escHtml(info.stats?.min ?? '—')}</td>
        <td>${escHtml(info.stats?.max ?? '—')}</td>
        <td>${escHtml(topVal?.value ?? '—')}</td>
      </tr>`;
    }
    html += `</tbody></table></div>`;
    
    resultsEl.innerHTML = html;
    resultsEl.classList.remove('hidden');
  } catch (err) {
    alertEl.className = 'alert error';
    alertEl.innerHTML = `❌ Error: ${err.message}`;
  }
}

async function runKeyFinder() {
  const alertEl = $('ws-alert');
  const resultsEl = $('ws-results');
  alertEl.className = 'alert info';
  alertEl.innerHTML = '⏳ Running Apriori algorithm to discover keys...';
  resultsEl.classList.add('hidden');

  try {
    const fd = buildPayload();
    const cols = $('ws-opt-cols').value.trim();
    const colArr = cols ? cols.split(',').map(c => c.trim()).filter(Boolean) : [];
    fd.append('selected_columns', JSON.stringify(colArr));

    const res = await fetch('/api/find-keys', { method: 'POST', body: fd });
    if (!res.ok) throw new Error(await extractError(res));
    
    const data = await res.json();
    alertEl.style.display = 'none';
    
    let html = '';
    
    if (data.primary_key && data.primary_key.length > 0) {
      html += `
        <div style="background: rgba(46, 204, 113, 0.1); border: 1px solid rgba(46, 204, 113, 0.2); padding: 16px; border-radius: 8px; margin-bottom: 20px;">
          <h4 style="color: #2ecc71; margin-bottom: 8px;">🏆 Recommended Primary Key</h4>
          ${data.primary_key.map(c => `<span class="badge green" style="margin-right:8px; font-size:13px;">${escHtml(c)}</span>`).join('')}
        </div>
      `;
    } else {
      html += `<div class="alert info" style="display:block; margin-bottom:20px;">No minimal keys found.</div>`;
    }

    if (data.minimal_combinations && data.minimal_combinations.length > 0) {
      html += `<h4 style="color:#fff; margin-bottom:10px;">Alternative Key Combinations</h4><div style="margin-bottom:20px;">`;
      data.minimal_combinations.slice(0, 5).forEach((combo, i) => {
        html += `<div style="margin-bottom:8px;"><span style="color:#8f9bb3; margin-right:8px;">Option ${i+1}:</span>`;
        html += combo.map(c => `<span class="badge" style="margin-right:4px;">${escHtml(c)}</span>`).join('');
        html += `</div>`;
      });
      html += `</div>`;
    }

    html += `
      <h4 style="color:#fff; margin-bottom:10px;">Column Uniqueness Breakdown</h4>
      <div class="table-container">
        <table>
          <thead><tr><th>Column</th><th>Unique Count</th><th>Uniqueness %</th><th>Is Key?</th></tr></thead>
          <tbody>
    `;
    for (const [col, info] of Object.entries(data.stats || {})) {
      const isKey = data.minimal_combinations?.some(combo => combo.length === 1 && combo[0] === col);
      html += `<tr>
        <td class="mono">${escHtml(col)}</td>
        <td>${info.unique_count.toLocaleString()}</td>
        <td>${(info.uniqueness * 100).toFixed(1)}%</td>
        <td>${isKey ? '<span class="badge green">Yes</span>' : '<span class="badge">No</span>'}</td>
      </tr>`;
    }
    html += `</tbody></table></div>`;
    
    resultsEl.innerHTML = html;
    resultsEl.classList.remove('hidden');
  } catch (err) {
    alertEl.className = 'alert error';
    alertEl.innerHTML = `❌ Error: ${err.message}`;
  }
}

// ── Utility ────────────────────────────────────────────────────────────────
async function extractError(res) {
  let msg = `HTTP ${res.status}`;
  try { const j = await res.json(); msg = j.error || msg; } catch {}
  return msg;
}

function triggerDownload(blob, defaultFilename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = defaultFilename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
