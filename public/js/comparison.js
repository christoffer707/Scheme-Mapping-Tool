/**
 * comparison.js
 * Frontend logic for the unified Data Pipelines & Compare grid.
 */

'use strict';

const state = {
  credentials: { url: '', user: '', pass: '' },
  currentTool: null,
  currentMode: 'file', 
  merge: { mode1: 'file', mode2: 'file' },
  pipe: {
    mode: 'file',
    transforms: []
  }
};

function $(id) { return document.getElementById(id); }
function escHtml(str) { return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

// ── Global Credential State Management ─────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  loadGlobalCredentials();
});

function saveGlobalCredentials() {
  state.credentials.url = $('g-url').value.trim();
  state.credentials.user = $('g-user').value.trim();
  state.credentials.pass = $('g-pass').value;
  
  localStorage.setItem('sn_global_creds', JSON.stringify(state.credentials));
  
  const status = $('cred-status');
  status.style.color = '#2ecc71';
  status.innerText = 'Credentials Saved!';
  status.style.display = 'block';
  setTimeout(() => status.style.display = 'none', 3000);
}

function loadGlobalCredentials() {
  const stored = localStorage.getItem('sn_global_creds');
  if (stored) {
    try {
      state.credentials = JSON.parse(stored);
      $('g-url').value = state.credentials.url || '';
      $('g-user').value = state.credentials.user || '';
      $('g-pass').value = state.credentials.pass || '';
    } catch (e) {
      console.error("Failed to parse saved credentials.");
    }
  }
}

function clearGlobalCredentials() {
  localStorage.removeItem('sn_global_creds');
  state.credentials = { url: '', user: '', pass: '' };
  $('g-url').value = '';
  $('g-user').value = '';
  $('g-pass').value = '';
  
  const status = $('cred-status');
  status.style.color = '#e74c3c';
  status.innerText = 'Credentials Cleared!';
  status.style.display = 'block';
  setTimeout(() => {
    status.style.display = 'none';
    status.style.color = '#2ecc71'; // reset for next save
  }, 3000);
}

// ── Pipeline Wizard Logic ──────────────────────────────────────────────────
function openPipeline() {
  $('dashboard').style.display = 'none';
  $('workspace').style.display = 'none';
  $('workspace-pipeline').style.display = 'block';
  state.pipe.transforms = [];
  $('p-transform-list').innerHTML = '';
  pipeGoToStep(1);
}

function closePipeline() {
  $('workspace-pipeline').style.display = 'none';
  $('dashboard').style.display = 'block';
}

function setPipeMode(mode) {
  state.pipe.mode = mode;
  if (mode === 'file') {
    $('p-btn-file').classList.add('active');
    $('p-btn-live').classList.remove('active');
    $('p-panel-file').classList.remove('hidden');
    $('p-panel-live').classList.add('hidden');
  } else {
    $('p-btn-live').classList.add('active');
    $('p-btn-file').classList.remove('active');
    $('p-panel-live').classList.remove('hidden');
    $('p-panel-file').classList.add('hidden');
  }
}

function pipeGoToStep(step) {
  const titles = ["Ingestion", "Shape & Triage", "Identity Discovery", "Transformations", "Generation"];
  $('p-step-title').innerText = `Stage ${step}: ${titles[step-1]}`;
  
  for (let i = 1; i <= 5; i++) {
    const dot = $(`p-dot-${i}`);
    const line = $(`p-line-${i}`);
    const panel = $(`p-stage-${i}`);
    
    panel.classList.remove('active');
    if (i < step) {
      dot.className = 'pipe-step-dot done';
      if(line) line.className = 'pipe-step-line done';
    } else if (i === step) {
      dot.className = 'pipe-step-dot active';
      if(line) line.className = 'pipe-step-line';
      panel.classList.add('active');
    } else {
      dot.className = 'pipe-step-dot';
      if(line) line.className = 'pipe-step-line';
    }
  }
  $('p-alert').style.display = 'none';
}

function pipeBuildPayload() {
  const fd = new FormData();
  if (state.pipe.mode === 'file') {
    const file = $('p-file').files[0];
    if (!file) throw new Error("Stage 1: Please select a file to upload.");
    fd.append('file', file);
  } else {
    if (!state.credentials.url) throw new Error("Stage 1: Missing Global Credentials.");
    const table = $('p-table').value.trim();
    if (!table) throw new Error("Stage 1: Table Name is required.");
    fd.append('instance_url', state.credentials.url);
    fd.append('username', state.credentials.user);
    fd.append('password', state.credentials.pass);
    fd.append('table_name', table);
    fd.append('query', $('p-query').value.trim());
  }
  return fd;
}

function showPipeAlert(type, msg) {
  const el = $('p-alert');
  el.className = `alert ${type}`;
  el.innerHTML = msg;
  el.style.display = 'block';
}

