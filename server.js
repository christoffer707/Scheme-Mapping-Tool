import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import comparisonRouter from './routes/comparison.js';
import liveComparisonRouter from './routes/liveComparison.js';

// Import our new artifact fetcher alongside the schema fetcher
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

// 1. Generate the Base ERD
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

// 2. Fetch specific table artifacts (Drill-down)
app.post('/api/erd/table-details', async (req, res) => {
  try {
    const { table } = req.body;
    if (!table || !currentCredentials) return res.status(400).json({ error: 'Missing table or session expired.' });

    const artifacts = await fetchServiceNowTableArtifacts(
      currentCredentials.instance, 
      currentCredentials.username, 
      currentCredentials.password, 
      table
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
    .controls { padding: 20px; border-bottom: 1px solid #ddd; background: #f9f9
