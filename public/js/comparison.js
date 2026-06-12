/**
 * comparison.js
 * Frontend logic for the unified Data Pipelines & Compare grid.
 */

'use strict';

const state = {
  credentials: { url: '', user: '', pass: '' },
  currentTool: null,
  currentMode: 'file' // 'file' or 'live'
};

function $(id) { return document.getElementById(id); }

// ── Global Credentials ─────────────────────────────────────────────────────

function saveGlobalCredentials() {
  state.credentials.url = $('g-url').value.trim();
  state.credentials.user = $('g-user').value.trim();
  state.credentials.pass = $('g-pass').value;
  
  const status = $('cred-status');
  status.style.display = 'block';
  setTimeout(() => status.style.display = 'none', 3000);
}

// ── UI Navigation ──────────────────────────────────────────────────────────

function openTool(toolId) {
  state.currentTool = toolId;
  $('dashboard').style.display = 'none';
  $('workspace').style.display = 'block';
  $('ws-alert').className = 'alert';
  $('ws-alert').innerHTML = '';

  const titleEl = $('ws-title');
  const optionsEl = $('ws-options');
  
  // Build UI specifically for the tool selected
  if (toolId === 'duplicate-finder') {
    titleEl.innerText = 'Duplicate Finder';
    optionsEl.innerHTML = `
      <div class="form-group">
        <label>Columns to Check for Duplicates <span style="color:#888;">(Comma-separated. Leave blank to check entire row)</span></label>
        <input type="text" id="ws-opt-cols" placeholder="e.g. email, employee_number">
      </div>
    `;
    $('btn-run-tool').onclick = runDuplicateFinder;
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

// ── Tool Executions ────────────────────────────────────────────────────────

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

async function runDuplicateFinder() {
  const alertEl = $('ws-alert');
  alertEl.className = 'alert info';
  alertEl.innerHTML = '⏳ Processing data... This may take a moment for large datasets.';

  try {
    const fd = buildPayload();
    
    const cols = $('ws-opt-cols').value.trim();
    const colArr = cols ? cols.split(',').map(c => c.trim()).filter(Boolean) : [];
    fd.append('check_columns', JSON.stringify(colArr));

    const res = await fetch('/api/find-duplicates', { method: 'POST', body: fd });
    
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try { const j = await res.json(); msg = j.error || msg; } catch {}
      throw new Error(msg);
    }

    // Trigger file download
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `deduplicated_export.xlsx`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    alertEl.className = 'alert success';
    alertEl.innerHTML = '✅ Success! Your deduplicated Excel file has been downloaded.';
  } catch (err) {
    alertEl.className = 'alert error';
    alertEl.innerHTML = `❌ Error: ${err.message}`;
  }
}