async function pipeRunStep2() {
  showPipeAlert('info', '⏳ Fetching data and analyzing shape...');
  try {
    const fd = pipeBuildPayload();
    const res = await fetch('/api/analyze-data', { method: 'POST', body: fd });
    if (!res.ok) throw new Error(await extractError(res));
    const data = await res.json();
    
    const ov = data.overview;
    let html = `
      <div class="results-grid">
        <div class="stat-card"><div class="stat-val">${ov.row_count.toLocaleString()}</div><div class="stat-lbl">Total Rows</div></div>
        <div class="stat-card"><div class="stat-val">${ov.column_count}</div><div class="stat-lbl">Columns</div></div>
        <div class="stat-card"><div class="stat-val">${ov.duplicate_rows}</div><div class="stat-lbl">Duplicate Rows</div></div>
        <div class="stat-card"><div class="stat-val">${ov.total_nulls.toLocaleString()}</div><div class="stat-lbl">Total Nulls</div></div>
      </div>
      <div class="table-container" style="max-height:300px; overflow-y:auto;">
        <table>
          <thead><tr><th>Column</th><th>Type</th><th>Non-Null</th><th>Null %</th><th>Unique</th></tr></thead>
          <tbody>
    `;
    for (const [col, info] of Object.entries(data.columns || {})) {
      html += `<tr>
        <td class="mono">${escHtml(col)}</td>
        <td><span class="badge">${escHtml(info.semantic_type)}</span></td>
        <td>${info.non_null.toLocaleString()}</td>
        <td style="color:${info.null_pct > 20 ? '#e74c3c' : '#a0aec0'}">${info.null_pct}%</td>
        <td>${info.unique_count.toLocaleString()}</td>
      </tr>`;
    }
    html += `</tbody></table></div>`;
    
    $('p-results-2').innerHTML = html;
    pipeGoToStep(2);
  } catch (err) { showPipeAlert('error', `❌ ${err.message}`); }
}

async function pipeRunStep3() {
  showPipeAlert('info', '⏳ Running Apriori algorithm...');
  try {
    const fd = pipeBuildPayload();
    const res = await fetch('/api/find-keys', { method: 'POST', body: fd });
    if (!res.ok) throw new Error(await extractError(res));
    const data = await res.json();
    
    let html = '';
    if (data.primary_key && data.primary_key.length > 0) {
      html += `
        <div style="background: rgba(46, 204, 113, 0.1); border: 1px solid rgba(46, 204, 113, 0.2); padding: 16px; border-radius: 8px;">
          <h4 style="color: #2ecc71; margin-bottom: 8px;">🏆 Recommended Primary Key</h4>
          ${data.primary_key.map(c => `<span class="badge green" style="margin-right:8px; font-size:13px;">${escHtml(c)}</span>`).join('')}
        </div>
      `;
    } else {
      html += `<div class="alert info" style="display:block;">No minimal keys found.</div>`;
    }
    $('p-results-3').innerHTML = html;
    pipeGoToStep(3);
  } catch (err) { showPipeAlert('error', `❌ ${err.message}`); }
}

function pipeAddTransform() {
  const action = $('p-t-action').value;
  const colsStr = $('p-t-cols').value.trim();
  if (!colsStr) { alert("Please specify columns."); return; }
  
  const cols = colsStr.split(',').map(c => c.trim()).filter(Boolean);
  const type = action === 'drop' ? 'drop' : 'normalize';
  
  state.pipe.transforms.push({ type, action, columns: cols });
  $('p-t-cols').value = '';
  renderPipeTransforms();
}

function pipeRemoveTransform(index) {
  state.pipe.transforms.splice(index, 1);
  renderPipeTransforms();
}

function renderPipeTransforms() {
  const container = $('p-transform-list');
  container.innerHTML = '';
  state.pipe.transforms.forEach((t, idx) => {
    const el = document.createElement('div');
    el.className = 'transform-rule';
    el.innerHTML = `
      <div style="flex:1;"><strong style="color:#4da6ff; text-transform:uppercase; font-size:11px;">${t.action}</strong></div>
      <div style="flex:3;" class="mono">${escHtml(t.columns.join(', '))}</div>
      <button class="btn-icon" onclick="pipeRemoveTransform(${idx})">✖</button>
    `;
    container.appendChild(el);
  });
}

async function pipeExecute() {
  showPipeAlert('info', '⏳ Executing Pipeline... Applying transformations and compiling report.');
  try {
    const fd = pipeBuildPayload();
    fd.append('transforms', JSON.stringify(state.pipe.transforms));

    const res = await fetch('/api/run-pipeline', { method: 'POST', body: fd });
    if (!res.ok) throw new Error(await extractError(res));

    triggerDownload(await res.blob(), 'pipeline_master_export.xlsx');
    showPipeAlert('success', '✅ Pipeline Complete! Your mastered file has been downloaded.');
  } catch (err) { showPipeAlert('error', `❌ ${err.message}`); }
}

