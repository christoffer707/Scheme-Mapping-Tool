import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import comparisonRouter from './routes/comparison.js';
import liveComparisonRouter from './routes/liveComparison.js';

// Import the optimized, uncapped schema fetcher we built
import { fetchServiceNowSchema } from './utils/servicenowAPI.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

// Serve static files from /public
app.use(express.static(join(__dirname, 'public')));

// Mount comparison / analysis routes
app.use('/api', comparisonRouter);

// Mount live dual-instance comparison routes
app.use('/api/live', liveComparisonRouter);

// ServiceNow schema cache
let schemaCache = null;

// API endpoint to generate ERD
app.post('/api/erd/generate', async (req, res) => {
  try {
    const { instance, username, password } = req.body;

    if (!instance || !username || !password) {
      return res.status(400).json({ error: 'Missing required fields: instance, username, password' });
    }

    // Use the robust utility function to fetch everything without limits
    const schema = await fetchServiceNowSchema(instance, username, password, { includeCore: true });

    // Map the robust schema output to the specific ERD format expected by this frontend
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

// API endpoint to get cached ERD
app.get('/api/erd', (req, res) => {
  if (!schemaCache) {
    return res.status(404).json({ error: 'No ERD generated yet. POST to /api/erd/generate first.' });
  }
  res.json(schemaCache);
});

// Serve frontend
app.get('/', (req, res) => {
  res.send(getHTMLPage());
});

// Serve comparison tool page
app.get('/comparison', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'comparison.html'));
});

