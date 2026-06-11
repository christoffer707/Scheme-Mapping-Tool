import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import comparisonRouter from './routes/comparison.js';
import liveComparisonRouter from './routes/liveComparison.js';
import { fetchServiceNowSchema, fetchServiceNowTableArtifacts } from './utils/servicenowAPI.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

app.use(express.static(join(__dirname, 'public')));
app.use('/api', comparisonRouter);
app.use('/api/live', liveComparisonRouter);

let schemaCache = null;
let currentCredentials = null; 

app.post('/api/erd/generate', async (req, res) => {
  try {
    const { instance, username, password } = req.body;
    if (!instance || !username || !password) return res.status(400).json({ error: 'Missing required fields.' });

    const schema = await fetchServiceNowSchema(instance, username, password, { includeCore: true });
    currentCredentials = { instance, username, password };

    const entities = {};
    schema.tables.forEach(t => {
      entities[t.name] = { id: t.sys_id, name: t.name, label: t.label, fields: schema.columns[t.name] || [] };
    });

    schemaCache = { entities, relationships: schema.relationships };
    res.json({ success: true, message: `Loaded ${schema.tables.length} tables.`, erd: schemaCache });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/erd/table-details', async (req, res) => {
  try {
    const { table } = req.body;
    if (!table || !currentCredentials) return res.status(400).json({ error: 'Missing table or session expired.' });

    const artifacts = await fetchServiceNowTableArtifacts(
      currentCredentials.instance, currentCredentials.username, currentCredentials.password, table
    );
    res.json({ success: true, artifacts });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/', (req, res) => res.send(getHTMLPage()));
app.get('/comparison', (req, res) => res.sendFile(join(__dirname, 'public', 'comparison.html')));
app.get('/live-compare', (req, res) => res.sendFile(join(__dirname, 'public', 'live-compare.html')));

function getHTMLPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ServiceNow ERD Visualizer</title>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/vis/4.21.0/vis.min.js"></script>
  <link href="https://cdnjs.cloudflare.com/ajax/libs/vis/4.21.0/vis.min.css" rel="stylesheet" type="text/css" />
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #1a1a2e; color: #333; overflow: hidden; }
    .container { display: flex; height: 100vh; width: 100vw; }
    
    /* Sidebar */
    .sidebar { width: 350px; background: white; border-right: 1px solid #ddd; display: flex; flex-direction: column; z-index: 10; }
    .sidebar-header { padding: 20px; border-bottom: 1px solid #ddd; }
    .controls { padding: 20px; border-bottom: 1px solid #ddd; background: #f9f9f9; }
    .table-search-container { padding: 15px; border-bottom: 1px solid #ddd; background: #fff; }
    .entity-list { flex: 1; overflow-y: auto; padding: 10px; }
    
    /* Main Canvas */
    .main { flex: 1; position: relative; background: #1a1a2e; display: flex; }
    #network { flex: 1; height: 100%; }
    .canvas-overlay { position: absolute; top: 20px; left: 20px; color: white; background: rgba(0,0,0,0.75); padding: 12px 18px; border-radius: 8px; font-size: 13px; z-index: 5; pointer-events: none; line-height: 1.5; border: 1px solid rgba(255,255,255,0.1); }
    
    /* Detail Panel */
    .detail-panel { width: 450px; background: white; border-left: 1px solid #ddd; display: flex; flex-direction: column; transform: translateX(100%); transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1); position: absolute; right: 0; top: 0; bottom: 0; z-index: 20; box-shadow: -4px 0 25px rgba(0,0,0,0.2); }
    .detail-panel.open { transform: translateX(0); }
    .detail-header { padding: 20px; background: #0066cc; color: white; display: flex; justify-content: space-between; align-items: center; }
    .detail-close { cursor: pointer; font-size: 20px; font-weight: bold; }
    .detail-body { flex: 1; overflow-y: auto; padding: 20px; }
    
    /* Artifacts */
    .artifact-section { margin-bottom: 24px; }
    .artifact-section h4 { border-bottom: 2px solid #eee; padding-bottom: 5px; margin-bottom: 12px; color: #333; font-size: 14px; display: flex; justify-content: space-between; }
    .artifact-item { background: #f8f9fa; padding: 10px; margin-bottom: 8px; border-radius: 6px; border: 1px solid #e9ecef; border-left: 4px solid #7c3aed; }
    .artifact-title { font-weight: 600; font-size: 13px; color: #222; margin-bottom: 4px; word-break: break-all; }
    .artifact-meta { font-size: 11px; color: #666; display: flex; gap: 8px; flex-wrap: wrap; }
    .badge { padding: 2px 6px; border-radius: 4px; font-size: 10px; font-weight: 600; text-transform: uppercase; }
    .badge-active { background: #d4edda; color: #155724; }
    .badge-inactive { background: #f8d7da; color: #721c24; }
    .badge-type { background: #e2e3e5; color: #383d41; }

    /* Forms & Utilities */
    .form-group { margin-bottom: 12px; }
    label { display: block; font-weight: 600; margin-bottom: 4px; font-size: 12px; color: #555; }
    input { width: 100%; padding: 8px; border: 1px solid #ccc; border-radius: 4px; font-size: 13px; }
    button { background: #0066cc; color: white; padding: 10px; border: none; border-radius: 4px; cursor: pointer; font-weight: 600; width: 100%; margin-bottom: 8px; }
    button:hover { background: #0052a3; }
    button.btn-secondary { background: #444; }
    button.btn-secondary:hover { background: #222; }
    
    .entity-item { padding: 10px; background: #fff; border: 1px solid #eee; border-radius: 4px; margin-bottom: 8px; cursor: pointer; border-left: 4px solid #0066cc; }
    .entity-item:hover { background: #f0f7ff; }
    .entity-item.active { background: #e6f2ff; border-color: #cce5ff; }
    .entity-item h4 { font-size: 13px; margin-bottom: 3px; word-break: break-all; }
    .entity-item p { font-size: 11px; color: #888; }
    
    .empty-state { text-align: center; color: #888; padding: 40px 20px; font-size: 14px; }
    .alert { padding: 10px; border-radius: 4px; margin-bottom: 15px; font-size: 13px; }
    .alert.error { background: #ffebee; color: #c62828; border-left: 4px solid #c62828; }
    .alert.loading { background: #e3f2fd; color: #1565c0; border-left: 4px solid #1565c0; }
  </style>
</head>
<body>
  <div class="container">
    <div class="sidebar">
      <div class="sidebar-header">
        <h2 style="font-size: 18px; color: #333;">SN ERD Visualizer</h2>
        <div style="margin-top:10px; display:flex; flex-direction:column; gap:6px;">
          <a href="/comparison" style="font-size:12px; color:#0066cc; text-decoration:none; font-weight:600;">&#8644; Compare & Analyze Instances</a>
          <a href="/live-compare" style="font-size:12px; color:#1a7a4a; text-decoration:none; font-weight:600;">&#9889; Live Dual-Instance Compare</a>
        </div>
      </div>
      
      <div class="controls">
        <div id="message"></div>
        <div class="form-group"><label>Instance Name</label><input type="text" id="instance" placeholder="dev12345"></div>
        <div class="form-group"><label>Username</label><input type="text" id="username" placeholder="admin"></div>
        <div class="form-group"><label>Password</label><input type="password" id="password" placeholder="••••••••"></div>
        <button onclick="generateERD()">Connect & Fetch Schema</button>
      </div>

      <div class="table-search-container" id="search-container" style="display:none;">
        <input type="text" id="tableSearch" placeholder="Search tables (e.g., incident)..." onkeyup="filterTables()">
        <button class="btn-secondary" style="margin-top: 10px; font-size: 11px; padding: 6px;" onclick="renderMacroGraph(false)">Show All Relationships (Macro View)</button>
        <div style="font-size: 11px; color: #888; margin-top: 6px;" id="table-count-label"></div>
      </div>

      <div class="entity-list" id="entityList"><div class="empty-state">Connect to load tables.</div></div>
    </div>

    <div class="main">
      <div class="canvas-overlay" id="canvas-status">Waiting for connection...</div>
      <div id="network"></div>
      
      <div class="detail-panel" id="detailPanel">
        <div class="detail-header">
          <div>
            <div style="font-size: 12px; opacity: 0.8;">Selected Table</div>
            <h3 id="dp-table-name" style="margin: 0; font-size: 18px;">table_name</h3>
          </div>
          <div class="detail-close" onclick="closeDetailPanel()">✕</div>
        </div>
        <div class="detail-body" id="dp-body">
          <div class="empty-state" id="dp-loading">Fetching table artifacts from ServiceNow...</div>
          <div id="dp-content" style="display:none;">
            <div class="artifact-section"><h4><span>Database Columns</span> <span class="badge badge-type" id="dp-fields-count">0</span></h4></div>
            <div class="artifact-section"><h4><span>Business Rules</span> <span class="badge badge-type" id="dp-br-count">0</span></h4><div id="dp-brs"></div></div>
            <div class="artifact-section"><h4><span>Client Scripts</span> <span class="badge badge-type" id="dp-cs-count">0</span></h4><div id="dp-scripts"></div></div>
            <div class="artifact-section"><h4><span>UI Policies</span> <span class="badge badge-type" id="dp-ui-count">0</span></h4><div id="dp-policies"></div></div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <script>
    let network = null;
    let currentERD = null;
    let tableDOMNodes = []; 

    async function generateERD() {
      const instance = document.getElementById('instance').value;
      const username = document.getElementById('username').value;
      const password = document.getElementById('password').value;
      const messageDiv = document.getElementById('message');

      if (!instance || !username || !password) return messageDiv.innerHTML = '<div class="alert error">Fill in all fields</div>';

      messageDiv.innerHTML = '<div class="alert loading">Fetching schema... (this may take over 60 seconds on large instances)</div>';
      document.getElementById('canvas-status').innerText = 'Fetching schema...';

      try {
        const response = await fetch('/api/erd/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ instance, username, password })
        });

        if (!response.ok) {
           let errText = await response.text();
           try { errText = JSON.parse(errText).error || errText; } catch(e) {}
           throw new Error(errText || 'Connection Timeout or Unknown Server Error');
        }

        const data = await response.json();
        currentERD = data.erd;
        messageDiv.innerHTML = '';
        
        document.getElementById('search-container').style.display = 'block';
        document.getElementById('table-count-label').innerText = \`\${Object.keys(currentERD.entities).length} tables loaded\`;
        
        populateEntityList(currentERD);
        
        // Calculate Stats
        let customCount = 0, coreCount = 0, stdCount = 0;
        Object.keys(currentERD.entities).forEach(name => {
           const type = getTableType(name);
           if(type === 'custom') customCount++;
           else if(type === 'core') coreCount++;
           else stdCount++;
        });

        const initialStatusHTML = \`
          <strong style="font-size:15px;color:#4da6ff;">Schema Successfully Loaded!</strong><br>
          <div style="margin-top:6px;margin-bottom:6px;display:flex;gap:12px;">
            <span><span style="color:#2ecc71;">■</span> Custom: \${customCount}</span>
            <span><span style="color:#b366ff;">■</span> Core: \${coreCount}</span>
            <span><span style="color:#3399ff;">■</span> Platform: \${stdCount}</span>
          </div>
          <span style="color:#aaa;">Search & click a table in the sidebar to map its relationships.</span>
        \`;

        // Render Macro view by default, but HIDE EDGES so it doesn't hairball
        renderMacroGraph(true, initialStatusHTML);

      } catch (error) {
        messageDiv.innerHTML = \`<div class="alert error">\${error.message}</div>\`;
        document.getElementById('canvas-status').innerText = 'Error loading schema.';
      }
    }

    function getTableType(tableName) {
      if (tableName.startsWith('u_') || tableName.startsWith('x_')) return 'custom';
      if (tableName.startsWith('sys_') || tableName.startsWith('cmdb_') || tableName.startsWith('sn_') || 
          ['incident', 'change_request', 'problem', 'request', 'sc_req_item', 'task'].includes(tableName)) return 'core';
      return 'standard';
    }

    function getTableColor(tableName) {
      const type = getTableType(tableName);
      if (type === 'custom') return { bg: '#1a7a4a', border: '#155f3a' };
      if (type === 'core') return { bg: '#7c3aed', border: '#6d28d9' };
      return { bg: '#0066cc', border: '#003d99' };
    }

    function populateEntityList(erd) {
      const list = document.getElementById('entityList');
      list.innerHTML = '';
      tableDOMNodes = [];

      Object.keys(erd.entities).sort().forEach(name => {
        const entity = erd.entities[name];
        const div = document.createElement('div');
        div.className = 'entity-item';
        div.style.borderLeftColor = getTableColor(name).bg;
        div.innerHTML = \`<h4>\${name}</h4><p>\${entity.label || 'No Label'}</p>\`;
        div.onclick = () => selectAndRenderTable(name, div);
        list.appendChild(div);
        tableDOMNodes.push({ name: name, label: (entity.label || '').toLowerCase(), element: div });
      });
    }

    function filterTables() {
      const q = document.getElementById('tableSearch').value.toLowerCase();
      tableDOMNodes.forEach(item => {
        item.element.style.display = (item.name.toLowerCase().includes(q) || item.label.includes(q)) ? 'block' : 'none';
      });
    }

    // Contextual Graphing (1st-degree table relations only)
    function selectAndRenderTable(targetTableName, clickedElement) {
      document.querySelectorAll('.entity-item').forEach(el => el.classList.remove('active'));
      if (clickedElement) clickedElement.classList.add('active');

      document.getElementById('canvas-status').innerHTML = \`Calculating Layout for: <strong style="color:#4da6ff;">\${targetTableName}</strong>...<br><span style="color:#aaa;">(Please wait...)</span>\`;
      fetchTableArtifacts(targetTableName);

      const nodes = new vis.DataSet();
      const edges = new vis.DataSet();
      const addedNodes = new Set();
      let edgeCount = 0;

      function addNode(tableName, isCenter = false) {
        if (addedNodes.has(tableName)) return;
        const entity = currentERD.entities[tableName];
        if (!entity) return; 
        
        const c = getTableColor(tableName);
        nodes.add({
          id: tableName, label: tableName, title: entity.label,
          color: { background: c.bg, border: c.border },
          font: { color: 'white', size: isCenter ? 16 : 12 },
          shape: 'box', margin: 10, borderWidth: isCenter ? 3 : 1, shadow: true
        });
        addedNodes.add(tableName);
      }

      addNode(targetTableName, true);

      currentERD.relationships.forEach(rel => {
        if (rel.from === targetTableName || rel.to === targetTableName) {
          addNode(rel.from === targetTableName ? rel.to : rel.from);
          edges.add({
            from: rel.from, to: rel.to, label: rel.field, arrows: 'to',
            color: { color: '#888', highlight: '#00aaff' }, 
            // Gives the text a clean white box so they don't visually overlap the lines or background
            font: { size: 11, color: '#111', background: '#ffffff', strokeWidth: 2, strokeColor: '#ffffff', align: 'middle' },
            // Ensures multiple edges between the same two tables fan out instead of overlapping
            smooth: { type: 'curvedCW', roundness: 0.2 } 
          });
          edgeCount++;
        }
      });

      if (network) network.destroy();
      
      const container = document.getElementById('network');
      const options = {
        physics: {
          enabled: true,
          solver: 'forceAtlas2Based',
          forceAtlas2Based: { gravitationalConstant: -100, centralGravity: 0.01, springConstant: 0.08, springLength: 150 },
          stabilization: { enabled: true, iterations: 150, updateInterval: 50 }
        },
        interaction: { hover: true, dragNodes: true, hideEdgesOnDrag: true }
      };

      network = new vis.Network(container, { nodes, edges }, options);

      network.once('stabilizationIterationsDone', () => {
        network.setOptions({ physics: { enabled: false } }); 
        document.getElementById('canvas-status').innerHTML = \`Viewing dependencies for: <strong style="color:#4da6ff;">\${targetTableName}</strong><br><span style="color:#aaa;">(\${edgeCount} relationships mapped)</span>\`;
        network.fit({ animation: { duration: 500, easingFunction: 'easeInOutQuad' } });
      });
    }

    // Pass "hideEdges = true" on initial load to prevent hairball crash
    function renderMacroGraph(hideEdges = false, customStatusHTML = null) {
      if (customStatusHTML) {
        document.getElementById('canvas-status').innerHTML = customStatusHTML;
      } else {
        document.getElementById('canvas-status').innerText = hideEdges 
          ? 'Rendering instance overview (Lines hidden for performance)...' 
          : 'Rendering entire instance schema... WARNING: This may cause extreme lag.';
      }

      const nodes = new vis.DataSet();
      const edges = new vis.DataSet();
      
      Object.keys(currentERD.entities).forEach(name => {
        const c = getTableColor(name);
        nodes.add({
          id: name, label: name,
          color: { background: c.bg, border: c.border }, font: { color: 'white', size: 10 },
          shape: 'box', margin: 6
        });
      });

      if (!hideEdges) {
        currentERD.relationships.forEach(rel => {
          if (currentERD.entities[rel.from] && currentERD.entities[rel.to]) {
            edges.add({ from: rel.from, to: rel.to, arrows: 'to', color: { color: '#444' } });
          }
        });
      }

      if (network) network.destroy();
      network = new vis.Network(document.getElementById('network'), { nodes, edges }, {
        physics: { enabled: false }, 
        layout: { improvedLayout: false },
        interaction: { hideEdgesOnDrag: true, hideEdgesOnZoom: true }
      });
    }

    async function fetchTableArtifacts(tableName) {
      const panel = document.getElementById('detailPanel');
      document.getElementById('dp-table-name').innerText = tableName;
      document.getElementById('dp-loading').style.display = 'block';
      document.getElementById('dp-content').style.display = 'none';
      panel.classList.add('open');

      try {
        const res = await fetch('/api/erd/table-details', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ table: tableName })
        });
        const data = await res.json();
        if(data.success) renderArtifacts(tableName, data.artifacts);
        else document.getElementById('dp-loading').innerHTML = '<span style="color:red">Failed to load artifacts.</span>';
      } catch (e) {
        document.getElementById('dp-loading').innerHTML = '<span style="color:red">Error communicating with server.</span>';
      }
    }

    function renderArtifacts(tableName, art) {
      document.getElementById('dp-loading').style.display = 'none';
      document.getElementById('dp-content').style.display = 'block';

      const entity = currentERD.entities[tableName];
      document.getElementById('dp-fields-count').innerText = entity ? entity.fields.length : 0;

      const buildHtml = (items, renderer) => items.length === 0 
        ? '<div class="empty-state" style="padding:10px;">None found</div>' 
        : items.map(renderer).join('');

      document.getElementById('dp-br-count').innerText = art.businessRules.length;
      document.getElementById('dp-brs').innerHTML = buildHtml(art.businessRules, br => \`
        <div class="artifact-item">
          <div class="artifact-title">\${br.name}</div>
          <div class="artifact-meta">
            <span class="badge \${br.active === 'true' ? 'badge-active' : 'badge-inactive'}">\${br.active === 'true' ? 'Active' : 'Inactive'}</span>
            \${br.when ? \`<span class="badge badge-type">\${br.when}</span>\` : ''}
            <span style="margin-left:auto; color:#888;">
              \${br.action_insert==='true'?'Ins ':''}\${br.action_update==='true'?'Upd ':''}\${br.action_delete==='true'?'Del ':''}
            </span>
          </div>
        </div>
      \`);

      document.getElementById('dp-cs-count').innerText = art.clientScripts.length;
      document.getElementById('dp-scripts').innerHTML = buildHtml(art.clientScripts, cs => \`
        <div class="artifact-item" style="border-left-color: #1a7a4a;">
          <div class="artifact-title">\${cs.name}</div>
          <div class="artifact-meta">
            <span class="badge \${cs.active === 'true' ? 'badge-active' : 'badge-inactive'}">\${cs.active === 'true' ? 'Active' : 'Inactive'}</span>
            \${cs.type ? \`<span class="badge badge-type">\${cs.type}</span>\` : ''}
          </div>
        </div>
      \`);

      document.getElementById('dp-ui-count').innerText = art.uiPolicies.length;
      document.getElementById('dp-policies').innerHTML = buildHtml(art.uiPolicies, ui => \`
        <div class="artifact-item" style="border-left-color: #0066cc;">
          <div class="artifact-title">\${ui.short_description || 'Untitled'}</div>
          <div class="artifact-meta">
            <span class="badge \${ui.active === 'true' ? 'badge-active' : 'badge-inactive'}">\${ui.active === 'true' ? 'Active' : 'Inactive'}</span>
          </div>
        </div>
      \`);
    }

    function closeDetailPanel() {
      document.getElementById('detailPanel').classList.remove('open');
      document.querySelectorAll('.entity-item').forEach(el => el.classList.remove('active'));
    }
  </script>
</body>
</html>`;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`ServiceNow ERD Visualizer running on port ${PORT}`));