// ── Standard Tool Logic ────────────────────────────────────────────────────
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
  const stdHeader = $('ws-standard-header');
  
  if (toolId === 'data-merge') {
    stdHeader.style.display = 'none';
    optionsEl.style.padding = '0';
    optionsEl.style.background = 'transparent';
    optionsEl.style.border = 'none';
  } else {
    stdHeader.style.display = 'block';
    optionsEl.style.padding = '24px';
    optionsEl.style.background = '#1a1d29';
    optionsEl.style.border = '1px solid #2d3142';
  }
  
  if (toolId === 'pdf-to-word') {
     $('ws-toggles').style.display = 'none';
     setMode('file');
  } else {
     $('ws-toggles').style.display = 'flex';
  }

  if (toolId === 'duplicate-finder') {
    titleEl.innerText = 'Duplicate Finder';
    optionsEl.innerHTML = `
      <div class="form-group"><label>Columns to Check</label><input type="text" id="ws-opt-cols" placeholder="e.g. email, employee_number"></div>
    `;
    $('btn-run-tool').onclick = runDuplicateFinder;
    $('btn-run-tool').innerText = 'Find Duplicates & Download';
  } 
  else if (toolId === 'data-anonymizer') {
    titleEl.innerText = 'Data Anonymizer';
    optionsEl.innerHTML = `
      <div class="form-group"><label>Columns</label><input type="text" id="ws-opt-cols" placeholder="e.g. email"></div>
      <div class="checkbox-group">
        <label class="checkbox-row"><input type="checkbox" id="ws-opt-preserve" checked> Preserve Relationships</label>
        <label class="checkbox-row"><input type="checkbox" id="ws-opt-map" checked> Include Mapping Sheet</label>
      </div>
    `;
    $('btn-run-tool').onclick = runAnonymizer;
    $('btn-run-tool').innerText = 'Anonymize & Download';
  }
  else if (toolId === 'column-analyzer') {
    titleEl.innerText = 'Column Analyzer';
    optionsEl.innerHTML = `<p style="color:#8f9bb3; font-size:13px; margin:0;">No additional options required.</p>`;
    $('btn-run-tool').onclick = runColumnAnalyzer;
    $('btn-run-tool').innerText = 'Run Analysis';
  }
  else if (toolId === 'natural-key-finder') {
    titleEl.innerText = 'Natural Key Finder';
    optionsEl.innerHTML = `
      <div class="form-group"><label>Columns to Consider</label><input type="text" id="ws-opt-cols" placeholder="e.g. number"></div>
    `;
    $('btn-run-tool').onclick = runKeyFinder;
    $('btn-run-tool').innerText = 'Find Natural Keys';
  }
  else if (toolId === 'file-splitter') {
    titleEl.innerText = 'File Splitter';
    optionsEl.innerHTML = `
      <div class="form-group" style="max-width: 300px;"><label>Rows per Sheet</label><input type="number" id="ws-opt-chunk" value="5000"></div>
    `;
    $('btn-run-tool').onclick = runFileSplitter;
    $('btn-run-tool').innerText = 'Split File & Download';
  }
  else if (toolId === 'column-normalizer') {
    titleEl.innerText = 'Column Normalizer';
    optionsEl.innerHTML = `
      <div class="row-flex">
        <div class="form-group"><label>Columns</label><input type="text" id="ws-opt-cols"></div>
        <div class="form-group"><label>Action</label>
          <select id="ws-opt-action">
            <option value="trim">Trim Whitespace</option>
            <option value="lowercase">Convert to Lowercase</option>
            <option value="uppercase">Convert to Uppercase</option>
            <option value="remove_special">Remove Special Characters</option>
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
      <div class="form-group"><label>Columns</label><input type="text" id="ws-opt-cols"></div>
      <div class="row-flex">
        <div class="form-group"><label>Find what</label><input type="text" id="ws-opt-find"></div>
        <div class="form-group"><label>Replace with</label><input type="text" id="ws-opt-replace"></div>
      </div>
      <div class="checkbox-group">
        <label class="checkbox-row"><input type="checkbox" id="ws-opt-regex"> Regex</label>
        <label class="checkbox-row"><input type="checkbox" id="ws-opt-case"> Match Case</label>
      </div>
    `;
    $('btn-run-tool').onclick = runFindReplace;
    $('btn-run-tool').innerText = 'Find & Replace';
  }
  else if (toolId === 'column-operations') {
    titleEl.innerText = 'Column Operations';
    optionsEl.innerHTML = `
      <div class="form-group"><label>Drop Columns</label><input type="text" id="ws-opt-drop"></div>
      <div class="form-group"><label>Rename (old=new)</label><textarea id="ws-opt-rename"></textarea></div>
    `;
    $('btn-run-tool').onclick = runColumnOperations;
    $('btn-run-tool').innerText = 'Apply & Download';
  }
  else if (toolId === 'row-filter') {
    titleEl.innerText = 'Row Filter';
    optionsEl.innerHTML = `
      <div class="row-flex">
        <div class="form-group"><label>Target Column</label><input type="text" id="ws-opt-col"></div>
        <div class="form-group"><label>Condition</label>
          <select id="ws-opt-op">
            <option value="eq">Equals (==)</option>
            <option value="neq">Does Not Equal (!=)</option>
            <option value="contains">Contains</option>
          </select>
        </div>
        <div class="form-group"><label>Value</label><input type="text" id="ws-opt-val"></div>
      </div>
    `;
    $('btn-run-tool').onclick = runRowFilter;
    $('btn-run-tool').innerText = 'Filter & Download';
  }
  else if (toolId === 'calculated-columns') {
    titleEl.innerText = 'Calculated Columns';
    optionsEl.innerHTML = `
      <div class="form-group"><label>New Column Name</label><input type="text" id="ws-opt-newcol"></div>
      <div class="form-group"><label>Formula</label><input type="text" id="ws-opt-expr" placeholder="e.g. [first_name] + ' ' + [last_name]"></div>
    `;
    $('btn-run-tool').onclick = runCalculatedColumns;
    $('btn-run-tool').innerText = 'Calculate & Download';
  }
  else if (toolId === 'transpose-data') {
    titleEl.innerText = 'Transpose Data';
    optionsEl.innerHTML = `<p style="color:#8f9bb3; font-size:13px; margin:0;">Flips all rows and columns.</p>`;
    $('btn-run-tool').onclick = runTransposeData;
    $('btn-run-tool').innerText = 'Transpose & Download';
  }
  else if (toolId === 'pivot-data') {
    titleEl.innerText = 'Pivot Table Generator';
    optionsEl.innerHTML = `
      <div class="row-flex">
        <div class="form-group"><label>Group By</label><input type="text" id="ws-opt-group"></div>
        <div class="form-group"><label>Value Col</label><input type="text" id="ws-opt-valcol"></div>
        <div class="form-group"><label>Aggregation</label>
          <select id="ws-opt-agg">
            <option value="count">Count</option>
            <option value="sum">Sum</option>
            <option value="avg">Avg</option>
          </select>
        </div>
      </div>
    `;
    $('btn-run-tool').onclick = runPivotData;
    $('btn-run-tool').innerText = 'Generate & Download';
  }
  else if (toolId === 'data-merge') {
    titleEl.innerText = 'Data Merge / Join';
    optionsEl.innerHTML = `
      <div style="display: flex; gap: 20px; flex-wrap: wrap;">
        <div style="flex: 1; background: #1a1d29; border: 1px solid #2d3142; border-radius: 12px; padding: 24px; min-width: 300px;">
          <h4 style="margin-bottom:15px; color:#4da6ff;">Source A (Left Table)</h4>
          <div class="toggle-container" style="margin-bottom: 15px;">
            <div class="toggle-btn active" id="m-btn-file-1" onclick="setMergeMode(1, 'file')">📁 File</div>
            <div class="toggle-btn" id="m-btn-live-1" onclick="setMergeMode(1, 'live')">⚡ Live API</div>
          </div>
          <div id="m-panel-file-1">
            <div class="drop-zone" style="padding: 20px;">
              <input type="file" id="m-file-1" accept=".csv,.xlsx,.xls" onchange="document.getElementById('m-fname-1').innerText = this.files[0] ? this.files[0].name : ''" />
              <div style="font-size:24px; margin-bottom:5px;">📄</div>
              <div style="font-weight:600; font-size:12px; color:#e2e8f0;">Drop file here</div>
              <div id="m-fname-1" style="margin-top:5px; color:#4da6ff; font-family:monospace; font-size:11px;"></div>
            </div>
          </div>
          <div id="m-panel-live-1" class="hidden">
            <div class="form-group"><label>Table Name</label><input type="text" id="m-table-1" placeholder="e.g. incident"></div>
            <div class="form-group"><label>Encoded Query</label><input type="text" id="m-query-1" placeholder="e.g. active=true"></div>
          </div>
          <div class="form-group" style="margin-top: 15px;">
            <label style="color:#a78bfa;">Join Key (Source A Column)</label>
            <input type="text" id="m-key-1" placeholder="e.g. sys_id">
          </div>
        </div>

        <div style="flex: 1; background: #1a1d29; border: 1px solid #2d3142; border-radius: 12px; padding: 24px; min-width: 300px;">
          <h4 style="margin-bottom:15px; color:#f472b6;">Source B (Right Table)</h4>
          <div class="toggle-container" style="margin-bottom: 15px;">
            <div class="toggle-btn active" id="m-btn-file-2" onclick="setMergeMode(2, 'file')">📁 File</div>
            <div class="toggle-btn" id="m-btn-live-2" onclick="setMergeMode(2, 'live')">⚡ Live API</div>
          </div>
          <div id="m-panel-file-2">
            <div class="drop-zone" style="padding: 20px;">
              <input type="file" id="m-file-2" accept=".csv,.xlsx,.xls" onchange="document.getElementById('m-fname-2').innerText = this.files[0] ? this.files[0].name : ''" />
              <div style="font-size:24px; margin-bottom:5px;">📄</div>
              <div style="font-weight:600; font-size:12px; color:#e2e8f0;">Drop file here</div>
              <div id="m-fname-2" style="margin-top:5px; color:#4da6ff; font-family:monospace; font-size:11px;"></div>
            </div>
          </div>
          <div id="m-panel-live-2" class="hidden">
            <div class="form-group"><label>Table Name</label><input type="text" id="m-table-2" placeholder="e.g. sys_user"></div>
            <div class="form-group"><label>Encoded Query</label><input type="text" id="m-query-2" placeholder="e.g. active=true"></div>
          </div>
          <div class="form-group" style="margin-top: 15px;">
            <label style="color:#a78bfa;">Join Key (Source B Column)</label>
            <input type="text" id="m-key-2" placeholder="e.g. caller_id">
          </div>
        </div>
      </div>

      <div style="background: #1a1d29; border: 1px solid #2d3142; border-radius: 12px; padding: 24px; margin-top: 20px;">
        <div class="form-group" style="margin:0;">
          <label>Join Type / Logic</label>
          <select id="m-join-type">
            <option value="left">Left Join</option>
            <option value="inner">Inner Join</option>
            <option value="outer">Full Outer Join</option>
          </select>
        </div>
      </div>
    `;
    $('btn-run-tool').onclick = runDataMerge;
    $('btn-run-tool').innerText = 'Execute Join & Download';
  }
  else if (toolId === 'pdf-to-word') {
    titleEl.innerText = 'PDF to Word';
    optionsEl.innerHTML = `<p style="color:#8f9bb3; font-size:13px; margin:0;">Upload a PDF to extract its text and convert it into an editable Microsoft Word document.</p>`;
    $('btn-run-tool').onclick = runPdfToWord;
    $('btn-run-tool').innerText = 'Convert to .docx';
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

window.setMergeMode = function(sourceNum, mode) {
  state.merge[`mode${sourceNum}`] = mode;
  if (mode === 'file') {
    $(`m-btn-file-${sourceNum}`).classList.add('active');
    $(`m-btn-live-${sourceNum}`).classList.remove('active');
    $(`m-panel-file-${sourceNum}`).classList.remove('hidden');
    $(`m-panel-live-${sourceNum}`).classList.add('hidden');
  } else {
    $(`m-btn-live-${sourceNum}`).classList.add('active');
    $(`m-btn-file-${sourceNum}`).classList.remove('active');
    $(`m-panel-live-${sourceNum}`).classList.remove('hidden');
    $(`m-panel-file-${sourceNum}`).classList.add('hidden');
  }
}

function buildPayload() {
  const fd = new FormData();
  if (state.currentMode === 'file') {
    const file = $('ws-file').files[0];
    if (!file) throw new Error("Please select a file to upload.");
    fd.append('file', file);
  } else {
    if (!state.credentials.url) throw new Error("Missing Global Credentials.");
    const table = $('ws-table').value.trim();
    if (!table) throw new Error("Table Name is required for Live Pull.");
    fd.append('instance_url', state.credentials.url);
    fd.append('username', state.credentials.user);
    fd.append('password', state.credentials.pass);
    fd.append('table_name', table);
    fd.append('limit', $('ws-limit').value.trim());
    fd.append('query', $('ws-query').value.trim());
  }
  return fd;
}

async function runPdfToWord() {
  const alertEl = $('ws-alert'); alertEl.className = 'alert info'; alertEl.innerHTML = '⏳ Converting...';
  try {
    const file = $('ws-file').files[0];
    if (!file) throw new Error("Please select a PDF file.");
    const fd = new FormData(); fd.append('file', file);
    const res = await fetch('/api/pdf-to-word', { method: 'POST', body: fd });
    if (!res.ok) throw new Error(await extractError(res));
    triggerDownload(await res.blob(), file.name.replace(/\.[^.]+$/, '') + '.docx');
    alertEl.className = 'alert success'; alertEl.innerHTML = '✅ Success!';
  } catch (err) { alertEl.className = 'alert error'; alertEl.innerHTML = `❌ Error: ${err.message}`; }
}

async function runDataMerge() {
  const alertEl = $('ws-alert'); alertEl.className = 'alert info'; alertEl.innerHTML = '⏳ Joining data...';
  try {
    const fd = new FormData();
    fd.append('mode1', state.merge.mode1); fd.append('mode2', state.merge.mode2);
    if (state.merge.mode1 === 'file') {
      const file1 = $('m-file-1').files[0]; if (!file1) throw new Error("Source A missing file.");
      fd.append('file1', file1);
    } else {
      fd.append('url1', state.credentials.url); fd.append('user1', state.credentials.user);
      fd.append('pass1', state.credentials.pass); fd.append('table1', $('m-table-1').value.trim());
      fd.append('query1', $('m-query-1').value.trim()); fd.append('limit1', 20000); 
    }
    if (state.merge.mode2 === 'file') {
      const file2 = $('m-file-2').files[0]; if (!file2) throw new Error("Source B missing file.");
      fd.append('file2', file2);
    } else {
      fd.append('url2', state.credentials.url); fd.append('user2', state.credentials.user);
      fd.append('pass2', state.credentials.pass); fd.append('table2', $('m-table-2').value.trim());
      fd.append('query2', $('m-query-2').value.trim()); fd.append('limit2', 20000); 
    }
    const key1 = $('m-key-1').value.trim(); const key2 = $('m-key-2').value.trim();
    if (!key1 || !key2) throw new Error("Keys required for both sources.");
    fd.append('key1', key1); fd.append('key2', key2); fd.append('join_type', $('m-join-type').value);
    const res = await fetch('/api/merge-data', { method: 'POST', body: fd });
    if (!res.ok) throw new Error(await extractError(res));
    triggerDownload(await res.blob(), 'merged_data.xlsx');
    alertEl.className = 'alert success'; alertEl.innerHTML = '✅ Success!';
  } catch (err) { alertEl.className = 'alert error'; alertEl.innerHTML = `❌ Error: ${err.message}`; }
}

async function runTransposeData() {
  const alertEl = $('ws-alert'); alertEl.className = 'alert info'; alertEl.innerHTML = '⏳ Transposing data...';
  try {
    const res = await fetch('/api/transpose-data', { method: 'POST', body: buildPayload() });
    if (!res.ok) throw new Error(await extractError(res));
    triggerDownload(await res.blob(), 'transposed.xlsx');
    alertEl.className = 'alert success'; alertEl.innerHTML = '✅ Success!';
  } catch (err) { alertEl.className = 'alert error'; alertEl.innerHTML = `❌ Error: ${err.message}`; }
}

async function runPivotData() {
  const alertEl = $('ws-alert'); alertEl.className = 'alert info'; alertEl.innerHTML = '⏳ Generating pivot...';
  try {
    const fd = buildPayload();
    fd.append('group_col', $('ws-opt-group').value.trim());
    fd.append('value_col', $('ws-opt-valcol').value.trim());
    fd.append('agg_func', $('ws-opt-agg').value);
    const res = await fetch('/api/pivot-data', { method: 'POST', body: fd });
    if (!res.ok) throw new Error(await extractError(res));
    triggerDownload(await res.blob(), 'pivot.xlsx');
    alertEl.className = 'alert success'; alertEl.innerHTML = '✅ Success!';
  } catch (err) { alertEl.className = 'alert error'; alertEl.innerHTML = `❌ Error: ${err.message}`; }
}

async function runRowFilter() {
  const alertEl = $('ws-alert'); alertEl.className = 'alert info'; alertEl.innerHTML = '⏳ Filtering...';
  try {
    const fd = buildPayload();
    fd.append('filter_col', $('ws-opt-col').value.trim());
    fd.append('filter_op', $('ws-opt-op').value); fd.append('filter_val', $('ws-opt-val').value.trim());
    const res = await fetch('/api/row-filter', { method: 'POST', body: fd });
    if (!res.ok) throw new Error(await extractError(res));
    triggerDownload(await res.blob(), 'filtered.xlsx');
    alertEl.className = 'alert success'; alertEl.innerHTML = '✅ Success!';
  } catch (err) { alertEl.className = 'alert error'; alertEl.innerHTML = `❌ Error: ${err.message}`; }
}

async function runCalculatedColumns() {
  const alertEl = $('ws-alert'); alertEl.className = 'alert info'; alertEl.innerHTML = '⏳ Calculating...';
  try {
    const fd = buildPayload();
    fd.append('new_col_name', $('ws-opt-newcol').value.trim());
    fd.append('expression', $('ws-opt-expr').value.trim());
    const res = await fetch('/api/calculated-columns', { method: 'POST', body: fd });
    if (!res.ok) throw new Error(await extractError(res));
    triggerDownload(await res.blob(), 'calc.xlsx');
    alertEl.className = 'alert success'; alertEl.innerHTML = '✅ Success!';
  } catch (err) { alertEl.className = 'alert error'; alertEl.innerHTML = `❌ Error: ${err.message}`; }
}

async function runFindReplace() {
  const alertEl = $('ws-alert'); alertEl.className = 'alert info'; alertEl.innerHTML = '⏳ Processing...';
  try {
    const fd = buildPayload();
    const cols = $('ws-opt-cols').value.trim();
    fd.append('columns', JSON.stringify(cols ? cols.split(',').map(c=>c.trim()) : []));
    fd.append('search_str', $('ws-opt-find').value); fd.append('replace_str', $('ws-opt-replace').value);
    fd.append('use_regex', $('ws-opt-regex').checked); fd.append('match_case', $('ws-opt-case').checked);
    const res = await fetch('/api/find-replace', { method: 'POST', body: fd });
    if (!res.ok) throw new Error(await extractError(res));
    triggerDownload(await res.blob(), 'replaced.xlsx');
    alertEl.className = 'alert success'; alertEl.innerHTML = '✅ Success!';
  } catch (err) { alertEl.className = 'alert error'; alertEl.innerHTML = `❌ Error: ${err.message}`; }
}

async function runColumnOperations() {
  const alertEl = $('ws-alert'); alertEl.className = 'alert info'; alertEl.innerHTML = '⏳ Processing...';
  try {
    const fd = buildPayload();
    const drop = $('ws-opt-drop').value.trim();
    fd.append('drop_columns', JSON.stringify(drop ? drop.split(',').map(c=>c.trim()) : []));
    const renameMap = {};
    $('ws-opt-rename').value.split('\n').forEach(l => {
      const p = l.split('='); if(p.length===2) renameMap[p[0].trim()] = p[1].trim();
    });
    fd.append('rename_columns', JSON.stringify(renameMap));
    const res = await fetch('/api/column-ops', { method: 'POST', body: fd });
    if (!res.ok) throw new Error(await extractError(res));
    triggerDownload(await res.blob(), 'col_ops.xlsx');
    alertEl.className = 'alert success'; alertEl.innerHTML = '✅ Success!';
  } catch (err) { alertEl.className = 'alert error'; alertEl.innerHTML = `❌ Error: ${err.message}`; }
}

async function runFileSplitter() {
  const alertEl = $('ws-alert'); alertEl.className = 'alert info'; alertEl.innerHTML = '⏳ Splitting...';
  try {
    const fd = buildPayload(); fd.append('chunk_size', $('ws-opt-chunk').value);
    const res = await fetch('/api/split-data', { method: 'POST', body: fd });
    if (!res.ok) throw new Error(await extractError(res));
    triggerDownload(await res.blob(), 'split.xlsx');
    alertEl.className = 'alert success'; alertEl.innerHTML = '✅ Success!';
  } catch (err) { alertEl.className = 'alert error'; alertEl.innerHTML = `❌ Error: ${err.message}`; }
}

async function runColumnNormalizer() {
  const alertEl = $('ws-alert'); alertEl.className = 'alert info'; alertEl.innerHTML = '⏳ Normalizing...';
  try {
    const fd = buildPayload();
    const cols = $('ws-opt-cols').value.trim();
    if(!cols) throw new Error("Please specify at least one column.");
    fd.append('columns', JSON.stringify(cols.split(',').map(c=>c.trim())));
    fd.append('action', $('ws-opt-action').value);
    const res = await fetch('/api/normalize-data', { method: 'POST', body: fd });
    if (!res.ok) throw new Error(await extractError(res));
    triggerDownload(await res.blob(), 'normalized.xlsx');
    alertEl.className = 'alert success'; alertEl.innerHTML = '✅ Success!';
  } catch (err) { alertEl.className = 'alert error'; alertEl.innerHTML = `❌ Error: ${err.message}`; }
}

async function runDuplicateFinder() {
  const alertEl = $('ws-alert'); alertEl.className = 'alert info'; alertEl.innerHTML = '⏳ Processing...';
  try {
    const fd = buildPayload();
    const cols = $('ws-opt-cols').value.trim();
    fd.append('check_columns', JSON.stringify(cols ? cols.split(',').map(c=>c.trim()).filter(Boolean) : []));
    const res = await fetch('/api/find-duplicates', { method: 'POST', body: fd });
    if (!res.ok) throw new Error(await extractError(res));
    triggerDownload(await res.blob(), 'deduplicated.xlsx');
    alertEl.className = 'alert success'; alertEl.innerHTML = '✅ Success!';
  } catch (err) { alertEl.className = 'alert error'; alertEl.innerHTML = `❌ Error: ${err.message}`; }
}

async function runAnonymizer() {
  const alertEl = $('ws-alert'); alertEl.className = 'alert info'; alertEl.innerHTML = '⏳ Anonymizing...';
  try {
    const fd = buildPayload();
    const cols = $('ws-opt-cols').value.trim();
    if(!cols) throw new Error("Please specify at least one column.");
    fd.append('columns_to_scrub', JSON.stringify(cols.split(',').map(c=>c.trim())));
    fd.append('preserve_relationships', $('ws-opt-preserve').checked);
    fd.append('export_mapping', $('ws-opt-map').checked);
    const res = await fetch('/api/scrub-data', { method: 'POST', body: fd });
    if (!res.ok) throw new Error(await extractError(res));
    triggerDownload(await res.blob(), 'anonymized.xlsx');
    alertEl.className = 'alert success'; alertEl.innerHTML = '✅ Success!';
  } catch (err) { alertEl.className = 'alert error'; alertEl.innerHTML = `❌ Error: ${err.message}`; }
}

async function runColumnAnalyzer() {
  const alertEl = $('ws-alert'); const resultsEl = $('ws-results');
  alertEl.className = 'alert info'; alertEl.innerHTML = '⏳ Analyzing...'; resultsEl.classList.add('hidden');
  try {
    const res = await fetch('/api/analyze-data', { method: 'POST', body: buildPayload() });
    if (!res.ok) throw new Error(await extractError(res));
    const data = await res.json(); alertEl.style.display = 'none';
    const ov = data.overview;
    let html = `<div class="results-grid"><div class="stat-card"><div class="stat-val">${ov.row_count.toLocaleString()}</div><div class="stat-lbl">Total Rows</div></div><div class="stat-card"><div class="stat-val">${ov.column_count}</div><div class="stat-lbl">Columns</div></div><div class="stat-card"><div class="stat-val">${ov.duplicate_rows}</div><div class="stat-lbl">Duplicate Rows</div></div><div class="stat-card"><div class="stat-val">${ov.total_nulls.toLocaleString()}</div><div class="stat-lbl">Total Nulls</div></div></div><div class="table-container"><table><thead><tr><th>Column</th><th>Type</th><th>Confidence</th><th>Non-Null</th><th>Null %</th><th>Unique</th><th>Min</th><th>Max</th><th>Top Value</th></tr></thead><tbody>`;
    for (const [col, info] of Object.entries(data.columns || {})) {
      const topVal = info.top_values?.[0];
      html += `<tr><td class="mono">${escHtml(col)}</td><td><span class="badge">${escHtml(info.semantic_type)}</span></td><td>${Math.round(info.type_confidence * 100)}%</td><td>${info.non_null.toLocaleString()}</td><td style="color:${info.null_pct > 20 ? '#e74c3c' : '#a0aec0'}">${info.null_pct}%</td><td><span class="badge ${info.is_unique ? 'green' : ''}">${info.unique_count.toLocaleString()} ${info.is_unique ? '🔑' : ''}</span></td><td>${escHtml(info.stats?.min ?? '—')}</td><td>${escHtml(info.stats?.max ?? '—')}</td><td>${escHtml(topVal?.value ?? '—')}</td></tr>`;
    }
    html += `</tbody></table></div>`;
    resultsEl.innerHTML = html; resultsEl.classList.remove('hidden');
  } catch (err) { alertEl.className = 'alert error'; alertEl.innerHTML = `❌ Error: ${err.message}`; }
}

async function runKeyFinder() {
  const alertEl = $('ws-alert'); const resultsEl = $('ws-results');
  alertEl.className = 'alert info'; alertEl.innerHTML = '⏳ Discovering keys...'; resultsEl.classList.add('hidden');
  try {
    const fd = buildPayload();
    const cols = $('ws-opt-cols').value.trim();
    fd.append('selected_columns', JSON.stringify(cols ? cols.split(',').map(c=>c.trim()) : []));
    const res = await fetch('/api/find-keys', { method: 'POST', body: fd });
    if (!res.ok) throw new Error(await extractError(res));
    const data = await res.json(); alertEl.style.display = 'none';
    let html = '';
    if (data.primary_key && data.primary_key.length > 0) {
      html += `<div style="background: rgba(46, 204, 113, 0.1); border: 1px solid rgba(46, 204, 113, 0.2); padding: 16px; border-radius: 8px; margin-bottom: 20px;"><h4 style="color: #2ecc71; margin-bottom: 8px;">🏆 Recommended Primary Key</h4>${data.primary_key.map(c => `<span class="badge green" style="margin-right:8px; font-size:13px;">${escHtml(c)}</span>`).join('')}</div>`;
    } else { html += `<div class="alert info" style="display:block; margin-bottom:20px;">No minimal keys found.</div>`; }
    html += `<h4 style="color:#fff; margin-bottom:10px;">Column Uniqueness Breakdown</h4><div class="table-container"><table><thead><tr><th>Column</th><th>Unique Count</th><th>Uniqueness %</th><th>Is Key?</th></tr></thead><tbody>`;
    for (const [col, info] of Object.entries(data.stats || {})) {
      const isKey = data.minimal_combinations?.some(combo => combo.length === 1 && combo[0] === col);
      html += `<tr><td class="mono">${escHtml(col)}</td><td>${info.unique_count.toLocaleString()}</td><td>${(info.uniqueness * 100).toFixed(1)}%</td><td>${isKey ? '<span class="badge green">Yes</span>' : '<span class="badge">No</span>'}</td></tr>`;
    }
    html += `</tbody></table></div>`;
    resultsEl.innerHTML = html; resultsEl.classList.remove('hidden');
  } catch (err) { alertEl.className = 'alert error'; alertEl.innerHTML = `❌ Error: ${err.message}`; }
}

async function extractError(res) {
  let msg = `HTTP ${res.status}`;
  try { const j = await res.json(); msg = j.error || msg; } catch {}
  return msg;
}

function triggerDownload(blob, defaultFilename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = defaultFilename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
}
