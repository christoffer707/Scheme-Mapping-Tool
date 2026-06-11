import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import comparisonRouter from './routes/comparison.js';
import liveComparisonRouter from './routes/liveComparison.js';
import { fetchServiceNowSchema } from './utils/servicenowAPI.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

app.use(express.static(join(__dirname, 'public')));
app.use('/api', comparisonRouter);
app.use('/api/live', liveComparisonRouter);

let schemaCache = null;

app.post('/api/erd/generate', async (req, res) => {
  try {
    const { instance, username, password } = req.body;

    if (!instance || !username || !password) {
      return res.status(400).json({ error: 'Missing required fields: instance, username, password' });
    }

    const schema = await fetchServiceNowSchema(instance, username, password, { includeCore: true });

    const entities = {};
    schema.tables.forEach(t => {
      entities[t.name] = {
        id: t.sys_id,
        name: t.name,
        label: t.label,
        fields: schema.columns[t.name] || []
      };
    });

    const erd = { entities, relationships: schema.relationships };
    schemaCache = erd;

    res.json({
      success: true,
      message: `Successfully generated ERD for ${schema.tables.length} tables`,
      erd
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/erd', (req, res) => {
  if (!schemaCache) {
    return res.status(404).json({ error: 'No ERD generated yet. POST to /api/erd/generate first.' });
  }
  res.json(schemaCache);
});

app.get('/', (req, res) => {
  res.send(getHTMLPage());
});

app.get('/comparison', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'comparison.html'));
});

