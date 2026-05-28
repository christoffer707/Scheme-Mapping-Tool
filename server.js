import express from 'express';
import cors from 'cors';
import AdvancedSchemeMapper from './advancedSchemeMapper.js';

const app = express();
app.use(cors());
app.use(express.json());

// Timeout middleware for the scheme generation endpoint (120 seconds)
app.use('/api/scheme/generate', (req, res, next) => {
  res.setTimeout(120000, () => {
    res.status(503).json({
      error: 'Request timed out after 120 seconds. Try reducing the table limit or check that your ServiceNow instance is reachable.'
    });
  });
  next();
});

// Scheme map cache
let schemeMapCache = null;
let analysisCache = null;
let mapperInstance = null;

// API endpoint to generate scheme map with analysis
app.post('/api/scheme/generate', async (req, res) => {
  try {
    let { instance, username, password, tableLimit = 50 } = req.body;

    if (!instance || !username || !password) {
      return res.status(400).json({ error: 'Missing required fields: instance, username, password' });
    }

    // Sanitize: trim whitespace and strip any accidental protocol prefix
    instance = instance.trim().replace(/^https?:\/\//i, '');

    // Strip trailing slashes and any path/domain suffix (e.g. ".service-now.com")
    instance = instance.replace(/\.service-now\.com.*/i, '').replace(/\/.*$/, '').trim();

    // Validate: instance name must be non-empty alphanumeric (hyphens allowed)
    if (!instance || !/^[a-zA-Z0-9-]+$/.test(instance)) {
      return res.status(400).json({
        error: 'Invalid instance name. Please provide only the instance identifier (e.g., "dev12345"), not a full URL.'
      });
    }

    tableLimit = Math.max(1, Math.min(parseInt(tableLimit) || 50, 500));

    console.log(`[generate] Starting scheme map for instance="${instance}", tableLimit=${tableLimit}`);

    const mapper = new AdvancedSchemeMapper(instance, username, password);
    mapperInstance = mapper;

    const report = await mapper.generateAnalysisReport(tableLimit);

    if (!report || !report.schemeMap) {
      throw new Error('Scheme map generation returned an empty result. Check your credentials and instance name.');
    }

    schemeMapCache = report.schemeMap;
    analysisCache = report.analysis;

    const totalTables = report.schemeMap.summary ? report.schemeMap.summary.totalTables : 0;
    console.log(`[generate] Success: ${totalTables} tables mapped`);

    res.json({
      success: true,
      message: 'Generated scheme map for ' + totalTables + ' tables',
      summary: report.schemeMap.summary,
      analysis: report.analysis,
      insights: report.insights,
      schemeMap: report.schemeMap
    });
  } catch (error) {
    console.error('[generate] Error:', error.message);
    if (error.message.includes('timed out') || error.code === 'ECONNABORTED') {
      return res.status(503).json({
        error: 'ServiceNow request timed out: ' + error.message + '. Try reducing the table limit or check your instance connectivity.'
      });
    }
    if (error.message.includes('401') || error.message.includes('Unauthorized')) {
      return res.status(401).json({
        error: 'Authentication failed. Please check your username and password.'
      });
    }
    if (error.message.includes('ENOTFOUND') || error.message.includes('ECONNREFUSED')) {
      return res.status(502).json({
        error: 'Cannot reach ServiceNow instance "' + (req.body.instance || '') + '". Verify the instance name is correct and the instance is online.'
      });
    }
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

// API endpoint to get analysis
app.get('/api/scheme/analysis', (req, res) => {
  if (!analysisCache) {
    return res.status(404).json({ error: 'No analysis available yet.' });
  }
  res.json(analysisCache);
});

// API endpoint to get insights
app.get('/api/scheme/insights', (req, res) => {
  if (!mapperInstance) {
    return res.status(404).json({ error: 'No scheme map generated yet.' });
  }
  res.json({ insights: mapperInstance.generateInsights() });
});

// API endpoint to get table details
app.get('/api/scheme/table/:tableName', (req, res) => {
  if (!schemeMapCache) {
    return res.status(404).json({ error: 'No scheme map generated yet.' });
  }

  const { tableName } = req.params;
  const table = schemeMapCache.tables[tableName];
  const fields = schemeMapCache.fields[tableName];
  const metrics = analysisCache && analysisCache.tableMetrics ? analysisCache.tableMetrics[tableName] : null;

  if (!table) {
    return res.status(404).json({ error: 'Table ' + tableName + ' not found' });
  }

  res.json({
    table,
    fields,
    metrics,
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

// API endpoint to export analysis report as HTML
app.get('/api/scheme/export/report', (req, res) => {
  if (!mapperInstance) {
    return res.status(404).json({ error: 'No scheme map generated yet.' });
  }

  const html = mapperInstance.generateHTMLReport();
  res.setHeader('Content-Type', 'text/html');
  res.setHeader('Content-Disposition', 'attachment; filename="schema-analysis-report.html"');
  res.send(html);
});

// Serve frontend
app.get('/', (req, res) => {
  res.send(getHTMLPage());
});

function getHTMLPage() {
  const html = [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '  <meta charset="UTF-8">',
    '  <meta name="viewport" content="width=device-width, initial-scale=1.0">',
    '  <title>ServiceNow ERD Visualizer</title>',
    '  <script src="https://cdnjs.cloudflare.com/ajax/libs/vis/4.21.0/vis.min.js"><\/script>',
    '  <link href="https://cdnjs.cloudflare.com/ajax/libs/vis/4.21.0/vis.min.css" rel="stylesheet" type="text/css" />',
    '  <style>',
    '    *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }',
    '    :root {',
    '      --bg-primary: #0f1117;',
    '      --bg-secondary: #1a1d27;',
    '      --bg-card: #1e2130;',
    '      --bg-hover: #252840;',
    '      --border: #2e3250;',
    '      --accent: #6366f1;',
    '      --accent-hover: #4f52d4;',
    '      --accent-light: rgba(99,102,241,0.15);',
    '      --success: #10b981;',
    '      --success-light: rgba(16,185,129,0.12);',
    '      --warning: #f59e0b;',
    '      --warning-light: rgba(245,158,11,0.12);',
    '      --danger: #ef4444;',
    '      --danger-light: rgba(239,68,68,0.12);',
    '      --info: #3b82f6;',
    '      --info-light: rgba(59,130,246,0.12);',
    '      --text-primary: #e2e8f0;',
    '      --text-secondary: #94a3b8;',
    '      --text-muted: #64748b;',
    '      --radius: 10px;',
    '      --radius-sm: 6px;',
    '      --shadow: 0 4px 24px rgba(0,0,0,0.4);',
    '    }',
    '    html, body { height: 100%; overflow: hidden; }',
    '    body {',
    '      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Inter", sans-serif;',
    '      background: var(--bg-primary);',
    '      color: var(--text-primary);',
    '      font-size: 14px;',
    '      line-height: 1.5;',
    '    }',
    '    .app { display: flex; height: 100vh; overflow: hidden; }',

    /* ── Sidebar ── */
    '    .sidebar {',
    '      width: 360px;',
    '      min-width: 360px;',
    '      background: var(--bg-secondary);',
    '      border-right: 1px solid var(--border);',
    '      display: flex;',
    '      flex-direction: column;',
    '      overflow: hidden;',
    '    }',
    '    .sidebar-header {',
    '      padding: 20px 20px 16px;',
    '      border-bottom: 1px solid var(--border);',
    '      flex-shrink: 0;',
    '    }',
    '    .sidebar-header .logo {',
    '      display: flex;',
    '      align-items: center;',
    '      gap: 10px;',
    '      margin-bottom: 4px;',
    '    }',
    '    .sidebar-header .logo-icon {',
    '      width: 32px; height: 32px;',
    '      background: var(--accent);',
    '      border-radius: 8px;',
    '      display: flex; align-items: center; justify-content: center;',
    '      font-size: 16px;',
    '    }',
    '    .sidebar-header h1 {',
    '      font-size: 16px;',
    '      font-weight: 700;',
    '      color: var(--text-primary);',
    '      letter-spacing: -0.3px;',
    '    }',
    '    .sidebar-header p {',
    '      font-size: 12px;',
    '      color: var(--text-muted);',
    '      margin-left: 42px;',
    '    }',
    '    .sidebar-body {',
    '      flex: 1;',
    '      overflow-y: auto;',
    '      padding: 16px 20px;',
    '    }',
    '    .sidebar-body::-webkit-scrollbar { width: 4px; }',
    '    .sidebar-body::-webkit-scrollbar-track { background: transparent; }',
    '    .sidebar-body::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }',

    /* ── Form ── */
    '    .form-section { margin-bottom: 20px; }',
    '    .form-section-title {',
    '      font-size: 11px;',
    '      font-weight: 600;',
    '      text-transform: uppercase;',
    '      letter-spacing: 0.8px;',
    '      color: var(--text-muted);',
    '      margin-bottom: 10px;',
    '    }',
    '    .form-group { margin-bottom: 10px; }',
    '    .form-group label {',
    '      display: block;',
    '      font-size: 12px;',
    '      font-weight: 500;',
    '      color: var(--text-secondary);',
    '      margin-bottom: 5px;',
    '    }',
    '    .form-group input {',
    '      width: 100%;',
    '      padding: 9px 12px;',
    '      background: var(--bg-card);',
    '      border: 1px solid var(--border);',
    '      border-radius: var(--radius-sm);',
    '      color: var(--text-primary);',
    '      font-size: 13px;',
    '      transition: border-color 0.15s, box-shadow 0.15s;',
    '      outline: none;',
    '    }',
    '    .form-group input::placeholder { color: var(--text-muted); }',
    '    .form-group input:focus {',
    '      border-color: var(--accent);',
    '      box-shadow: 0 0 0 3px var(--accent-light);',
    '    }',
    '    .form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }',

    /* ── Buttons ── */
    '    .btn {',
    '      display: inline-flex;',
    '      align-items: center;',
    '      justify-content: center;',
    '      gap: 7px;',
    '      padding: 10px 16px;',
    '      border: none;',
    '      border-radius: var(--radius-sm);',
    '      font-size: 13px;',
    '      font-weight: 600;',
    '      cursor: pointer;',
    '      transition: background 0.15s, transform 0.1s, opacity 0.15s;',
    '      width: 100%;',
    '    }',
    '    .btn:active { transform: scale(0.98); }',
    '    .btn-primary {',
    '      background: var(--accent);',
    '      color: #fff;',
    '    }',
    '    .btn-primary:hover:not(:disabled) { background: var(--accent-hover); }',
    '    .btn-primary:disabled {',
    '      opacity: 0.55;',
    '      cursor: not-allowed;',
    '    }',
    '    .btn-ghost {',
    '      background: var(--bg-card);',
    '      color: var(--text-secondary);',
    '      border: 1px solid var(--border);',
    '      font-size: 12px;',
    '      padding: 7px 10px;',
    '    }',
    '    .btn-ghost:hover { background: var(--bg-hover); color: var(--text-primary); }',
    '    .export-row {',
    '      display: grid;',
    '      grid-template-columns: 1fr 1fr 1fr;',
    '      gap: 8px;',
    '      margin-top: 12px;',
    '    }',

    /* ── Spinner ── */
    '    @keyframes spin { to { transform: rotate(360deg); } }',
    '    .spinner {',
    '      width: 14px; height: 14px;',
    '      border: 2px solid rgba(255,255,255,0.3);',
    '      border-top-color: #fff;',
    '      border-radius: 50%;',
    '      animation: spin 0.7s linear infinite;',
    '      flex-shrink: 0;',
    '    }',

    /* ── Status banner ── */
    '    .status-banner {',
    '      padding: 10px 12px;',
    '      border-radius: var(--radius-sm);',
    '      font-size: 12px;',
    '      line-height: 1.5;',
    '      margin-bottom: 14px;',
    '      display: none;',
    '    }',
    '    .status-banner.show { display: flex; align-items: flex-start; gap: 8px; }',
    '    .status-banner.loading { background: var(--info-light); color: #93c5fd; border: 1px solid rgba(59,130,246,0.25); }',
    '    .status-banner.success { background: var(--success-light); color: #6ee7b7; border: 1px solid rgba(16,185,129,0.25); }',
    '    .status-banner.error { background: var(--danger-light); color: #fca5a5; border: 1px solid rgba(239,68,68,0.25); }',
    '    .status-banner .status-icon { font-size: 14px; flex-shrink: 0; margin-top: 1px; }',

    /* ── Stats grid ── */
    '    .stats-grid {',
    '      display: grid;',
    '      grid-template-columns: 1fr 1fr;',
    '      gap: 8px;',
    '      margin-bottom: 14px;',
    '    }',
    '    .stat-card {',
    '      background: var(--bg-card);',
    '      border: 1px solid var(--border);',
    '      border-radius: var(--radius-sm);',
    '      padding: 12px;',
    '    }',
    '    .stat-card .stat-label {',
    '      font-size: 10px;',
    '      font-weight: 600;',
    '      text-transform: uppercase;',
    '      letter-spacing: 0.6px;',
    '      color: var(--text-muted);',
    '      margin-bottom: 4px;',
    '    }',
    '    .stat-card .stat-value {',
    '      font-size: 22px;',
    '      font-weight: 700;',
    '      color: var(--accent);',
    '      line-height: 1;',
    '    }',

    /* ── Score bars ── */
    '    .score-row { margin-bottom: 10px; }',
    '    .score-header {',
    '      display: flex;',
    '      justify-content: space-between;',
    '      align-items: center;',
    '      margin-bottom: 5px;',
    '    }',
    '    .score-header span:first-child { font-size: 12px; color: var(--text-secondary); }',
    '    .score-header span:last-child { font-size: 12px; font-weight: 600; color: var(--text-primary); }',
    '    .score-track {',
    '      height: 5px;',
    '      background: var(--border);',
    '      border-radius: 99px;',
    '      overflow: hidden;',
    '    }',
    '    .score-fill {',
    '      height: 100%;',
    '      border-radius: 99px;',
    '      background: linear-gradient(90deg, var(--accent), #818cf8);',
    '      transition: width 0.6s ease;',
    '    }',

    /* ── Insights ── */
    '    .insights-list { margin-bottom: 14px; }',
    '    .insight-item {',
    '      display: flex;',
    '      gap: 8px;',
    '      padding: 9px 10px;',
    '      border-radius: var(--radius-sm);',
    '      margin-bottom: 6px;',
    '      font-size: 12px;',
    '      line-height: 1.45;',
    '    }',
    '    .insight-item.warning { background: var(--warning-light); color: #fcd34d; border: 1px solid rgba(245,158,11,0.2); }',
    '    .insight-item.info { background: var(--info-light); color: #93c5fd; border: 1px solid rgba(59,130,246,0.2); }',
    '    .insight-item .insight-icon { flex-shrink: 0; font-size: 13px; }',

    /* ── Section divider ── */
    '    .section-divider {',
    '      border: none;',
    '      border-top: 1px solid var(--border);',
    '      margin: 16px 0;',
    '    }',
    '    .section-label {',
    '      font-size: 11px;',
    '      font-weight: 600;',
    '      text-transform: uppercase;',
    '      letter-spacing: 0.8px;',
    '      color: var(--text-muted);',
    '      margin-bottom: 10px;',
    '    }',

    /* ── Table list ── */
    '    .table-list { display: flex; flex-direction: column; gap: 5px; }',
    '    .table-card {',
    '      background: var(--bg-card);',
    '      border: 1px solid var(--border);',
    '      border-radius: var(--radius-sm);',
    '      padding: 10px 12px;',
    '      cursor: pointer;',
    '      transition: background 0.12s, border-color 0.12s;',
    '      display: flex;',
    '      align-items: center;',
    '      gap: 10px;',
    '    }',
    '    .table-card:hover { background: var(--bg-hover); border-color: var(--accent); }',
    '    .table-card .table-dot {',
    '      width: 8px; height: 8px;',
    '      border-radius: 50%;',
    '      background: var(--accent);',
    '      flex-shrink: 0;',
    '    }',
    '    .table-card .table-info { flex: 1; min-width: 0; }',
    '    .table-card .table-name {',
    '      font-size: 13px;',
    '      font-weight: 500;',
    '      color: var(--text-primary);',
    '      white-space: nowrap;',
    '      overflow: hidden;',
    '      text-overflow: ellipsis;',
    '    }',
    '    .table-card .table-meta {',
    '      font-size: 11px;',
    '      color: var(--text-muted);',
    '      margin-top: 1px;',
    '    }',
    '    .table-card .table-badge {',
    '      font-size: 10px;',
    '      font-weight: 600;',
    '      padding: 2px 6px;',
    '      border-radius: 99px;',
    '      background: var(--accent-light);',
    '      color: #a5b4fc;',
    '      flex-shrink: 0;',
    '    }',

    /* ── Main canvas area ── */
    '    .main {',
    '      flex: 1;',
    '      display: flex;',
    '      flex-direction: column;',
    '      overflow: hidden;',
    '      background: var(--bg-primary);',
    '    }',
    '    .canvas-toolbar {',
    '      display: flex;',
    '      align-items: center;',
    '      gap: 10px;',
    '      padding: 12px 20px;',
    '      background: var(--bg-secondary);',
    '      border-bottom: 1px solid var(--border);',
    '      flex-shrink: 0;',
    '    }',
    '    .canvas-toolbar .toolbar-title {',
    '      font-size: 13px;',
    '      font-weight: 600;',
    '      color: var(--text-secondary);',
    '    }',
    '    .canvas-toolbar .toolbar-spacer { flex: 1; }',
    '    .toolbar-btn {',
    '      padding: 6px 12px;',
    '      background: var(--bg-card);',
    '      border: 1px solid var(--border);',
    '      border-radius: var(--radius-sm);',
    '      color: var(--text-secondary);',
    '      font-size: 12px;',
    '      font-weight: 500;',
    '      cursor: pointer;',
    '      transition: background 0.12s, color 0.12s;',
    '    }',
    '    .toolbar-btn:hover { background: var(--bg-hover); color: var(--text-primary); }',
    '    .legend {',
    '      display: flex;',
    '      align-items: center;',
    '      gap: 14px;',
    '      font-size: 11px;',
    '      color: var(--text-muted);',
    '    }',
    '    .legend-item { display: flex; align-items: center; gap: 5px; }',
    '    .legend-dot { width: 8px; height: 8px; border-radius: 50%; }',
    '    #network {',
    '      flex: 1;',
    '      background: var(--bg-primary);',
    '    }',
    '    .empty-state {',
    '      flex: 1;',
    '      display: flex;',
    '      flex-direction: column;',
    '      align-items: center;',
    '      justify-content: center;',
    '      color: var(--text-muted);',
    '      gap: 12px;',
    '      padding: 40px;',
    '      text-align: center;',
    '    }',
    '    .empty-state .empty-icon { font-size: 48px; opacity: 0.4; }',
    '    .empty-state h2 { font-size: 18px; font-weight: 600; color: var(--text-secondary); }',
    '    .empty-state p { font-size: 13px; max-width: 320px; line-height: 1.6; }',
    '    .hidden { display: none !important; }',
    '  </style>',
    '</head>',
    '<body>',
    '  <div class="app">',

    /* ── Sidebar HTML ── */
    '    <aside class="sidebar">',
    '      <div class="sidebar-header">',
    '        <div class="logo">',
    '          <div class="logo-icon">&#x1F5FA;</div>',
    '          <h1>ERD Visualizer</h1>',
    '        </div>',
    '        <p>ServiceNow Schema Explorer</p>',
    '      </div>',
    '      <div class="sidebar-body">',

    /* Connection form */
    '        <div class="form-section">',
    '          <div class="form-section-title">Connection</div>',
    '          <div class="form-group">',
    '            <label for="instance">Instance Name</label>',
    '            <input type="text" id="instance" placeholder="dev12345" autocomplete="off" spellcheck="false">',
    '          </div>',
    '          <div class="form-row">',
    '            <div class="form-group">',
    '              <label for="username">Username</label>',
    '              <input type="text" id="username" placeholder="admin" autocomplete="off">',
    '            </div>',
    '            <div class="form-group">',
    '              <label for="password">Password</label>',
    '              <input type="password" id="password" placeholder="&#x2022;&#x2022;&#x2022;&#x2022;&#x2022;&#x2022;&#x2022;&#x2022;">',
    '            </div>',
    '          </div>',
    '          <div class="form-group">',
    '            <label for="tableLimit">Table Limit <span style="color:var(--text-muted);font-weight:400">(1 – 500)</span></label>',
    '            <input type="number" id="tableLimit" value="50" min="1" max="500">',
    '          </div>',
    '          <div id="statusBanner" class="status-banner"></div>',
    '          <button class="btn btn-primary" id="generateBtn" onclick="generateScheme()">',
    '            <span id="btnIcon">&#x25B6;</span>',
    '            <span id="btnLabel">Generate ERD</span>',
    '          </button>',
    '        </div>',

    /* Stats (hidden until data loads) */
    '        <div id="resultsSection" class="hidden">',
    '          <hr class="section-divider">',
    '          <div class="stats-grid">',
    '            <div class="stat-card">',
    '              <div class="stat-label">Tables</div>',
    '              <div class="stat-value" id="statTables">0</div>',
    '            </div>',
    '            <div class="stat-card">',
    '              <div class="stat-label">Fields</div>',
    '              <div class="stat-value" id="statFields">0</div>',
    '            </div>',
    '            <div class="stat-card">',
    '              <div class="stat-label">Relationships</div>',
    '              <div class="stat-value" id="statRelationships">0</div>',
    '            </div>',
    '            <div class="stat-card">',
    '              <div class="stat-label">Hierarchies</div>',
    '              <div class="stat-value" id="statHierarchies">0</div>',
    '            </div>',
    '          </div>',

    /* Score bars */
    '          <div class="score-row">',
    '            <div class="score-header">',
    '              <span>Complexity</span>',
    '              <span id="complexityValue">—</span>',
    '            </div>',
    '            <div class="score-track"><div class="score-fill" id="complexityFill" style="width:0%"></div></div>',
    '          </div>',
    '          <div class="score-row" style="margin-bottom:14px">',
    '            <div class="score-header">',
    '              <span>Data Quality</span>',
    '              <span id="qualityValue">—</span>',
    '            </div>',
    '            <div class="score-track"><div class="score-fill" id="qualityFill" style="width:0%"></div></div>',
    '          </div>',

    /* Insights */
    '          <div id="insightsList" class="insights-list"></div>',

    /* Export buttons */
    '          <div class="export-row">',
    '            <button class="btn btn-ghost" onclick="exportJSON()">&#x2193; JSON</button>',
    '            <button class="btn btn-ghost" onclick="exportGraphQL()">&#x2193; GraphQL</button>',
    '            <button class="btn btn-ghost" onclick="exportReport()">&#x2193; Report</button>',
    '          </div>',

    /* Table list */
    '          <hr class="section-divider">',
    '          <div class="section-label">Tables</div>',
    '          <div class="table-list" id="tableList"></div>',
    '        </div>',

    '      </div>',
    '    </aside>',

    /* ── Main canvas ── */
    '    <main class="main">',
    '      <div class="canvas-toolbar" id="canvasToolbar">',
    '        <span class="toolbar-title" id="canvasTitle">No data loaded</span>',
    '        <span class="toolbar-spacer"></span>',
    '        <div class="legend" id="canvasLegend" style="display:none">',
    '          <div class="legend-item"><div class="legend-dot" style="background:#6366f1"></div> Table</div>',
    '          <div class="legend-item"><div class="legend-dot" style="background:#ef4444"></div> Mandatory ref</div>',
    '          <div class="legend-item"><div class="legend-dot" style="background:#475569"></div> Optional ref</div>',
    '        </div>',
    '        <button class="toolbar-btn" id="fitBtn" onclick="fitNetwork()" style="display:none">Fit View</button>',
    '        <button class="toolbar-btn" id="physicsBtn" onclick="togglePhysics()" style="display:none">Pause Physics</button>',
    '      </div>',
    '      <div id="emptyState" class="empty-state">',
    '        <div class="empty-icon">&#x1F5FA;</div>',
    '        <h2>No schema loaded</h2>',
    '        <p>Enter your ServiceNow instance credentials and click <strong>Generate ERD</strong> to visualize your database schema.</p>',
    '      </div>',
    '      <div id="network" class="hidden"></div>',
    '    </main>',

    '  </div>',

    /* ── Client-side JS ── */
    '  <script>',
    '    var network = null;',
    '    var currentScheme = null;',
    '    var currentAnalysis = null;',
    '    var physicsEnabled = true;',
    '    var warningTimer = null;',
    '',
    '    function setStatus(type, icon, msg) {',
    '      var el = document.getElementById("statusBanner");',
    '      el.className = "status-banner show " + type;',
    '      el.innerHTML = \'<span class="status-icon">\' + icon + \'</span><span>\' + msg + \'</span>\';',
    '    }',
    '    function clearStatus() {',
    '      var el = document.getElementById("statusBanner");',
    '      el.className = "status-banner";',
    '      el.innerHTML = "";',
    '    }',
    '',
    '    function setLoading(loading) {',
    '      var btn = document.getElementById("generateBtn");',
    '      var icon = document.getElementById("btnIcon");',
    '      var label = document.getElementById("btnLabel");',
    '      if (loading) {',
    '        btn.disabled = true;',
    '        icon.outerHTML = \'<span id="btnIcon" class="spinner"></span>\';',
    '        label.textContent = "Generating\u2026";',
    '      } else {',
    '        btn.disabled = false;',
    '        icon.outerHTML = \'<span id="btnIcon">&#x25B6;</span>\';',
    '        label.textContent = "Generate ERD";',
    '      }',
    '    }',
    '',
    '    async function generateScheme() {',
    '      var instance = document.getElementById("instance").value.trim();',
    '      var username = document.getElementById("username").value.trim();',
    '      var password = document.getElementById("password").value;',
    '      var tableLimit = parseInt(document.getElementById("tableLimit").value) || 50;',
    '',
    '      if (!instance || !username || !password) {',
    '        setStatus("error", "&#x26A0;", "Please fill in all connection fields.");',
    '        return;',
    '      }',
    '',
    '      instance = instance.replace(/^https?:\\/\\//i, "");',
    '      instance = instance.replace(/\\.service-now\\.com.*/i, "").replace(/\\/.*$/, "").trim();',
    '',
    '      if (!instance || !/^[a-zA-Z0-9-]+$/.test(instance)) {',
    '        setStatus("error", "&#x26A0;", "Invalid instance name. Enter only the identifier (e.g. \\"dev12345\\"), not a full URL.");',
    '        return;',
    '      }',
    '',
    '      setLoading(true);',
    '      setStatus("loading", "&#x23F3;", "Connecting to " + instance + ".service-now.com\u2026");',
    '',
    '      warningTimer = setTimeout(function() {',
    '        setStatus("loading", "&#x23F3;", "Still working\u2026 Large schemas can take up to 2 minutes. Consider reducing the table limit.");',
    '      }, 30000);',
    '',
    '      try {',
    '        var response = await fetch("/api/scheme/generate", {',
    '          method: "POST",',
    '          headers: { "Content-Type": "application/json" },',
    '          body: JSON.stringify({ instance: instance, username: username, password: password, tableLimit: tableLimit })',
    '        });',
    '',
    '        clearTimeout(warningTimer);',
    '',
    '        var data = await response.json();',
    '',
    '        if (!response.ok) {',
    '          throw new Error(data.error || "Request failed with status " + response.status);',
    '        }',
    '',
    '        if (!data.schemeMap || !data.summary) {',
    '          throw new Error("Server returned an incomplete response. Please try again.");',
    '        }',
    '',
    '        currentScheme = data.schemeMap;',
    '        currentAnalysis = data.analysis;',
    '',
    '        document.getElementById("statTables").textContent = data.summary.totalTables || 0;',
    '        document.getElementById("statFields").textContent = data.summary.totalFields || 0;',
    '        document.getElementById("statRelationships").textContent = data.summary.totalRelationships || 0;',
    '        document.getElementById("statHierarchies").textContent = data.summary.inheritanceHierarchies || 0;',
    '',
    '        var cx = (data.analysis && data.analysis.complexityScore != null) ? data.analysis.complexityScore : 0;',
    '        var qx = (data.analysis && data.analysis.dataQualityScore != null) ? data.analysis.dataQualityScore : 0;',
    '        document.getElementById("complexityFill").style.width = cx + "%";',
    '        document.getElementById("complexityValue").textContent = cx + " / 100";',
    '        document.getElementById("qualityFill").style.width = qx + "%";',
    '        document.getElementById("qualityValue").textContent = qx + " / 100";',
    '',
    '        var insightsList = document.getElementById("insightsList");',
    '        insightsList.innerHTML = "";',
    '        if (data.insights && data.insights.length > 0) {',
    '          data.insights.forEach(function(ins) {',
    '            var div = document.createElement("div");',
    '            div.className = "insight-item " + (ins.type || "info");',
    '            var iconChar = ins.type === "warning" ? "&#x26A0;" : "&#x2139;";',
    '            div.innerHTML = \'<span class="insight-icon">\' + iconChar + \'</span><span>\' + ins.message + \'</span>\';',
    '            insightsList.appendChild(div);',
    '          });',
    '        }',
    '',
    '        document.getElementById("resultsSection").classList.remove("hidden");',
    '',
    '        visualizeScheme(data.schemeMap);',
    '        populateTableList(data.schemeMap);',
    '',
    '        var t = data.summary.totalTables || 0;',
    '        var r = data.summary.totalRelationships || 0;',
    '        setStatus("success", "&#x2713;", "Loaded " + t + " tables and " + r + " relationships.");',
    '        setLoading(false);',
    '',
    '      } catch (err) {',
    '        clearTimeout(warningTimer);',
    '        setStatus("error", "&#x2715;", err.message || "An unexpected error occurred.");',
    '        setLoading(false);',
    '      }',
    '    }',
    '',
    '    function visualizeScheme(scheme) {',
    '      var nodes = [];',
    '      var edges = [];',
    '',
    '      Object.keys(scheme.tables).forEach(function(name) {',
    '        var table = scheme.tables[name];',
    '        var fieldCount = (scheme.fields[name] || []).length;',
    '        nodes.push({',
    '          id: name,',
    '          label: (table.label || name),',
    '          title: "Table: " + name + "\\nFields: " + fieldCount + "\\nExtendable: " + table.isExtendable,',
    '          color: {',
    '            background: "#1e2130",',
    '            border: "#6366f1",',
    '            highlight: { background: "#252840", border: "#818cf8" },',
    '            hover: { background: "#252840", border: "#818cf8" }',
    '          },',
    '          font: { color: "#e2e8f0", size: 12, face: "Inter, Segoe UI, sans-serif" },',
    '          borderWidth: 1,',
    '          borderWidthSelected: 2,',
    '          shape: "box",',
    '          margin: { top: 8, bottom: 8, left: 12, right: 12 }',
    '        });',
    '      });',
    '',
    '      (scheme.relationships || []).forEach(function(rel) {',
    '        edges.push({',
    '          from: rel.from,',
    '          to: rel.to,',
    '          label: rel.field || "",',
    '          arrows: "to",',
    '          color: {',
    '            color: rel.mandatory ? "#ef4444" : "#475569",',
    '            highlight: "#6366f1",',
    '            hover: "#6366f1"',
    '          },',
    '          font: { size: 9, color: "#64748b", face: "Inter, Segoe UI, sans-serif" },',
    '          width: rel.mandatory ? 2 : 1,',
    '          smooth: { type: "curvedCW", roundness: 0.15 }',
    '        });',
    '      });',
    '',
    '      document.getElementById("emptyState").classList.add("hidden");',
    '      var container = document.getElementById("network");',
    '      container.classList.remove("hidden");',
    '',
    '      var visData = { nodes: new vis.DataSet(nodes), edges: new vis.DataSet(edges) };',
    '      var options = {',
    '        physics: {',
    '          enabled: true,',
    '          barnesHut: { gravitationalConstant: -8000, centralGravity: 0.3, springLength: 180 },',
    '          stabilization: { iterations: 300, updateInterval: 25 }',
    '        },',
    '        interaction: {',
    '          navigationButtons: false,',
    '          keyboard: true,',
    '          hover: true,',
    '          tooltipDelay: 200',
    '        },',
    '        layout: { improvedLayout: true }',
    '      };',
    '',
    '      if (network) { network.destroy(); }',
    '      network = new vis.Network(container, visData, options);',
    '      physicsEnabled = true;',
    '',
    '      document.getElementById("canvasTitle").textContent = scheme.instance + " — " + nodes.length + " tables";',
    '      document.getElementById("canvasLegend").style.display = "flex";',
    '      document.getElementById("fitBtn").style.display = "";',
    '      document.getElementById("physicsBtn").style.display = "";',
    '    }',
    '',
    '    function populateTableList(scheme) {',
    '      var list = document.getElementById("tableList");',
    '      list.innerHTML = "";',
    '      Object.keys(scheme.tables).forEach(function(name) {',
    '        var table = scheme.tables[name];',
    '        var fieldCount = (scheme.fields[name] || []).length;',
    '        var card = document.createElement("div");',
    '        card.className = "table-card";',
    '        card.innerHTML =',
    '          \'<div class="table-dot"></div>\' +',
    '          \'<div class="table-info">\' +',
    '            \'<div class="table-name">\' + (table.label || name) + \'</div>\' +',
    '            \'<div class="table-meta">\' + name + \'</div>\' +',
    '          \'</div>\' +',
    '          \'<div class="table-badge">\' + fieldCount + \' fields</div>\';',
    '        card.onclick = function() {',
    '          if (network) { network.focus(name, { scale: 1.5, animation: { duration: 500, easingFunction: "easeInOutQuad" } }); }',
    '        };',
    '        list.appendChild(card);',
    '      });',
    '    }',
    '',
    '    function fitNetwork() {',
    '      if (network) { network.fit({ animation: { duration: 600, easingFunction: "easeInOutQuad" } }); }',
    '    }',
    '',
    '    function togglePhysics() {',
    '      if (!network) return;',
    '      physicsEnabled = !physicsEnabled;',
    '      network.setOptions({ physics: { enabled: physicsEnabled } });',
    '      document.getElementById("physicsBtn").textContent = physicsEnabled ? "Pause Physics" : "Resume Physics";',
    '    }',
    '',
    '    function exportJSON() {',
    '      if (!currentScheme) return;',
    '      var blob = new Blob([JSON.stringify(currentScheme, null, 2)], { type: "application/json" });',
    '      triggerDownload(URL.createObjectURL(blob), "scheme-map.json");',
    '    }',
    '',
    '    function exportGraphQL() {',
    '      fetch("/api/scheme/export/graphql").then(function(r) { return r.text(); }).then(function(text) {',
    '        triggerDownload(URL.createObjectURL(new Blob([text], { type: "text/plain" })), "schema.graphql");',
    '      });',
    '    }',
    '',
    '    function exportReport() {',
    '      triggerDownload("/api/scheme/export/report", "schema-analysis-report.html");',
    '    }',
    '',
    '    function triggerDownload(url, filename) {',
    '      var a = document.createElement("a");',
    '      a.href = url; a.download = filename; a.click();',
    '    }',
    '',
    '    document.addEventListener("keydown", function(e) {',
    '      if ((e.key === "Enter") && (e.ctrlKey || e.metaKey)) { generateScheme(); }',
    '    });',
    '  <\/script>',
    '</body>',
    '</html>'
  ].join('\n');
  return html;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('ServiceNow ERD Visualizer running on port ' + PORT);
});