// Serve live dual-instance comparison page
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
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f5f5; }
    .container { display: flex; height: 100vh; }
    .sidebar { width: 350px; background: white; border-right: 1px solid #ddd; overflow-y: auto; padding: 20px; z-index: 10; }
    .main { flex: 1; display: flex; flex-direction: column; }
    .controls { background: white; padding: 20px; border-bottom: 1px solid #ddd; }
    /* Switched background to a sleek dark tone for better contrast */
    #network { flex: 1; background: #1a1a2e; } 
    .form-group { margin-bottom: 15px; }
    label { display: block; font-weight: 600; margin-bottom: 5px; font-size: 14px; }
    input { width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px; font-size: 14px; }
    button { background: #0066cc; color: white; padding: 10px 20px; border: none; border-radius: 4px; cursor: pointer; font-weight: 600; width: 100%; }
    button:hover { background: #0052a3; }
    .entity-list { margin-top: 20px; }
    .entity-item { padding: 10px; background: #f9f9f9; border-radius: 4px; margin-bottom: 8px; cursor: pointer; border-left: 3px solid #0066cc; }
    .entity-item:hover { background: #f0f0f0; }
    .entity-item h4 { font-size: 13px; margin-bottom: 3px; }
    .entity-item p { font-size: 12px; color: #666; }
    #message { margin-bottom: 15px; }
    .loading { text-align: center; padding: 10px; color: #666; background: #e2e3e5; border-radius: 4px; }
    .error { color: #d32f2f; padding: 10px; background: #ffebee; border-radius: 4px; }
    .success { color: #388e3c; padding: 10px; background: #e8f5e9; border-radius: 4px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="sidebar">
      <h2>ServiceNow ERD Visualizer</h2>
      <div style="margin-bottom:6px;margin-top:12px;padding:8px;background:#f0f7ff;border-radius:4px;"><a href="/comparison" style="color:#0066cc;font-size:13px;font-weight:600;text-decoration:none;">&#8644; Compare &amp; Analyze Instances &rarr;</a></div>
      <div style="margin-bottom:12px;padding:8px;background:#f0fff4;border-radius:4px;"><a href="/live-compare" style="color:#1a7a4a;font-size:13px;font-weight:600;text-decoration:none;">&#9889; Live Dual-Instance Compare &rarr;</a></div>
      <div class="controls">
        <div id="message"></div>
        <div class="form-group">
          <label>Instance Name</label>
          <input type="text" id="instance" placeholder="e.g., dev12345">
        </div>
        <div class="form-group">
          <label>Username</label>
          <input type="text" id="username" placeholder="ServiceNow username">
        </div>
        <div class="form-group">
          <label>Password</label>
          <input type="password" id="password" placeholder="ServiceNow password">
        </div>
        <button onclick="generateERD()">Generate Full ERD</button>
      </div>
      <div class="entity-list" id="entityList"></div>
    </div>
    <div class="main">
      <div id="network"></div>
    </div>
  </div>

  <script>
    let network = null;
    let currentERD = null;

    async function generateERD() {
      const instance = document.getElementById('instance').value;
      const username = document.getElementById('username').value;
      const password = document.getElementById('password').value;
      const messageDiv = document.getElementById('message');

      if (!instance || !username || !password) {
        messageDiv.innerHTML = '<div class="error">Please fill in all fields</div>';
        return;
      }

      messageDiv.innerHTML = '<div class="loading">Fetching entire schema...</div>';

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
        messageDiv.innerHTML = \`<div class="success">\${data.message}</div>\`;
        visualizeERD(data.erd);
        populateEntityList(data.erd);
      } catch (error) {
        messageDiv.innerHTML = \`<div class="error">Error: \${error.message}</div>\`;
      }
    }

    // Helper to determine color based on table prefix
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

    function visualizeERD(erd) {
      const nodes = [];
      const edges = [];

      // Create nodes for each entity with color coding
      Object.entries(erd.entities).forEach(([name, entity], index) => {
        const c = getTableColor(name);
        nodes.push({
          id: name,
          label: entity.label || name,
          title: \`Table: \${name}\\nFields: \${entity.fields.length}\`,
          color: { background: c.bg, border: c.border, highlight: { background: c.bg, border: c.border } },
          font: { color: 'white', size: 13 },
          shape: 'box',
          margin: 8
        });
      });

      // Create edges for relationships
      erd.relationships.forEach(rel => {
        edges.push({
          from: rel.from,
          to: rel.to,
          label: rel.field,
          arrows: 'to',
          color: { color: '#666666', highlight: '#0066cc' },
          font: { size: 9, color: '#aaaaaa', strokeWidth: 0 }
        });
      });

      const container = document.getElementById('network');
      const data = { nodes: new vis.DataSet(nodes), edges: new vis.DataSet(edges) };
      
      // Determine if extreme scale mode is needed
      const isLarge = nodes.length > 200;

      const options = {
        physics: isLarge 
          ? { enabled: false } 
          : { enabled: true, stabilization: { iterations: 200 } },
        layout: isLarge 
          ? { improvedLayout: false, randomSeed: 42 } 
          : {},
        interaction: { 
          navigationButtons: true, 
          keyboard: false, 
          hideEdgesOnDrag: isLarge, 
          hideEdgesOnZoom: isLarge 
        },
        edges: { smooth: !isLarge },
        nodes: { shadow: !isLarge }
      };

      network = new vis.Network(container, data, options);
    }

    function populateEntityList(erd) {
      const list = document.getElementById('entityList');
      list.innerHTML = '<h3>Tables (' + Object.keys(erd.entities).length + ')</h3>';

      Object.entries(erd.entities).forEach(([name, entity]) => {
        const div = document.createElement('div');
        div.className = 'entity-item';
        // Add left border color matching the node color
        const c = getTableColor(name);
        div.style.borderLeftColor = c.bg;
        
        div.innerHTML = \`
          <h4>\${entity.label || name}</h4>
          <p>\${name}</p>
          <p>\${entity.fields.length} fields</p>
        \`;
        div.onclick = () => network && network.focus(name, { scale: 1.5, animation: true });
        list.appendChild(div);
      });
    }
  </script>
</body>
</html>`;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`ServiceNow ERD Visualizer running on port ${PORT}`);
});
