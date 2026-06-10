import express from 'express';
import cors from 'cors';
import axios from 'axios';

const app = express();
app.use(cors());
app.use(express.json());

// ServiceNow schema cache
let schemaCache = null;

// Fetch all tables from ServiceNow instance
async function fetchServiceNowSchema(instance, username, password) {
  const auth = Buffer.from(`${username}:${password}`).toString('base64');
  const baseUrl = `https://${instance}.service-now.com/api/now/table/sys_db_object`;

  try {
    const response = await axios.get(baseUrl, {
      headers: {
        'Authorization': `Basic ${auth}`,
        'Accept': 'application/json'
      },
      params: {
        sysparm_limit: 1000,
        sysparm_fields: 'name,label,sys_id'
      }
    });

    return response.data.result || [];
  } catch (error) {
    throw new Error(`Failed to fetch ServiceNow schema: ${error.message}`);
  }
}

// Fetch fields for a specific table
async function fetchTableFields(instance, username, password, tableName) {
  const auth = Buffer.from(`${username}:${password}`).toString('base64');
  const baseUrl = `https://${instance}.service-now.com/api/now/table/sys_dictionary`;

  try {
    const response = await axios.get(baseUrl, {
      headers: {
        'Authorization': `Basic ${auth}`,
        'Accept': 'application/json'
      },
      params: {
        sysparm_query: `name=${tableName}`,
        sysparm_limit: 500,
        sysparm_fields: 'element,label,internal_type,reference,mandatory'
      }
    });

    return response.data.result || [];
  } catch (error) {
    throw new Error(`Failed to fetch fields for ${tableName}: ${error.message}`);
  }
}

// Generate ERD JSON from schema
function generateERD(tables, fields) {
  const entities = {};
  const relationships = [];

  tables.forEach(table => {
    const tableFields = fields[table.name] || [];
    entities[table.name] = {
      id: table.sys_id,
      name: table.name,
      label: table.label,
      fields: tableFields.map(field => ({
        name: field.element,
        label: field.label,
        type: field.internal_type,
        reference: field.reference,
        mandatory: field.mandatory === '1'
      }))
    };

    // Track relationships
    tableFields.forEach(field => {
      if (field.reference && field.reference !== table.name) {
        relationships.push({
          from: table.name,
          to: field.reference,
          field: field.element,
          type: 'foreign_key'
        });
      }
    });
  });

  return { entities, relationships };
}

// API endpoint to generate ERD
app.post('/api/erd/generate', async (req, res) => {
  try {
    const { instance, username, password } = req.body;

    if (!instance || !username || !password) {
      return res.status(400).json({ error: 'Missing required fields: instance, username, password' });
    }

    // Fetch all tables
    const tables = await fetchServiceNowSchema(instance, username, password);

    // Fetch fields for each table
    const fieldsMap = {};
    for (const table of tables.slice(0, 50)) { // Limit to first 50 for demo
      fieldsMap[table.name] = await fetchTableFields(instance, username, password, table.name);
    }

    // Generate ERD
    const erd = generateERD(tables.slice(0, 50), fieldsMap);
    schemaCache = erd;

    res.json({
      success: true,
      message: `Generated ERD for ${tables.length} tables`,
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
    .sidebar { width: 350px; background: white; border-right: 1px solid #ddd; overflow-y: auto; padding: 20px; }
    .main { flex: 1; display: flex; flex-direction: column; }
    .controls { background: white; padding: 20px; border-bottom: 1px solid #ddd; }
    #network { flex: 1; background: white; }
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
    .loading { text-align: center; padding: 20px; color: #666; }
    .error { color: #d32f2f; padding: 10px; background: #ffebee; border-radius: 4px; margin-bottom: 10px; }
    .success { color: #388e3c; padding: 10px; background: #e8f5e9; border-radius: 4px; margin-bottom: 10px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="sidebar">
      <h2>ServiceNow ERD Visualizer</h2>
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
        <button onclick="generateERD()">Generate ERD</button>
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

      messageDiv.innerHTML = '<div class="loading">Generating ERD...</div>';

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
        messageDiv.innerHTML = `<div class="success">\${data.message}</div>`;
        visualizeERD(data.erd);
        populateEntityList(data.erd);
      } catch (error) {
        messageDiv.innerHTML = `<div class="error">Error: \${error.message}</div>`;
      }
    }

    function visualizeERD(erd) {
      const nodes = [];
      const edges = [];

      // Create nodes for each entity
      Object.entries(erd.entities).forEach(([name, entity], index) => {
        nodes.push({
          id: name,
          label: entity.label || name,
          title: `Table: \${name}\nFields: \${entity.fields.length}`,
          color: { background: '#0066cc', border: '#003d99', highlight: { background: '#0052a3' } },
          font: { color: 'white', size: 14 }
        });
      });

      // Create edges for relationships
      erd.relationships.forEach(rel => {
        edges.push({
          from: rel.from,
          to: rel.to,
          label: rel.field,
          arrows: 'to',
          color: { color: '#999', highlight: '#0066cc' },
          font: { size: 12 }
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

    function populateEntityList(erd) {
      const list = document.getElementById('entityList');
      list.innerHTML = '<h3>Tables (' + Object.keys(erd.entities).length + ')</h3>';

      Object.entries(erd.entities).forEach(([name, entity]) => {
        const div = document.createElement('div');
        div.className = 'entity-item';
        div.innerHTML = `
          <h4>\${entity.label || name}</h4>
          <p>\${name}</p>
          <p>\${entity.fields.length} fields</p>
        `;
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
