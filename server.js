import express from 'express';
import cors from 'cors';
import SchemeMapper from './schemeMapper.js';

const app = express();
app.use(cors());
app.use(express.json());

// Scheme map cache
let schemeMapCache = null;
let mapperInstance = null;

// API endpoint to generate scheme map
app.post('/api/scheme/generate', async (req, res) => {
  try {
    const { instance, username, password, tableLimit = 100 } = req.body;
    
    if (!instance || !username || !password) {
      return res.status(400).json({ error: 'Missing required fields: instance, username, password' });
    }

    const mapper = new SchemeMapper(instance, username, password);
    mapperInstance = mapper;

    const schemeMap = await mapper.generateSchemeMap(tableLimit);
    schemeMapCache = schemeMap;

    res.json({
      success: true,
      message: `Generated scheme map for ${schemeMap.summary.totalTables} tables`,
      summary: schemeMap.summary,
      schemeMap
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API endpoint to get cached scheme map
app.get('/api/scheme', (req, res) => {
  if (!schemeMapCache) {
    return res.status(404).json({ error: 'No scheme map generated yet. POST to /api/scheme/generate first.' });
  }
  res.json(schemeMapCache);
});

// API endpoint to get table details
app.get('/api/scheme/table/:tableName', (req, res) => {
  if (!schemeMapCache) {
    return res.status(404).json({ error: 'No scheme map generated yet.' });
  }

  const { tableName } = req.params;
  const table = schemeMapCache.tables[tableName];
  const fields = schemeMapCache.fields[tableName];

  if (!table) {
    return res.status(404).json({ error: `Table ${tableName} not found` });
  }

  res.json({
    table,
    fields,
    dependencies: mapperInstance ? mapperInstance.getTableDependencies(tableName) : null
  });
});

// API endpoint to get relationships
app.get('/api/scheme/relationships', (req, res) => {
  if (!schemeMapCache) {
    return res.status(404).json({ error: 'No scheme map generated yet.' });
  }

  const { table } = req.query;
  let relationships = schemeMapCache.relationships;

  if (table) {
    relationships = relationships.filter(rel => rel.from === table || rel.to === table);
  }

  res.json({ relationships });
});

// API endpoint to get circular dependencies
app.get('/api/scheme/cycles', (req, res) => {
  if (!mapperInstance) {
    return res.status(404).json({ error: 'No scheme map generated yet.' });
  }

  const cycles = mapperInstance.findCircularDependencies();
  res.json({ cycles, count: cycles.length });
});

// API endpoint to export as GraphQL schema
app.get('/api/scheme/export/graphql', (req, res) => {
  if (!mapperInstance) {
    return res.status(404).json({ error: 'No scheme map generated yet.' });
  }

  const graphqlSchema = mapperInstance.exportGraphQL();
  res.setHeader('Content-Type', 'text/plain');
  res.send(graphqlSchema);
});

// API endpoint to export as JSON
app.get('/api/scheme/export/json', (req, res) => {
  if (!schemeMapCache) {
    return res.status(404).json({ error: 'No scheme map generated yet.' });
  }

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename="scheme-map.json"');
  res.send(JSON.stringify(schemeMapCache, null, 2));
});

// Serve frontend
app.get('/', (req, res) => {
  res.send(getHTMLPage());
});

function getHTMLPage() {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ServiceNow Scheme Mapper</title>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/vis/4.21.0/vis.min.js"></script>
  <link href="https://cdnjs.cloudflare.com/ajax/libs/vis/4.21.0/vis.min.css" rel="stylesheet" type="text/css" />
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f5f5; }
    .container { display: flex; height: 100vh; }
    .sidebar { width: 380px; background: white; border-right: 1px solid #ddd; overflow-y: auto; padding: 20px; }
    .main { flex: 1; display: flex; flex-direction: column; }
    .controls { background: white; padding: 20px; border-bottom: 1px solid #ddd; }
    #network { flex: 1; background: white; }
    .form-group { margin-bottom: 15px; }
    label { display: block; font-weight: 600; margin-bottom: 5px; font-size: 14px; }
    input, select { width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px; font-size: 14px; }
    button { background: #0066cc; color: white; padding: 10px 20px; border: none; border-radius: 4px; cursor: pointer; font-weight: 600; width: 100%; margin-top: 5px; }
    button:hover { background: #0052a3; }
    button.secondary { background: #666; }
    button.secondary:hover { background: #555; }
    .stats { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin: 15px 0; }
    .stat-box { background: #f9f9f9; padding: 10px; border-radius: 4px; text-align: center; }
    .stat-box h4 { font-size: 12px; color: #666; margin-bottom: 5px; }
    .stat-box .value { font-size: 20px; font-weight: bold; color: #0066cc; }
    .table-list { margin-top: 20px; }
    .table-item { padding: 10px; background: #f9f9f9; border-radius: 4px; margin-bottom: 8px; cursor: pointer; border-left: 3px solid #0066cc; }
    .table-item:hover { background: #f0f0f0; }
    .table-item h4 { font-size: 13px; margin-bottom: 3px; }
    .table-item p { font-size: 12px; color: #666; }
    .loading { text-align: center; padding: 20px; color: #666; }
    .error { color: #d32f2f; padding: 10px; background: #ffebee; border-radius: 4px; margin-bottom: 10px; }
    .success { color: #388e3c; padding: 10px; background: #e8f5e9; border-radius: 4px; margin-bottom: 10px; }
    .export-buttons { display: flex; gap: 10px; margin-top: 10px; }
    .export-buttons button { flex: 1; margin: 0; }
    h2 { font-size: 18px; margin-bottom: 15px; }
    h3 { font-size: 14px; margin-top: 15px; margin-bottom: 10px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="sidebar">
      <h2>ServiceNow Scheme Mapper</h2>
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
        <div class="form-group">
          <label>Table Limit</label>
          <input type="number" id="tableLimit" value="100" min="1" max="1000">
        </div>
        <button onclick="generateScheme()">Generate Scheme Map</button>

        <div id="stats" class="stats" style="display:none;">
          <div class="stat-box">
            <h4>Tables</h4>
            <div class="value" id="statTables">0</div>
          </div>
          <div class="stat-box">
            <h4>Fields</h4>
            <div class="value" id="statFields">0</div>
          </div>
          <div class="stat-box">
            <h4>Relationships</h4>
            <div class="value" id="statRelationships">0</div>
          </div>
          <div class="stat-box">
            <h4>Hierarchies</h4>
            <div class="value" id="statHierarchies">0</div>
          </div>
        </div>

        <div class="export-buttons" id="exportButtons" style="display:none;">
          <button class="secondary" onclick="exportJSON()">Export JSON</button>
          <button class="secondary" onclick="exportGraphQL()">Export GraphQL</button>
        </div>
      </div>

      <h3>Tables</h3>
      <div class="table-list" id="tableList"></div>
    </div>
    <div class="main">
      <div id="network"></div>
    </div>
  </div>

  <script>
    let network = null;
    let currentScheme = null;

    async function generateScheme() {
      const instance = document.getElementById('instance').value;
      const username = document.getElementById('username').value;
      const password = document.getElementById('password').value;
      const tableLimit = parseInt(document.getElementById('tableLimit').value);
      const messageDiv = document.getElementById('message');

      if (!instance || !username || !password) {
        messageDiv.innerHTML = '<div class="error">Please fill in all fields</div>';
        return;
      }

      messageDiv.innerHTML = '<div class="loading">Generating scheme map...</div>';

      try {
        const response = await fetch('/api/scheme/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ instance, username, password, tableLimit })
        });

        if (!response.ok) {
          const error = await response.json();
          throw new Error(error.error);
        }

        const data = await response.json();
        currentScheme = data.schemeMap;
        
        messageDiv.innerHTML = \`<div class="success">\${data.message}</div>\`;
        
        // Update stats
        document.getElementById('statTables').textContent = data.summary.totalTables;
        document.getElementById('statFields').textContent = data.summary.totalFields;
        document.getElementById('statRelationships').textContent = data.summary.totalRelationships;
        document.getElementById('statHierarchies').textContent = data.summary.inheritanceHierarchies;
        document.getElementById('stats').style.display = 'grid';
        document.getElementById('exportButtons').style.display = 'flex';
        
        visualizeScheme(data.schemeMap);
        populateTableList(data.schemeMap);
      } catch (error) {
        messageDiv.innerHTML = \`<div class="error">Error: \${error.message}</div>\`;
      }
    }

    function visualizeScheme(scheme) {
      const nodes = [];
      const edges = [];

      // Create nodes for each table
      Object.entries(scheme.tables).forEach(([name, table]) => {
        const fieldCount = (scheme.fields[name] || []).length;
        nodes.push({
          id: name,
          label: table.label || name,
          title: \`Table: \${name}\\nFields: \${fieldCount}\\nExtendable: \${table.isExtendable}\`,
          color: { background: '#0066cc', border: '#003d99', highlight: { background: '#0052a3' } },
          font: { color: 'white', size: 12 }
        });
      });

      // Create edges for relationships
      scheme.relationships.forEach(rel => {
        edges.push({
          from: rel.from,
          to: rel.to,
          label: rel.field,
          arrows: 'to',
          color: { color: rel.mandatory ? '#d32f2f' : '#999', highlight: '#0066cc' },
          font: { size: 10 },
          width: rel.mandatory ? 2 : 1
        });
      });

      const container = document.getElementById('network');
      const data = { nodes: new vis.DataSet(nodes), edges: new vis.DataSet(edges) };
      const options = {
        physics: { enabled: true, stabilization: { iterations: 200 } },
        interaction: { navigationButtons: true, keyboard: true }
      };

      network = new vis.Network(container, data, options);
    }

    function populateTableList(scheme) {
      const list = document.getElementById('tableList');
      list.innerHTML = '';
      
      Object.entries(scheme.tables).forEach(([name, table]) => {
        const fieldCount = (scheme.fields[name] || []).length;
        const div = document.createElement('div');
        div.className = 'table-item';
        div.innerHTML = \`
          <h4>\${table.label || name}</h4>
          <p>\${name}</p>
          <p>\${fieldCount} fields</p>
        \`;
        div.onclick = () => network && network.focus(name, { scale: 1.5, animation: true });
        list.appendChild(div);
      });
    }

    function exportJSON() {
      if (!currentScheme) return;
      const dataStr = JSON.stringify(currentScheme, null, 2);
      const dataBlob = new Blob([dataStr], { type: 'application/json' });
      const url = URL.createObjectURL(dataBlob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'scheme-map.json';
      link.click();
    }

    function exportGraphQL() {
      if (!currentScheme) return;
      fetch('/api/scheme/export/graphql')
        .then(r => r.text())
        .then(text => {
          const dataBlob = new Blob([text], { type: 'text/plain' });
          const url = URL.createObjectURL(dataBlob);
          const link = document.createElement('a');
          link.href = url;
          link.download = 'schema.graphql';
          link.click();
        });
    }
  </script>
</body>
</html>
  `;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(\`ServiceNow Scheme Mapper running on port \${PORT}\`);
});

