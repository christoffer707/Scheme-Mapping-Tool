/**
 * comparison.js
 * Frontend logic for the unified Data Pipelines & Compare grid.
 */

'use strict';

const state = {
  credentials: { url: '', user: '', pass: '' },
  currentTool: null,
  currentMode: 'file', // Standard tools
  merge: { mode1: 'file', mode2: 'file' } // Merge Tool modes
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
  
  // Disable Live Pull UI specifically for PDF tool
  if (toolId === 'pdf-to-word') {
     $('ws-toggles').style.display = 'none';
     setMode('file');
  } else {
     $('ws-toggles').style.display = 'flex';
  }

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
  else if (toolId === 'row-filter') {
    titleEl.innerText = 'Row Filter';
    optionsEl.innerHTML = `
      <div class="row-flex">
        <div class="form-group">
          <label>Target Column</label>
          <input type="text" id="ws-opt-col" placeholder="e.g. state">
        </div>
        <div class="form-group">
          <label>Condition</label>
          <select id="ws-opt-op">
            <option value="eq">Equals (==)</option>
            <option value="neq">Does Not Equal (!=)</option>
            <option value="contains">Contains</option>
            <option value="not_contains">Does Not Contain</option>
            <option value="gt">Greater Than (>)</option>
            <option value="lt">Less Than (<)</option>
            <option value="empty">Is Empty</option>
            <option value="not_empty">Is Not Empty</option>
          </select>
        </div>
        <div class="form-group">
          <label>Value</label>
          <input type="text" id="ws-opt-val" placeholder="e.g. Closed">
        </div>
      </div>
    `;
    $('btn-run-tool').onclick = runRowFilter;
    $('btn-run-tool').innerText = 'Filter Rows & Download';
  }
  else if (toolId === 'calculated-columns') {
    titleEl.innerText = 'Calculated Columns';
    optionsEl.innerHTML = `
      <div class="form-group">
        <label>New Column Name</label>
        <input type="text" id="ws-opt-newcol" placeholder="e.g. full_name">
      </div>
      <div class="form-group">
        <label>Formula Expression <span style="color:#888;">(Wrap existing column names in brackets)</span></label>
        <input type="text" id="ws-opt-expr" placeholder="e.g. [first_name] + ' ' + [last_name] OR [price] * 1.08">
      </div>
    `;
    $('btn-run-tool').onclick = runCalculatedColumns;
    $('btn-run-tool').innerText = 'Calculate & Download';
  }
  else if (toolId === 'transpose-data') {
    titleEl.innerText = 'Transpose Data';
    optionsEl.innerHTML = `<p style="color:#8f9bb3; font-size:13px; margin:0;">No additional options required. This will flip all rows and columns in the dataset.</p>`;
    $('btn-run-tool').onclick = runTransposeData;
    $('btn-run-tool').innerText = 'Transpose & Download';
  }
  else if (toolId === 'pivot-data') {
    titleEl.innerText = 'Pivot Table Generator';
    optionsEl.innerHTML = `
      <div class="row-flex">
        <div class="form-group">
          <label>Group By Column <span style="color:#888;">(Required)</span></label>
          <input type="text" id="ws-opt-group" placeholder="e.g. state">
        </div>
        <div class="form-group">
          <label>Value Column <span style="color:#888;">(Optional for Count)</span></label>
          <input type="text" id="ws-opt-valcol" placeholder="e.g. cost">
        </div>
        <div class="form-group">
          <label>Aggregation Function</label>
          <select id="ws-opt-agg">
            <option value="count">Count (Rows)</option>
            <option value="sum">Sum</option>
            <option value="avg">Average</option>
            <option value="max">Max</option>
            <option value="min">Min</option>
          </select>
        </div>
      </div>
    `;
    $('btn-run-tool').onclick = runPivotData;
    $('btn-run-tool').innerText = 'Generate Pivot & Download';
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
            <option value="left">Left Join (Keep all Source A rows, append matching B)</option>
            <option value="inner">Inner Join (Keep ONLY rows where A and B keys match)</option>
            <option value="right">Right Join (Keep all Source B rows, append matching A)</option>
            <option value="outer">Full Outer Join (Keep EVERYTHING from A and B)</option>
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

// ── NEW: PDF to Word ───────────────────────────────────────────────────────
async function runPdfToWord() {
  const alertEl = $('ws-alert');
  alertEl.className = 'alert info';
  alertEl.innerHTML = '⏳ Converting Document...';

  try {
    const file = $('ws-file').files[0];
    if (!file) throw new Error("Please select a PDF file to upload.");
    
    const fd = new FormData();
    fd.append('file', file);

    const res = await fetch('/api/pdf-to-word', { method: 'POST', body: fd });
    if (!res.ok) throw new Error(await extractError(res));

    triggerDownload(await res.blob(), file.name.replace(/\.[^.]+$/, '') + '.docx');
    alertEl.className = 'alert success';
    alertEl.innerHTML = '✅ Success! Your converted Word document has been downloaded.';
  } catch (err) {
    alertEl.className = 'alert error';
    alertEl.innerHTML = `❌ Error: ${err.message}`;
  }
}

// ── Existing Tools ─────────────────────────────────────────────────────────
async function runDataMerge() {
  const alertEl = $('ws-alert');
  alertEl.className = 'alert info';
  alertEl.innerHTML = '⏳ Extracting and joining data...';

  try {
    const fd = new FormData();
    const mode1 = state.merge.mode1;
    const mode2 = state.merge.mode2;

    fd.append('mode1', mode1);
    fd.append('mode2', mode2);

    if (mode1 === 'file') {
      const file1 = $('m-file-1').files[0];
      if (!file1) throw new Error("Source A is missing a file upload.");
      fd.append('file1', file1);
    } else {
      if (!state.credentials.url) throw new Error("Missing Global Credentials for Live Pull on Source A.");
      fd.append('url1', state.credentials.url);
      fd.append('user1', state.credentials.user);
      fd.append('pass1', state.credentials.pass);
      fd.append('table1', $('m-table-1').value.trim());
      fd.append('query1', $('m-query-1').value.trim());
      fd.append('limit1', 20000); 
    }

    if (mode2 === 'file') {
      const file2 = $('m-file-2').files[0];
      if (!file2) throw new Error("Source B is missing a file upload.");
      fd.append('file2', file2);
    } else {
      if (!state.credentials.url) throw new Error("Missing Global Credentials for Live Pull on Source B.");
      fd.append('url2', state.credentials.url);
      fd.append('user2', state.credentials.user);
      fd.append('pass2', state.credentials.pass);
      fd.append('table2', $('m-table-2').value.trim());
      fd.append('query2', $('m-query-2').value.trim());
      fd.append('limit2', 20000); 
    }

    const key1 = $('m-key-1').value.trim();
    const key2 = $('m-key-2').value.trim();
    if (!key1 || !key2) throw new Error("You must specify a Join Key for both Source A and Source B.");

    fd.append('key1', key1);
    fd.append('key2', key2);
    fd.append('join_type', $('m-join-type').value);

    const res = await fetch('/api/merge-data', { method: 'POST', body: fd });
    if (!res.ok) throw new Error(await extractError(res));

    triggerDownload(await res.blob(), 'merged_data_export.xlsx');
    alertEl.className = 'alert success';
    alertEl.innerHTML = '✅ Success! Your joined data file has been downloaded.';
  } catch (err) {
    alertEl.className = 'alert error';
    alertEl.innerHTML = `❌ Error: ${err.message}`;
  }
}

async function runTransposeData() {
  const alertEl = $('ws-alert');
  alertEl.className = 'alert info';
  alertEl.innerHTML = '⏳ Transposing data...';

  try {
    const fd = buildPayload();
    const res = await fetch('/api/transpose-data', { method: 'POST', body: fd });
    if (!res.ok) throw new Error(await extractError(res));

    triggerDownload(await res.blob(), 'transposed_export.xlsx');
    alertEl.className = 'alert success';
    alertEl.innerHTML = '✅ Success! Your transposed file has been downloaded.';
  } catch (err) {
    alertEl.className = 'alert error';
    alertEl.innerHTML = `❌ Error: ${err.message}`;
  }
}

async function runPivotData() {
  const alertEl = $('ws-alert');
  alertEl.className = 'alert info';
  alertEl.innerHTML = '⏳ Generating pivot table...';

  try {
    const fd = buildPayload();
    fd.append('group_col', $('ws-opt-group').value.trim());
    fd.append('value_col', $('ws-opt-valcol').value.trim());
    fd.append('agg_func', $('ws-opt-agg').value);

    const res = await fetch('/api/pivot-data', { method: 'POST', body: fd });
    if (!res.ok) throw new Error(await extractError(res));

    triggerDownload(await res.blob(), 'pivot_export.xlsx');
    alertEl.className = 'alert success';
    alertEl.innerHTML = '✅ Success! Your pivot table has been downloaded.';
  } catch (err) {
    alertEl.className = 'alert error';
    alertEl.innerHTML = `❌ Error: ${err.message}`;
  }
}

async function runRowFilter() {
  const alertEl = $('ws-alert');
  alertEl.className = 'alert info';
  alertEl.innerHTML = '⏳ Filtering rows...';

  try {
    const fd = buildPayload();
    fd.append('filter_col', $('ws-opt-col').value.trim());
    fd.append('filter_op', $('ws-opt-op').value);
    fd.append('filter_val', $('ws-opt-val').value.trim());

    const res = await fetch('/api/row-filter', { method: 'POST', body: fd });
    if (!res.ok) throw new Error(await extractError(res));

    triggerDownload(await res.blob(), 'filtered_export.xlsx');
    alertEl.className = 'alert success';
    alertEl.innerHTML = '✅ Success! Your filtered file has been downloaded.';
  } catch (err) {
    alertEl.className = 'alert error';
    alertEl.innerHTML = `❌ Error: ${err.message}`;
  }
}

async function runCalculatedColumns() {
  const alertEl = $('ws-alert');
  alertEl.className = 'alert info';
  alertEl.innerHTML = '⏳ Calculating columns...';

  try {
    const fd = buildPayload();
    fd.append('new_col_name', $('ws-opt-newcol').value.trim());
    fd.append('expression', $('ws-opt-expr').value.trim());

    const res = await fetch('/api/calculated-columns', { method: 'POST', body: fd });
    if (!res.ok) throw new Error(await extractError(res));

    triggerDownload(await res.blob(), 'calc_export.xlsx');
    alertEl.className = 'alert success';
    alertEl.innerHTML = '✅ Success! Your file with calculated columns has been downloaded.';
  } catch (err) {
    alertEl.className = 'alert error';
    alertEl.innerHTML = `❌ Error: ${err.message}`;
  }
}

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
        if (parts.length === 2) renameMap[parts[0].trim()] = parts[1].trim();
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