app.get('/live-compare', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'live-compare.html'));
});

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
    
    /* Detail Panel (Right) */
    .detail-panel { width: 400px; background: white; border-left: 1px solid #ddd; display: flex; flex-direction: column; transform: translateX(100%); transition: transform 0.3s ease; position: absolute; right: 0; top: 0; bottom: 0; z-index: 20; box-shadow: -4px 0 15px rgba(0,0,0,0.1); }
    .detail-panel.open { transform: translateX(0); }
    .detail-header { padding: 20px; background: #0066cc; color: white; display: flex; justify-content: space-between; align-items: center; }
    .detail-close { cursor: pointer; font-size: 20px; font-weight: bold; }
    .detail-body { flex: 1; overflow-y: auto; padding: 20px; }
    .artifact-section { margin-bottom: 20px; }
    .artifact-section h4 { border-bottom: 2px solid #eee; padding-bottom: 5px; margin-bottom: 10px; color: #555; }
    .artifact-item { background: #f5f5f5; padding: 8px; margin-bottom: 5px; border-radius: 4px; font-size: 12px; border-left: 3px solid #7c3aed; }
    
    /* Form Elements */
    .form-group { margin-bottom: 12px; }
    label { display: block; font-weight: 600; margin-bottom: 4px; font-size: 12px; color: #555; }
    input { width: 100%; padding: 8px; border: 1px solid #ccc; border-radius: 4px; font-size: 13px; }
    input:focus { border-color: #0066cc; outline: none; }
    button { background: #0066cc; color: white; padding: 10px; border: none; border-radius: 4px; cursor: pointer; font-weight: 600; width: 100%; transition: background 0.2s; }
    button:hover { background: #0052a3; }
    
    /* Table Items */
    .entity-item { padding: 10px; background: #fff; border: 1px solid #eee; border-radius: 4px; margin-bottom: 8px; cursor: pointer; border-left: 4px solid #0066cc; transition: background 0.1s; }
    .entity-item:hover { background: #f0f7ff; }
    .entity-item.active { background: #e6f2ff; border-color: #cce5ff; }
    .entity-item h4 { font-size: 13px; margin-bottom: 3px; word-break: break-all; }
    .entity-item p { font-size: 11px; color: #888; }
    
    /* Helpers */
    .empty-state { text-align: center; color: #888; padding: 40px 20px; font-size: 14px; }
    .alert { padding: 10px; border-radius: 4px; margin-bottom: 15px; font-size: 13px; }
    .alert.error { background: #ffebee; color: #c62828; border-left: 4px solid #c62828; }
    .alert.success { background: #e8f5e9; color: #2e7d32; border-left: 4px solid #2e7d32; }
    .alert.loading { background: #e3f2fd; color: #1565c0; border-left: 4px solid #1565c0; }
  </style>
</head>
<body>
  <div class="container">
    <div class="sidebar">
      <div class="sidebar-header">
        <h2 style="font-size: 18px; color: #333;">SN ERD Visualizer</h2>
        <div style="margin-top:10px; display:flex; gap:10px;">
          <a href="/comparison" style="font-size:11px; color:#0066cc; text-decoration:none;">&#8644; Compare</a>
          <a href="/live-compare" style="font-size:11px; color:#1a7a4a; text-decoration:none;">&#9889; Live Sync</a>
        </div>
      </div>
      
      <div class="controls">
        <div id="message"></div>
        <div class="form-group">
          <label>Instance Name</label>
          <input type="text" id="instance" placeholder="e.g., dev12345">
        </div>
        <div class="form-group">
          <label>Username</label>
          <input type="text" id="username" placeholder="admin">
        </div>
        <div class="form-group">
          <label>Password</label>
          <input type="password" id="password" placeholder="••••••••">
        </div>
        <button onclick="generateERD()">Connect & Fetch Schema</button>
      </div>

      <div class="table-search-container" id="search-container" style="display:none;">
        <input type="text" id="tableSearch" placeholder="Search tables (e.g., incident)..." onkeyup="filterTables()">
        <div style="font-size: 11px; color: #888; margin-top: 6px;" id="table-count-label"></div>
      </div>

      <div class="entity-list" id="entityList">
        <div class="empty-state">Connect to an instance to load tables.</div>
      </div>
    </div>

    <div class="main">
      <div id="network"></div>
      
      <div class="detail-panel" id="detailPanel">
        <div class="detail-header">
          <div>
            <div style="font-size: 12px; opacity: 0.8;">Selected Table</div>
            <h3 id="dp-table-name" style="margin: 0; font-size: 18px; word-break: break-all;">table_name</h3>
          </div>
          <div class="detail-close" onclick="closeDetailPanel()">✕</div>
        </div>
        <div class="detail-body" id="dp-body">
          <div class="empty-state" id="dp-loading">Loading table artifacts...</div>
          
          <div id="dp-content" style="display:none;">
            <div class="artifact-section">
              <h4>Fields & Columns</h4>
              <div style="font-size:13px; color:#666;" id="dp-fields-count">0 fields</div>
            </div>

            <div class="artifact-section">
              <h4>Business Rules</h4>
              <div id="dp-brs"><div class="artifact-item" style="color:#888;">(Backend integration required)</div></div>
            </div>

            <div class="artifact-section">
              <h4>Client Scripts & UI Policies</h4>
              <div id="dp-scripts"><div class="artifact-item" style="color:#888;">(Backend integration required)</div></div>
            </div>
            
            <div class="artifact-section">
              <h4>Flows / Workflows</h4>
              <div id="dp-flows"><div class="artifact-item" style="color:#888;">(Backend integration required)</div></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <script>
    let network = null;
    let currentERD = null;
    let tableDOMNodes = []; // For fast searching

    async function generateERD() {
      const instance = document.getElementById('instance').value;
      const username = document.getElementById('username').value;
      const password = document.getElementById('password').value;
      const messageDiv = document.getElementById('message');

      if (!instance || !username || !password) {
        messageDiv.innerHTML = '<div class="alert error">Please fill in all fields</div>';
        return;
      }

      messageDiv.innerHTML = '<div class="alert loading">Fetching entire schema. This may take a moment...</div>';

      try {
        const response = await fetch('/api/erd/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ instance, username, password })
        });

        if (!response.ok) {
          const error = await response.json();
          throw new Error(error.error);
        }

        const data = await response.json();
        currentERD = data.erd;
        messageDiv.innerHTML = \`<div class="alert success">\${data.message}</div>\`;
        
        document.getElementById('search-container').style.display = 'block';
        document.getElementById('table-count-label').innerText = \`\${Object.keys(currentERD.entities).length} tables loaded\`;
        
        populateEntityList(currentERD);
        
        // Initialize an empty network canvas
        const container = document.getElementById('network');
        network = new vis.Network(container, { nodes: [], edges: [] }, {});
        
      } catch (error) {
        messageDiv.innerHTML = \`<div class="alert error">Error: \${error.message}</div>\`;
      }
    }

    function getTableColor(tableName) {
      if (tableName.startsWith('u_') || tableName.startsWith('x_')) return { bg: '#1a7a4a', border: '#155f3a' };
      if (
        tableName.startsWith('sys_') || 
        tableName.startsWith('cmdb_') || 
        tableName.startsWith('sn_') || 
        ['incident', 'change_request', 'problem', 'request', 'sc_req_item', 'task'].includes(tableName)
      ) return { bg: '#7c3aed', border: '#6d28d9' };
      return { bg: '#0066cc', border: '#003d99' };
    }

    function populateEntityList(erd) {
      const list = document.getElementById('entityList');
      list.innerHTML = '';
      tableDOMNodes = [];

      // Sort alphabetically
      const sortedKeys = Object.keys(erd.entities).sort();

      sortedKeys.forEach(name => {
        const entity = erd.entities[name];
        const div = document.createElement('div');
        div.className = 'entity-item';
        
        const c = getTableColor(name);
        div.style.borderLeftColor = c.bg;
        
        div.innerHTML = \`
          <h4>\${name}</h4>
          <p>\${entity.label || 'No Label'} • \${entity.fields.length} cols</p>
        \`;
        
        div.onclick = () => selectAndRenderTable(name, div);
        
        list.appendChild(div);
        tableDOMNodes.push({ name: name, label: (entity.label || '').toLowerCase(), element: div });
      });
    }

    function filterTables() {
      const q = document.getElementById('tableSearch').value.toLowerCase();
      tableDOMNodes.forEach(item => {
        if (item.name.toLowerCase().includes(q) || item.label.includes(q)) {
          item.element.style.display = 'block';
        } else {
          item.element.style.display = 'none';
        }
      });
    }

    // Contextual Rendering: Only render the selected node and its direct neighbors
    function selectAndRenderTable(targetTableName, clickedElement) {
      // Handle UI highlighting
      document.querySelectorAll('.entity-item').forEach(el => el.classList.remove('active'));
      if (clickedElement) clickedElement.classList.add('active');

      openDetailPanel(targetTableName);

      const nodes = new vis.DataSet();
      const edges = new vis.DataSet();
      const addedNodes = new Set();

      // Helper to add a node if it doesn't exist yet
      function addNode(tableName, isCenter = false) {
        if (addedNodes.has(tableName)) return;
        const entity = currentERD.entities[tableName];
        if (!entity) return; // Table might not be in our dataset
        
        const c = getTableColor(tableName);
        nodes.add({
          id: tableName,
          label: tableName,
          title: entity.label || tableName,
          color: { background: c.bg, border: c.border },
          font: { color: 'white', size: isCenter ? 16 : 12 },
          shape: 'box',
          margin: 10,
          borderWidth: isCenter ? 3 : 1,
          shadow: true
        });
        addedNodes.add(tableName);
      }

      // Add the center node
      addNode(targetTableName, true);

      // Find all relationships involving this table
      currentERD.relationships.forEach(rel => {
        if (rel.from === targetTableName) {
          addNode(rel.to);
          edges.add({
            from: rel.from,
            to: rel.to,
            label: rel.field,
            arrows: 'to',
            color: { color: '#888', highlight: '#00aaff' },
            font: { size: 10, color: '#aaa', strokeWidth: 0 }
          });
        } else if (rel.to === targetTableName) {
          addNode(rel.from);
          edges.add({
            from: rel.from,
            to: rel.to,
            label: rel.field,
            arrows: 'to',
            color: { color: '#888', highlight: '#00aaff' },
            font: { size: 10, color: '#aaa', strokeWidth: 0 }
          });
        }
      });

      const container = document.getElementById('network');
      const options = {
        physics: {
          enabled: true,
          barnesHut: { gravitationalConstant: -2000, centralGravity: 0.3, springLength: 150 }
        },
        interaction: { hover: true, tooltipDelay: 200 }
      };

      if (network) { network.destroy(); }
      network = new vis.Network(container, { nodes, edges }, options);
    }

    function openDetailPanel(tableName) {
      const panel = document.getElementById('detailPanel');
      document.getElementById('dp-table-name').innerText = tableName;
      
      const entity = currentERD.entities[tableName];
      document.getElementById('dp-fields-count').innerText = \`\${entity ? entity.fields.length : 0} defined dictionary fields\`;
      
      document.getElementById('dp-loading').style.display = 'none';
      document.getElementById('dp-content').style.display = 'block';
      panel.classList.add('open');
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
app.listen(PORT, () => {
  console.log(`ServiceNow ERD Visualizer running on port ${PORT}`);
});
