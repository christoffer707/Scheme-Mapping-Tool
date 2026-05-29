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

// API endpoint to get comprehensive table details (fields, UI policies, business rules, script includes, flows)
app.get('/api/scheme/table/:tableName/details', async (req, res) => {
  if (!schemeMapCache) {
    return res.status(404).json({ error: 'No scheme map generated yet. POST to /api/scheme/generate first.' });
  }
  if (!mapperInstance) {
    return res.status(404).json({ error: 'No mapper instance available.' });
  }

  const { tableName } = req.params;
  const table = schemeMapCache.tables[tableName];

  if (!table) {
    return res.status(404).json({ error: 'Table ' + tableName + ' not found in cached schema.' });
  }

  try {
    const details = await mapperInstance.fetchTableDetails(tableName);
    const metrics = analysisCache && analysisCache.tableMetrics ? analysisCache.tableMetrics[tableName] : null;
    const dependencies = mapperInstance.getTableDependencies(tableName);

    res.json({
      table,
      metrics,
      dependencies,
      fields: details.fields,
      uiPolicies: details.uiPolicies,
      uiPolicyActions: details.uiPolicyActions,
      businessRules: details.businessRules,
      scriptIncludes: details.scriptIncludes,
      flows: details.flows
    });
  } catch (error) {
    console.error('[table-details] Error for ' + tableName + ':', error.message);
    res.status(500).json({ error: 'Failed to fetch details for ' + tableName + ': ' + error.message });
  }
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
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ServiceNow ERD Visualizer</title>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/vis/4.21.0/vis.min.js"><\/script>
  <link href="https://cdnjs.cloudflare.com/ajax/libs/vis/4.21.0/vis.min.css" rel="stylesheet" type="text/css" />
  <style>
    *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
    :root {
      --bg-primary: #0a0c14;
      --bg-secondary: #111420;
      --bg-card: #161929;
      --bg-hover: #1e2235;
      --border: #252a40;
      --border-light: #2e3450;
      --accent: #6366f1;
      --accent-hover: #4f52d4;
      --accent-light: rgba(99,102,241,0.15);
      --success: #10b981;
      --success-light: rgba(16,185,129,0.12);
      --warning: #f59e0b;
      --warning-light: rgba(245,158,11,0.12);
      --danger: #ef4444;
      --danger-light: rgba(239,68,68,0.12);
      --info: #3b82f6;
      --info-light: rgba(59,130,246,0.12);
      --text-primary: #e2e8f0;
      --text-secondary: #94a3b8;
      --text-muted: #4e5a72;
      --radius: 10px;
      --radius-sm: 6px;
      --shadow: 0 4px 24px rgba(0,0,0,0.5);
      --color-core: #3b82f6;
      --color-core-bg: rgba(59,130,246,0.14);
      --color-custom: #10b981;
      --color-custom-bg: rgba(16,185,129,0.14);
      --color-extended: #f59e0b;
      --color-extended-bg: rgba(245,158,11,0.14);
      --color-system: #8b5cf6;
      --color-system-bg: rgba(139,92,246,0.14);
    }
    html, body { height: 100%; overflow: hidden; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Inter", sans-serif;
      background: var(--bg-primary);
      color: var(--text-primary);
      font-size: 14px;
      line-height: 1.5;
    }
    .app { display: flex; height: 100vh; overflow: hidden; }

    /* ── Sidebar ── */
    .sidebar {
      width: 340px;
      min-width: 340px;
      background: var(--bg-secondary);
      border-right: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .sidebar-header {
      padding: 18px 18px 14px;
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
      background: linear-gradient(180deg, rgba(99,102,241,0.07) 0%, transparent 100%);
    }
    .sidebar-header .logo { display: flex; align-items: center; gap: 10px; margin-bottom: 4px; }
    .sidebar-header .logo-icon {
      width: 32px; height: 32px;
      background: linear-gradient(135deg, #6366f1, #8b5cf6);
      border-radius: 8px;
      display: flex; align-items: center; justify-content: center;
      font-size: 16px;
      box-shadow: 0 0 14px rgba(99,102,241,0.45);
    }
    .sidebar-header h1 { font-size: 15px; font-weight: 700; color: var(--text-primary); letter-spacing: -0.3px; }
    .sidebar-header p { font-size: 11px; color: var(--text-muted); margin-left: 42px; }

    /* ── Tabs ── */
    .sidebar-tabs { display: flex; border-bottom: 1px solid var(--border); flex-shrink: 0; }
    .sidebar-tab {
      flex: 1; padding: 10px 6px;
      font-size: 11px; font-weight: 600; text-align: center;
      color: var(--text-muted); cursor: pointer;
      border-bottom: 2px solid transparent;
      transition: color 0.15s, border-color 0.15s;
      text-transform: uppercase; letter-spacing: 0.6px;
    }
    .sidebar-tab:hover { color: var(--text-secondary); }
    .sidebar-tab.active { color: var(--accent); border-bottom-color: var(--accent); }
    .sidebar-panel { display: none; flex: 1; overflow-y: auto; flex-direction: column; }
    .sidebar-panel.active { display: flex; }
    .sidebar-panel::-webkit-scrollbar { width: 3px; }
    .sidebar-panel::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }
    .panel-body { padding: 16px 18px; flex: 1; }

    /* ── Form ── */
    .form-section { margin-bottom: 18px; }
    .form-section-title {
      font-size: 10px; font-weight: 700; text-transform: uppercase;
      letter-spacing: 1px; color: var(--text-muted); margin-bottom: 10px;
    }
    .form-group { margin-bottom: 10px; }
    .form-group label { display: block; font-size: 12px; font-weight: 500; color: var(--text-secondary); margin-bottom: 5px; }
    .form-group input {
      width: 100%; padding: 9px 12px;
      background: var(--bg-card); border: 1px solid var(--border);
      border-radius: var(--radius-sm); color: var(--text-primary);
      font-size: 13px; transition: border-color 0.15s, box-shadow 0.15s; outline: none;
    }
    .form-group input::placeholder { color: var(--text-muted); }
    .form-group input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-light); }
    .form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }

    /* ── Buttons ── */
    .btn {
      display: inline-flex; align-items: center; justify-content: center; gap: 7px;
      padding: 10px 16px; border: none; border-radius: var(--radius-sm);
      font-size: 13px; font-weight: 600; cursor: pointer;
      transition: background 0.15s, transform 0.1s, opacity 0.15s, box-shadow 0.15s;
      width: 100%;
    }
    .btn:active { transform: scale(0.98); }
    .btn-primary {
      background: linear-gradient(135deg, #6366f1, #8b5cf6);
      color: #fff; box-shadow: 0 2px 12px rgba(99,102,241,0.35);
    }
    .btn-primary:hover:not(:disabled) {
      background: linear-gradient(135deg, #4f52d4, #7c3aed);
      box-shadow: 0 4px 18px rgba(99,102,241,0.5);
    }
    .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; box-shadow: none; }
    .btn-ghost {
      background: var(--bg-card); color: var(--text-secondary);
      border: 1px solid var(--border); font-size: 12px; padding: 7px 10px;
    }
    .btn-ghost:hover { background: var(--bg-hover); color: var(--text-primary); border-color: var(--border-light); }
    .export-row { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; margin-top: 12px; }

    /* ── Spinner ── */
    @keyframes spin { to { transform: rotate(360deg); } }
    .spinner {
      width: 14px; height: 14px;
      border: 2px solid rgba(255,255,255,0.25);
      border-top-color: #fff; border-radius: 50%;
      animation: spin 0.7s linear infinite; flex-shrink: 0;
    }

    /* ── Status banner ── */
    .status-banner {
      padding: 10px 12px; border-radius: var(--radius-sm);
      font-size: 12px; line-height: 1.5; margin-bottom: 14px; display: none;
    }
    .status-banner.show { display: flex; align-items: flex-start; gap: 8px; }
    .status-banner.loading { background: var(--info-light); color: #93c5fd; border: 1px solid rgba(59,130,246,0.25); }
    .status-banner.success { background: var(--success-light); color: #6ee7b7; border: 1px solid rgba(16,185,129,0.25); }
    .status-banner.error { background: var(--danger-light); color: #fca5a5; border: 1px solid rgba(239,68,68,0.25); }
    .status-banner .status-icon { font-size: 14px; flex-shrink: 0; margin-top: 1px; }

    /* ── Stats grid ── */
    .stats-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 14px; }
    .stat-card {
      background: var(--bg-card); border: 1px solid var(--border);
      border-radius: var(--radius-sm); padding: 12px;
      transition: border-color 0.15s;
    }
    .stat-card:hover { border-color: var(--border-light); }
    .stat-card .stat-label {
      font-size: 10px; font-weight: 600; text-transform: uppercase;
      letter-spacing: 0.6px; color: var(--text-muted); margin-bottom: 4px;
    }
    .stat-card .stat-value { font-size: 22px; font-weight: 700; color: var(--accent); line-height: 1; }

    /* ── Score bars ── */
    .score-row { margin-bottom: 10px; }
    .score-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 5px; }
    .score-header span:first-child { font-size: 12px; color: var(--text-secondary); }
    .score-header span:last-child { font-size: 12px; font-weight: 600; color: var(--text-primary); }
    .score-track { height: 5px; background: var(--border); border-radius: 99px; overflow: hidden; }
    .score-fill {
      height: 100%; border-radius: 99px;
      background: linear-gradient(90deg, var(--accent), #818cf8);
      transition: width 0.8s cubic-bezier(0.4,0,0.2,1);
    }

    /* ── Insights ── */
    .insights-list { margin-bottom: 14px; }
    .insight-item {
      display: flex; gap: 8px; padding: 9px 10px;
      border-radius: var(--radius-sm); margin-bottom: 6px;
      font-size: 12px; line-height: 1.45;
    }
    .insight-item.warning { background: var(--warning-light); color: #fcd34d; border: 1px solid rgba(245,158,11,0.2); }
    .insight-item.info { background: var(--info-light); color: #93c5fd; border: 1px solid rgba(59,130,246,0.2); }
    .insight-item .insight-icon { flex-shrink: 0; font-size: 13px; }

    /* ── Dividers ── */
    .section-divider { border: none; border-top: 1px solid var(--border); margin: 14px 0; }
    .section-label {
      font-size: 10px; font-weight: 700; text-transform: uppercase;
      letter-spacing: 1px; color: var(--text-muted); margin-bottom: 10px;
    }

    /* ── Search & filter ── */
    .search-wrap { position: relative; margin-bottom: 10px; }
    .search-icon {
      position: absolute; left: 10px; top: 50%; transform: translateY(-50%);
      color: var(--text-muted); font-size: 12px; pointer-events: none;
    }
    .search-input {
      width: 100%; padding: 8px 30px 8px 30px;
      background: var(--bg-card); border: 1px solid var(--border);
      border-radius: var(--radius-sm); color: var(--text-primary);
      font-size: 13px; outline: none;
      transition: border-color 0.15s, box-shadow 0.15s;
    }
    .search-input::placeholder { color: var(--text-muted); }
    .search-input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-light); }
    .search-clear {
      position: absolute; right: 8px; top: 50%; transform: translateY(-50%);
      background: none; border: none; color: var(--text-muted); cursor: pointer;
      font-size: 13px; padding: 2px 4px; border-radius: 3px; display: none;
    }
    .search-clear:hover { color: var(--text-primary); background: var(--bg-hover); }
    .search-clear.visible { display: block; }
    .search-meta { font-size: 11px; color: var(--text-muted); margin-bottom: 8px; min-height: 16px; }
    .search-meta .match-count { color: var(--accent); font-weight: 600; }
    .filter-chips { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 10px; }
    .filter-chip {
      padding: 3px 10px; border-radius: 99px; font-size: 11px; font-weight: 600;
      cursor: pointer; border: 1px solid var(--border); background: var(--bg-card);
      color: var(--text-muted); transition: all 0.15s; white-space: nowrap;
    }
    .filter-chip:hover { border-color: var(--border-light); color: var(--text-secondary); }
    .filter-chip.active { background: var(--accent-light); border-color: var(--accent); color: #a5b4fc; }
    .filter-chip.chip-core.active { background: var(--color-core-bg); border-color: var(--color-core); color: #93c5fd; }
    .filter-chip.chip-custom.active { background: var(--color-custom-bg); border-color: var(--color-custom); color: #6ee7b7; }
    .filter-chip.chip-extended.active { background: var(--color-extended-bg); border-color: var(--color-extended); color: #fcd34d; }
    .filter-chip.chip-system.active { background: var(--color-system-bg); border-color: var(--color-system); color: #c4b5fd; }

    /* ── Table list ── */
    .table-list { display: flex; flex-direction: column; gap: 4px; }
    .table-card {
      background: var(--bg-card); border: 1px solid var(--border);
      border-radius: var(--radius-sm); padding: 9px 11px; cursor: pointer;
      transition: background 0.12s, border-color 0.12s, transform 0.1s;
      display: flex; align-items: center; gap: 9px;
    }
    .table-card:hover { background: var(--bg-hover); border-color: var(--border-light); transform: translateX(2px); }
    .table-card.highlighted { border-color: var(--accent); background: var(--accent-light); }
    .table-card.search-match .table-name em { font-style: normal; background: rgba(99,102,241,0.3); border-radius: 2px; padding: 0 2px; }
    .table-type-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
    .table-card .table-info { flex: 1; min-width: 0; }
    .table-card .table-name {
      font-size: 12px; font-weight: 500; color: var(--text-primary);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .table-card .table-meta {
      font-size: 11px; color: var(--text-muted); margin-top: 1px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .table-card .table-badges { display: flex; flex-direction: column; align-items: flex-end; gap: 3px; flex-shrink: 0; }
    .badge { font-size: 10px; font-weight: 600; padding: 1px 6px; border-radius: 99px; white-space: nowrap; }
    .badge-fields { background: var(--accent-light); color: #a5b4fc; }
    .badge-core { background: var(--color-core-bg); color: #93c5fd; }
    .badge-custom { background: var(--color-custom-bg); color: #6ee7b7; }
    .badge-extended { background: var(--color-extended-bg); color: #fcd34d; }
    .badge-system { background: var(--color-system-bg); color: #c4b5fd; }
    .no-results { text-align: center; padding: 24px 12px; color: var(--text-muted); font-size: 12px; }
    .no-results .no-results-icon { font-size: 28px; margin-bottom: 8px; opacity: 0.4; }

    /* ── Detail panel ── */
    .detail-panel { padding: 16px 18px; flex: 1; overflow-y: auto; }
    .detail-panel::-webkit-scrollbar { width: 3px; }
    .detail-panel::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }
    .detail-empty {
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      height: 100%; color: var(--text-muted); text-align: center; gap: 10px; padding: 40px 20px;
    }
    .detail-empty .detail-empty-icon { font-size: 36px; opacity: 0.3; }
    .detail-empty p { font-size: 12px; line-height: 1.6; }
    .detail-table-name { font-size: 15px; font-weight: 700; color: var(--text-primary); margin-bottom: 2px; word-break: break-all; }
    .detail-table-label { font-size: 12px; color: var(--text-muted); margin-bottom: 12px; }
    .detail-badges { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 14px; }
    .detail-stats { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 6px; margin-bottom: 14px; }
    .detail-stat {
      background: var(--bg-card); border: 1px solid var(--border);
      border-radius: var(--radius-sm); padding: 8px; text-align: center;
    }
    .detail-stat .ds-val { font-size: 18px; font-weight: 700; color: var(--accent); line-height: 1; }
    .detail-stat .ds-lbl {
      font-size: 9px; font-weight: 600; text-transform: uppercase;
      letter-spacing: 0.5px; color: var(--text-muted); margin-top: 3px;
    }
    .detail-section-title {
      font-size: 10px; font-weight: 700; text-transform: uppercase;
      letter-spacing: 1px; color: var(--text-muted); margin: 12px 0 7px;
    }
    .detail-rel-list { display: flex; flex-direction: column; gap: 4px; }
    .detail-rel-item {
      display: flex; align-items: center; gap: 7px; padding: 6px 9px;
      background: var(--bg-card); border: 1px solid var(--border);
      border-radius: var(--radius-sm); font-size: 11px; cursor: pointer;
      transition: background 0.12s, border-color 0.12s;
    }
    .detail-rel-item:hover { background: var(--bg-hover); border-color: var(--border-light); }
    .detail-rel-arrow { color: var(--text-muted); font-size: 10px; }
    .detail-rel-table { font-weight: 600; color: var(--text-primary); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .detail-rel-field { color: var(--text-muted); font-size: 10px; }
    .detail-rel-mandatory { width: 6px; height: 6px; border-radius: 50%; background: var(--danger); flex-shrink: 0; }
    .detail-rel-optional { width: 6px; height: 6px; border-radius: 50%; background: var(--text-muted); flex-shrink: 0; }
    .detail-actions { display: flex; gap: 6px; margin-top: 14px; }
    .detail-actions .btn { font-size: 11px; padding: 7px 10px; }
    .detail-field-list { display: flex; flex-direction: column; gap: 3px; max-height: 200px; overflow-y: auto; }
    .detail-field-list::-webkit-scrollbar { width: 3px; }
    .detail-field-list::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }
    .detail-field-item {
      display: flex; align-items: center; gap: 6px; padding: 4px 8px;
      border-radius: 4px; font-size: 11px; background: var(--bg-card);
    }
    .detail-field-name { flex: 1; color: var(--text-secondary); font-family: monospace; font-size: 11px; }
    .detail-field-type { color: var(--text-muted); font-size: 10px; }
    .detail-field-mandatory { color: var(--danger); font-size: 9px; font-weight: 700; }

    /* ── Main canvas ── */
    .main { flex: 1; display: flex; flex-direction: column; overflow: hidden; background: var(--bg-primary); position: relative; }
    .canvas-toolbar {
      display: flex; align-items: center; gap: 8px; padding: 10px 16px;
      background: var(--bg-secondary); border-bottom: 1px solid var(--border); flex-shrink: 0;
    }
    .canvas-toolbar .toolbar-title { font-size: 12px; font-weight: 600; color: var(--text-secondary); }
    .canvas-toolbar .toolbar-spacer { flex: 1; }
    .toolbar-btn {
      padding: 5px 11px; background: var(--bg-card); border: 1px solid var(--border);
      border-radius: var(--radius-sm); color: var(--text-secondary);
      font-size: 11px; font-weight: 500; cursor: pointer;
      transition: background 0.12s, color 0.12s, border-color 0.12s; white-space: nowrap;
    }
    .toolbar-btn:hover { background: var(--bg-hover); color: var(--text-primary); border-color: var(--border-light); }
    .toolbar-btn.active { background: var(--accent-light); border-color: var(--accent); color: #a5b4fc; }
    .legend { display: flex; align-items: center; gap: 10px; font-size: 10px; color: var(--text-muted); }
    .legend-item { display: flex; align-items: center; gap: 4px; }
    .legend-dot { width: 7px; height: 7px; border-radius: 50%; }
    .legend-line { width: 14px; height: 2px; border-radius: 1px; }
    #network { flex: 1; background: radial-gradient(ellipse at 50% 50%, #0d1020 0%, #0a0c14 100%); }
    .empty-state {
      flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center;
      color: var(--text-muted); gap: 12px; padding: 40px; text-align: center;
    }
    .empty-state .empty-icon { font-size: 52px; opacity: 0.25; }
    .empty-state h2 { font-size: 18px; font-weight: 600; color: var(--text-secondary); }
    .empty-state p { font-size: 13px; max-width: 320px; line-height: 1.6; }
    .empty-state .kbd {
      display: inline-block; padding: 2px 6px; background: var(--bg-card);
      border: 1px solid var(--border); border-radius: 4px;
      font-size: 11px; font-family: monospace; color: var(--text-secondary);
    }

    /* ── Context menu ── */
    .ctx-menu {
      position: fixed; background: var(--bg-card); border: 1px solid var(--border-light);
      border-radius: var(--radius-sm); box-shadow: var(--shadow);
      z-index: 1000; min-width: 160px; overflow: hidden; display: none;
    }
    .ctx-menu.visible { display: block; }
    .ctx-menu-item {
      padding: 8px 14px; font-size: 12px; color: var(--text-secondary); cursor: pointer;
      display: flex; align-items: center; gap: 8px; transition: background 0.1s, color 0.1s;
    }
    .ctx-menu-item:hover { background: var(--bg-hover); color: var(--text-primary); }
    .ctx-menu-item .ctx-icon { font-size: 13px; width: 16px; text-align: center; }
    .ctx-menu-sep { border-top: 1px solid var(--border); margin: 3px 0; }

    /* ── Hover tooltip ── */
    .node-tooltip {
      position: fixed; background: var(--bg-card); border: 1px solid var(--border-light);
      border-radius: var(--radius-sm); padding: 10px 12px; font-size: 12px;
      color: var(--text-primary); box-shadow: var(--shadow);
      z-index: 999; pointer-events: none; display: none; max-width: 220px;
    }
    .node-tooltip.visible { display: block; }
    .node-tooltip .tt-name { font-weight: 700; margin-bottom: 5px; font-size: 13px; }
    .node-tooltip .tt-row { display: flex; justify-content: space-between; gap: 12px; margin-bottom: 2px; }
    .node-tooltip .tt-label { color: var(--text-muted); }
    .node-tooltip .tt-val { font-weight: 600; }
    .node-tooltip .tt-type { margin-top: 5px; }

    /* ── Shortcut hints ── */
    .shortcut-hint {
      position: absolute; bottom: 14px; right: 14px;
      display: flex; gap: 8px; z-index: 10;
    }
    .shortcut-pill {
      background: rgba(17,20,32,0.88); border: 1px solid var(--border);
      border-radius: 99px; padding: 4px 10px; font-size: 10px;
      color: var(--text-muted); backdrop-filter: blur(4px);
    }
    .shortcut-pill kbd { font-family: monospace; color: var(--text-secondary); font-size: 10px; }

    .hidden { display: none !important; }

    /* ── Inspector Panel ── */
    .inspector {
      width: 480px;
      min-width: 480px;
      background: var(--bg-secondary);
      border-left: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      transition: width 0.25s ease, min-width 0.25s ease;
    }
    .inspector.collapsed { width: 0; min-width: 0; border-left: none; }
    .inspector-header {
      padding: 16px 18px 14px;
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .inspector-title-row {
      display: flex;
      align-items: flex-start;
      gap: 10px;
    }
    .inspector-icon {
      width: 34px; height: 34px;
      background: var(--accent-light);
      border: 1px solid rgba(99,102,241,0.3);
      border-radius: 8px;
      display: flex; align-items: center; justify-content: center;
      font-size: 16px;
      flex-shrink: 0;
    }
    .inspector-title-text { flex: 1; min-width: 0; }
    .inspector-title-text h2 {
      font-size: 14px;
      font-weight: 700;
      color: var(--text-primary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .inspector-title-text p {
      font-size: 11px;
      color: var(--text-muted);
      margin-top: 2px;
    }
    .inspector-close {
      width: 26px; height: 26px;
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 6px;
      color: var(--text-muted);
      font-size: 14px;
      cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      flex-shrink: 0;
      transition: background 0.12s, color 0.12s;
    }
    .inspector-close:hover { background: var(--bg-hover); color: var(--text-primary); }
    .inspector-meta-pills {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .meta-pill {
      font-size: 10px;
      font-weight: 600;
      padding: 3px 8px;
      border-radius: 99px;
      letter-spacing: 0.3px;
    }
    .meta-pill.accent { background: var(--accent-light); color: #a5b4fc; border: 1px solid rgba(99,102,241,0.25); }
    .meta-pill.success { background: var(--success-light); color: #6ee7b7; border: 1px solid rgba(16,185,129,0.2); }
    .meta-pill.warning { background: var(--warning-light); color: #fcd34d; border: 1px solid rgba(245,158,11,0.2); }
    .meta-pill.muted { background: var(--bg-card); color: var(--text-muted); border: 1px solid var(--border); }
    .inspector-tabs {
      display: flex;
      gap: 2px;
      padding: 0 18px;
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
      overflow-x: auto;
    }
    .inspector-tabs::-webkit-scrollbar { height: 0; }
    .inspector-tab {
      padding: 10px 12px;
      font-size: 12px;
      font-weight: 500;
      color: var(--text-muted);
      cursor: pointer;
      border-bottom: 2px solid transparent;
      white-space: nowrap;
      transition: color 0.12s, border-color 0.12s;
      display: flex;
      align-items: center;
      gap: 5px;
      user-select: none;
    }
    .inspector-tab:hover { color: var(--text-secondary); }
    .inspector-tab.active { color: var(--accent); border-bottom-color: var(--accent); }
    .inspector-tab .tab-count {
      font-size: 10px;
      font-weight: 700;
      padding: 1px 5px;
      border-radius: 99px;
      background: var(--bg-card);
      color: var(--text-muted);
    }
    .inspector-tab.active .tab-count { background: var(--accent-light); color: #a5b4fc; }
    .inspector-body {
      flex: 1;
      overflow-y: auto;
      padding: 16px 18px;
    }
    .inspector-body::-webkit-scrollbar { width: 4px; }
    .inspector-body::-webkit-scrollbar-track { background: transparent; }
    .inspector-body::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }
    .inspector-loading {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 12px;
      padding: 60px 20px;
      color: var(--text-muted);
      font-size: 13px;
    }
    .inspector-loading .big-spinner {
      width: 28px; height: 28px;
      border: 3px solid var(--border);
      border-top-color: var(--accent);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    .inspector-empty {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding: 40px 20px;
      color: var(--text-muted);
      font-size: 12px;
      text-align: center;
    }
    .inspector-empty .empty-emoji { font-size: 28px; opacity: 0.5; }
    .inspector-search {
      position: relative;
      margin-bottom: 12px;
    }
    .inspector-search input {
      width: 100%;
      padding: 8px 10px 8px 32px;
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      color: var(--text-primary);
      font-size: 12px;
      outline: none;
      transition: border-color 0.15s;
    }
    .inspector-search input::placeholder { color: var(--text-muted); }
    .inspector-search input:focus { border-color: var(--accent); }
    .inspector-search .search-icon {
      position: absolute;
      left: 10px;
      top: 50%;
      transform: translateY(-50%);
      color: var(--text-muted);
      font-size: 12px;
      pointer-events: none;
    }
    .field-table { width: 100%; border-collapse: collapse; }
    .field-table th {
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.6px;
      color: var(--text-muted);
      padding: 6px 8px;
      text-align: left;
      border-bottom: 1px solid var(--border);
      white-space: nowrap;
    }
    .field-table td {
      padding: 7px 8px;
      font-size: 12px;
      color: var(--text-secondary);
      border-bottom: 1px solid rgba(46,50,80,0.5);
      vertical-align: middle;
    }
    .field-table tr:last-child td { border-bottom: none; }
    .field-table tr:hover td { background: var(--bg-hover); }
    .field-name-cell {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .field-name-text {
      font-family: "SF Mono", "Fira Code", "Cascadia Code", monospace;
      font-size: 11px;
      color: var(--text-primary);
    }
    .copy-btn {
      width: 18px; height: 18px;
      background: transparent;
      border: none;
      color: var(--text-muted);
      cursor: pointer;
      font-size: 11px;
      display: flex; align-items: center; justify-content: center;
      border-radius: 3px;
      opacity: 0;
      transition: opacity 0.12s, color 0.12s, background 0.12s;
      flex-shrink: 0;
    }
    .field-table tr:hover .copy-btn { opacity: 1; }
    .copy-btn:hover { color: var(--accent); background: var(--accent-light); }
    .copy-btn.copied { color: var(--success); opacity: 1; }
    .type-badge {
      font-size: 10px;
      font-weight: 500;
      padding: 2px 6px;
      border-radius: 4px;
      background: var(--bg-hover);
      color: var(--text-muted);
      font-family: "SF Mono", "Fira Code", monospace;
      white-space: nowrap;
    }
    .type-badge.ref { background: rgba(59,130,246,0.12); color: #93c5fd; }
    .type-badge.script { background: rgba(245,158,11,0.12); color: #fcd34d; }
    .bool-dot {
      width: 7px; height: 7px;
      border-radius: 50%;
      display: inline-block;
    }
    .bool-dot.yes { background: var(--success); }
    .bool-dot.no { background: var(--border); }
    .rule-card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      margin-bottom: 10px;
      overflow: hidden;
    }
    .rule-card-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 12px;
      cursor: pointer;
      user-select: none;
      transition: background 0.12s;
    }
    .rule-card-header:hover { background: var(--bg-hover); }
    .rule-card-header .rule-name {
      flex: 1;
      font-size: 12px;
      font-weight: 600;
      color: var(--text-primary);
      min-width: 0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .rule-card-header .rule-chevron {
      font-size: 10px;
      color: var(--text-muted);
      transition: transform 0.2s;
      flex-shrink: 0;
    }
    .rule-card.open .rule-chevron { transform: rotate(90deg); }
    .rule-card-body {
      display: none;
      padding: 0 12px 12px;
      border-top: 1px solid var(--border);
    }
    .rule-card.open .rule-card-body { display: block; }
    .rule-meta-row {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      padding: 8px 0 10px;
    }
    .rule-field { margin-bottom: 8px; }
    .rule-field-label {
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--text-muted);
      margin-bottom: 4px;
    }
    .rule-field-value {
      font-size: 12px;
      color: var(--text-secondary);
      line-height: 1.5;
    }
    .code-block {
      position: relative;
      background: #0d0f1a;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      padding: 10px 12px;
      font-family: "SF Mono", "Fira Code", "Cascadia Code", Consolas, monospace;
      font-size: 11px;
      line-height: 1.6;
      color: #c9d1d9;
      overflow-x: auto;
      white-space: pre;
      max-height: 260px;
      overflow-y: auto;
    }
    .code-block::-webkit-scrollbar { width: 4px; height: 4px; }
    .code-block::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }
    .code-copy-btn {
      position: absolute;
      top: 6px;
      right: 6px;
      padding: 3px 8px;
      background: var(--bg-hover);
      border: 1px solid var(--border);
      border-radius: 4px;
      color: var(--text-muted);
      font-size: 10px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.12s, color 0.12s;
    }
    .code-copy-btn:hover { background: var(--accent-light); color: #a5b4fc; }
    .code-copy-btn.copied { color: var(--success); }
    .tok-kw { color: #ff7b72; }
    .tok-str { color: #a5d6ff; }
    .tok-num { color: #79c0ff; }
    .tok-cmt { color: #8b949e; font-style: italic; }
    .tok-fn { color: #d2a8ff; }
    .overview-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
      margin-bottom: 14px;
    }
    .overview-card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      padding: 10px 12px;
    }
    .overview-card .ov-label {
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--text-muted);
      margin-bottom: 3px;
    }
    .overview-card .ov-value {
      font-size: 20px;
      font-weight: 700;
      color: var(--accent);
      line-height: 1;
    }
    .overview-card .ov-sub {
      font-size: 11px;
      color: var(--text-muted);
      margin-top: 2px;
    }
    .dep-section { margin-bottom: 14px; }
    .dep-section-title {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.6px;
      color: var(--text-muted);
      margin-bottom: 8px;
    }
    .dep-chip {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 4px 9px;
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 99px;
      font-size: 11px;
      color: var(--text-secondary);
      margin: 0 4px 4px 0;
      cursor: pointer;
      transition: border-color 0.12s, color 0.12s;
    }
    .dep-chip:hover { border-color: var(--accent); color: var(--text-primary); }
    .dep-chip .dep-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
    .dep-chip.incoming .dep-dot { background: var(--info); }
    .dep-chip.outgoing .dep-dot { background: var(--accent); }
  </style>
</head>
<body>
  <div class="app">

    <!-- Sidebar -->
    <aside class="sidebar">
      <div class="sidebar-header">
        <div class="logo">
          <div class="logo-icon">&#x1F5FA;</div>
          <h1>ERD Visualizer</h1>
        </div>
        <p>ServiceNow Schema Explorer</p>
      </div>
      <div class="sidebar-tabs">
        <div class="sidebar-tab active" id="tab-connect" onclick="switchTab('connect')">Connect</div>
        <div class="sidebar-tab" id="tab-tables" onclick="switchTab('tables')">Tables</div>
        <div class="sidebar-tab" id="tab-detail" onclick="switchTab('detail')">Detail</div>
      </div>

      <!-- Connect panel -->
      <div class="sidebar-panel active" id="panel-connect">
        <div class="panel-body">
          <div class="form-section">
            <div class="form-section-title">Connection</div>
            <div class="form-group">
              <label for="instance">Instance Name</label>
              <input type="text" id="instance" placeholder="dev12345" autocomplete="off" spellcheck="false">
            </div>
            <div class="form-row">
              <div class="form-group">
                <label for="username">Username</label>
                <input type="text" id="username" placeholder="admin" autocomplete="off">
              </div>
              <div class="form-group">
                <label for="password">Password</label>
                <input type="password" id="password" placeholder="&#x2022;&#x2022;&#x2022;&#x2022;&#x2022;&#x2022;&#x2022;&#x2022;">
              </div>
            </div>
            <div class="form-group">
              <label for="tableLimit">Table Limit <span style="color:var(--text-muted);font-weight:400">(1 – 500)</span></label>
              <input type="number" id="tableLimit" value="50" min="1" max="500">
            </div>
            <div id="statusBanner" class="status-banner"></div>
            <button class="btn btn-primary" id="generateBtn" onclick="generateScheme()">
              <span id="btnIcon">&#x25B6;</span>
              <span id="btnLabel">Generate ERD</span>
            </button>
          </div>

          <!-- Stats (hidden until data loads) -->
          <div id="resultsSection" class="hidden">
            <hr class="section-divider">
            <div class="stats-grid">
              <div class="stat-card"><div class="stat-label">Tables</div><div class="stat-value" id="statTables">0</div></div>
              <div class="stat-card"><div class="stat-label">Fields</div><div class="stat-value" id="statFields">0</div></div>
              <div class="stat-card"><div class="stat-label">Relationships</div><div class="stat-value" id="statRelationships">0</div></div>
              <div class="stat-card"><div class="stat-label">Hierarchies</div><div class="stat-value" id="statHierarchies">0</div></div>
            </div>
            <div class="score-row">
              <div class="score-header"><span>Complexity</span><span id="complexityValue">—</span></div>
              <div class="score-track"><div class="score-fill" id="complexityFill" style="width:0%"></div></div>
            </div>
            <div class="score-row" style="margin-bottom:14px">
              <div class="score-header"><span>Data Quality</span><span id="qualityValue">—</span></div>
              <div class="score-track"><div class="score-fill" id="qualityFill" style="width:0%"></div></div>
            </div>
            <div id="insightsList" class="insights-list"></div>
            <div class="export-row">
              <button class="btn btn-ghost" onclick="exportJSON()">&#x2193; JSON</button>
              <button class="btn btn-ghost" onclick="exportGraphQL()">&#x2193; GraphQL</button>
              <button class="btn btn-ghost" onclick="exportReport()">&#x2193; Report</button>
            </div>
          </div>
        </div>
      </div>

      <!-- Tables panel -->
      <div class="sidebar-panel" id="panel-tables">
        <div class="panel-body">
          <div class="search-wrap">
            <span class="search-icon">&#x1F50D;</span>
            <input class="search-input" id="tableSearch" placeholder="Search tables\u2026" oninput="onSearchInput()" autocomplete="off" spellcheck="false">
            <button class="search-clear" id="searchClear" onclick="clearSearch()" title="Clear">&#x2715;</button>
          </div>
          <div class="filter-chips">
            <div class="filter-chip chip-all active" id="chip-all" onclick="setFilter('all')">All</div>
            <div class="filter-chip chip-core" id="chip-core" onclick="setFilter('core')">&#x1F535; Core</div>
            <div class="filter-chip chip-custom" id="chip-custom" onclick="setFilter('custom')">&#x1F7E2; Custom</div>
            <div class="filter-chip chip-extended" id="chip-extended" onclick="setFilter('extended')">&#x1F7E1; Extended</div>
            <div class="filter-chip chip-system" id="chip-system" onclick="setFilter('system')">&#x1F7E3; System</div>
          </div>
          <div class="search-meta" id="searchMeta"></div>
          <div class="table-list" id="tableList"></div>
        </div>
      </div>

      <!-- Detail panel -->
      <div class="sidebar-panel" id="panel-detail">
        <div class="detail-panel" id="detailContent">
          <div class="detail-empty">
            <div class="detail-empty-icon">&#x1F4CB;</div>
            <p>Click a table in the diagram or the Tables list to see its details here.</p>
          </div>
        </div>
      </div>
    </aside>

    <!-- Main canvas -->
    <main class="main">
      <div class="canvas-toolbar" id="canvasToolbar">
        <span class="toolbar-title" id="canvasTitle">No data loaded</span>
        <span class="toolbar-spacer"></span>
        <div class="legend" id="canvasLegend" style="display:none">
          <div class="legend-item"><div class="legend-dot" style="background:#3b82f6"></div> Core</div>
          <div class="legend-item"><div class="legend-dot" style="background:#10b981"></div> Custom</div>
          <div class="legend-item"><div class="legend-dot" style="background:#f59e0b"></div> Extended</div>
          <div class="legend-item"><div class="legend-dot" style="background:#8b5cf6"></div> System</div>
          <div class="legend-item"><div class="legend-line" style="background:#ef4444"></div> Mandatory</div>
          <div class="legend-item"><div class="legend-line" style="background:#334155"></div> Optional</div>
        </div>
        <button class="toolbar-btn" id="fitBtn" onclick="fitNetwork()" style="display:none">&#x26F6; Fit</button>
        <button class="toolbar-btn" id="physicsBtn" onclick="togglePhysics()" style="display:none">&#x23F8; Pause</button>
        <button class="toolbar-btn" id="highlightBtn" onclick="clearHighlight()" style="display:none">&#x2715; Clear Focus</button>
      </div>
      <div id="emptyState" class="empty-state">
        <div class="empty-icon">&#x1F5FA;</div>
        <h2>No schema loaded</h2>
        <p>Enter your ServiceNow credentials and click <strong>Generate ERD</strong> to visualize your database schema.</p>
        <p style="margin-top:8px"><span class="kbd">Ctrl+Enter</span> to generate &nbsp;&bull;&nbsp; <span class="kbd">Ctrl+F</span> to search</p>
      </div>
      <div id="network" class="hidden"></div>
      <div class="shortcut-hint" id="shortcutHint" style="display:none">
        <div class="shortcut-pill"><kbd>Ctrl+F</kbd> Search</div>
        <div class="shortcut-pill"><kbd>Ctrl+Enter</kbd> Generate</div>
        <div class="shortcut-pill"><kbd>Esc</kbd> Clear focus</div>
      </div>
    </main>

    <!-- Context menu -->
    <div class="ctx-menu" id="ctxMenu">
      <div class="ctx-menu-item" onclick="ctxAction('focus')"><span class="ctx-icon">&#x1F3AF;</span> Focus Table</div>
      <div class="ctx-menu-item" onclick="ctxAction('highlight')"><span class="ctx-icon">&#x2728;</span> Highlight Related</div>
      <div class="ctx-menu-item" onclick="ctxAction('detail')"><span class="ctx-icon">&#x1F4CB;</span> View Details</div>
      <div class="ctx-menu-sep"></div>
      <div class="ctx-menu-item" onclick="ctxAction('fit')"><span class="ctx-icon">&#x26F6;</span> Fit All</div>
    </div>

    <!-- Hover tooltip -->
    <div class="node-tooltip" id="nodeTooltip">
      <div class="tt-name" id="ttName"></div>
      <div class="tt-row"><span class="tt-label">Fields</span><span class="tt-val" id="ttFields"></span></div>
      <div class="tt-row"><span class="tt-label">Relationships</span><span class="tt-val" id="ttRels"></span></div>
      <div class="tt-row"><span class="tt-label">Extendable</span><span class="tt-val" id="ttExt"></span></div>
      <div class="tt-type" id="ttType"></div>
    </div>

    <!-- Inspector Panel -->
    <aside class="inspector collapsed" id="inspector">
      <div class="inspector-header">
        <div class="inspector-title-row">
          <div class="inspector-icon">&#x1F4CB;</div>
          <div class="inspector-title-text">
            <h2 id="inspectorTitle">Table Inspector</h2>
            <p id="inspectorSubtitle">Select a table to inspect</p>
          </div>
          <button class="inspector-close" onclick="closeInspector()" title="Close">&#x2715;</button>
        </div>
        <div class="inspector-meta-pills" id="inspectorPills"></div>
      </div>
      <div class="inspector-tabs">
        <div class="inspector-tab active" data-tab="overview" onclick="switchInspectorTab(this,'overview')">Overview</div>
        <div class="inspector-tab" data-tab="fields" onclick="switchInspectorTab(this,'fields')">Fields <span class="tab-count" id="tabCountFields">0</span></div>
        <div class="inspector-tab" data-tab="uipolicies" onclick="switchInspectorTab(this,'uipolicies')">UI Policies <span class="tab-count" id="tabCountUIPolicies">0</span></div>
        <div class="inspector-tab" data-tab="bizrules" onclick="switchInspectorTab(this,'bizrules')">Business Rules <span class="tab-count" id="tabCountBizRules">0</span></div>
        <div class="inspector-tab" data-tab="scriptincludes" onclick="switchInspectorTab(this,'scriptincludes')">Script Includes <span class="tab-count" id="tabCountScriptIncludes">0</span></div>
        <div class="inspector-tab" data-tab="flows" onclick="switchInspectorTab(this,'flows')">Flows <span class="tab-count" id="tabCountFlows">0</span></div>
      </div>
      <div class="inspector-body" id="inspectorBody">
        <div class="inspector-loading" id="inspectorLoading" style="display:none">
          <div class="big-spinner"></div>
          <span>Fetching table details&hellip;</span>
        </div>
        <div id="tabContent"></div>
      </div>
    </aside>

  </div>

  <script>
    var network = null;
    var visNodes = null;
    var visEdges = null;
    var currentScheme = null;
    var currentAnalysis = null;
    var physicsEnabled = true;
    var warningTimer = null;
    var activeFilter = 'all';
    var searchQuery = '';
    var highlightedNode = null;
    var ctxTargetNode = null;
    var allNodeData = {};
    var allEdgeData = [];

    /* ── Tab switching ── */
    function switchTab(name) {
      ['connect','tables','detail'].forEach(function(t) {
        document.getElementById('tab-' + t).classList.toggle('active', t === name);
        document.getElementById('panel-' + t).classList.toggle('active', t === name);
      });
    }

    /* ── Table type classification ── */
    function getTableType(name) {
      if (!name) return 'core';
      if (name.startsWith('u_') || name.startsWith('x_')) return 'custom';
      if (name.startsWith('sys_')) return 'system';
      var corePatterns = ['task','incident','problem','change_request','sc_','cmdb','hr_','sn_','kb_','alm_','ast_','em_','itsm_','itom_','itbm_','grc_','sec_','csm_','catalog_'];
      for (var i = 0; i < corePatterns.length; i++) {
        if (name.startsWith(corePatterns[i])) return 'core';
      }
      return 'extended';
    }

    function getTypeColor(type) {
      return { core:'#3b82f6', custom:'#10b981', extended:'#f59e0b', system:'#8b5cf6' }[type] || '#6366f1';
    }
    function getTypeBgColor(type) {
      return { core:'rgba(59,130,246,0.14)', custom:'rgba(16,185,129,0.14)', extended:'rgba(245,158,11,0.14)', system:'rgba(139,92,246,0.14)' }[type] || 'rgba(99,102,241,0.14)';
    }
    function getTypeBadgeClass(type) {
      return { core:'badge-core', custom:'badge-custom', extended:'badge-extended', system:'badge-system' }[type] || 'badge-fields';
    }

    /* ── Status helpers ── */
    function setStatus(type, icon, msg) {
      var el = document.getElementById('statusBanner');
      el.className = 'status-banner show ' + type;
      el.innerHTML = '<span class="status-icon">' + icon + '</span><span>' + msg + '</span>';
    }
    function clearStatus() {
      var el = document.getElementById('statusBanner');
      el.className = 'status-banner'; el.innerHTML = '';
    }

    function setLoading(loading) {
      var btn = document.getElementById('generateBtn');
      var icon = document.getElementById('btnIcon');
      var label = document.getElementById('btnLabel');
      if (loading) {
        btn.disabled = true;
        icon.outerHTML = '<span id="btnIcon" class="spinner"></span>';
        label.textContent = 'Generating\u2026';
      } else {
        btn.disabled = false;
        icon.outerHTML = '<span id="btnIcon">&#x25B6;</span>';
        label.textContent = 'Generate ERD';
      }
    }

    /* ── Generate ── */
    async function generateScheme() {
      var instance = document.getElementById('instance').value.trim();
      var username = document.getElementById('username').value.trim();
      var password = document.getElementById('password').value;
      var tableLimit = parseInt(document.getElementById('tableLimit').value) || 50;

      if (!instance || !username || !password) {
        setStatus('error', '&#x26A0;', 'Please fill in all connection fields.');
        return;
      }

      instance = instance.replace(/^https?:\\/\\//i, '');
      instance = instance.replace(/\\.service-now\\.com.*/i, '').replace(/\\/.*$/, '').trim();

      if (!instance || !/^[a-zA-Z0-9-]+$/.test(instance)) {
        setStatus('error', '&#x26A0;', 'Invalid instance name. Enter only the identifier (e.g. "dev12345"), not a full URL.');
        return;
      }

      setLoading(true);
      setStatus('loading', '&#x23F3;', 'Connecting to ' + instance + '.service-now.com\u2026');

      warningTimer = setTimeout(function() {
        setStatus('loading', '&#x23F3;', 'Still working\u2026 Large schemas can take up to 2 minutes. Consider reducing the table limit.');
      }, 30000);

      try {
        var response = await fetch('/api/scheme/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ instance: instance, username: username, password: password, tableLimit: tableLimit })
        });

        clearTimeout(warningTimer);
        var data = await response.json();

        if (!response.ok) throw new Error(data.error || 'Request failed with status ' + response.status);
        if (!data.schemeMap || !data.summary) throw new Error('Server returned an incomplete response. Please try again.');

        currentScheme = data.schemeMap;
        currentAnalysis = data.analysis;

        document.getElementById('statTables').textContent = data.summary.totalTables || 0;
        document.getElementById('statFields').textContent = data.summary.totalFields || 0;
        document.getElementById('statRelationships').textContent = data.summary.totalRelationships || 0;
        document.getElementById('statHierarchies').textContent = data.summary.inheritanceHierarchies || 0;

        var cx = (data.analysis && data.analysis.complexityScore != null) ? data.analysis.complexityScore : 0;
        var qx = (data.analysis && data.analysis.dataQualityScore != null) ? data.analysis.dataQualityScore : 0;
        document.getElementById('complexityFill').style.width = cx + '%';
        document.getElementById('complexityValue').textContent = cx + ' / 100';
        document.getElementById('qualityFill').style.width = qx + '%';
        document.getElementById('qualityValue').textContent = qx + ' / 100';

        var insightsList = document.getElementById('insightsList');
        insightsList.innerHTML = '';
        if (data.insights && data.insights.length > 0) {
          data.insights.forEach(function(ins) {
            var div = document.createElement('div');
            div.className = 'insight-item ' + (ins.type || 'info');
            var iconChar = ins.type === 'warning' ? '&#x26A0;' : '&#x2139;';
            div.innerHTML = '<span class="insight-icon">' + iconChar + '</span><span>' + ins.message + '</span>';
            insightsList.appendChild(div);
          });
        }

        document.getElementById('resultsSection').classList.remove('hidden');
        visualizeScheme(data.schemeMap);
        populateTableList(data.schemeMap);

        var t = data.summary.totalTables || 0;
        var r = data.summary.totalRelationships || 0;
        setStatus('success', '&#x2713;', 'Loaded ' + t + ' tables and ' + r + ' relationships.');
        setLoading(false);

      } catch (err) {
        clearTimeout(warningTimer);
        setStatus('error', '&#x2715;', err.message || 'An unexpected error occurred.');
        setLoading(false);
      }
    }

    /* ── Node sizing by field count ── */
    function getNodeMargin(fieldCount) {
      if (fieldCount > 40) return { top:12, bottom:12, left:18, right:18 };
      if (fieldCount > 20) return { top:10, bottom:10, left:15, right:15 };
      return { top:8, bottom:8, left:12, right:12 };
    }

    /* ── Visualize ── */
    function visualizeScheme(scheme) {
      var nodes = [];
      var edges = [];
      allNodeData = {};
      allEdgeData = [];

      Object.keys(scheme.tables).forEach(function(name) {
        var table = scheme.tables[name];
        var fieldCount = (scheme.fields[name] || []).length;
        var type = getTableType(name);
        var borderColor = getTypeColor(type);
        var bgColor = getTypeBgColor(type);
        var relCount = (scheme.relationships || []).filter(function(r) { return r.from === name || r.to === name; }).length;

        nodes.push({
          id: name,
          label: (table.label || name),
          color: {
            background: bgColor,
            border: borderColor,
            highlight: { background: bgColor, border: '#ffffff' },
            hover: { background: bgColor, border: '#ffffff' }
          },
          font: { color: '#e2e8f0', size: 12, face: 'Inter, Segoe UI, sans-serif' },
          borderWidth: 1.5,
          borderWidthSelected: 3,
          shape: 'box',
          margin: getNodeMargin(fieldCount),
          shadow: { enabled: true, color: borderColor + '44', size: 8, x: 0, y: 2 }
        });
        allNodeData[name] = { table: table, fieldCount: fieldCount, type: type, relCount: relCount };
      });

      (scheme.relationships || []).forEach(function(rel) {
        var edgeId = rel.id || (rel.from + '__' + rel.to + '__' + (rel.field || ''));
        var edgeData = {
          id: edgeId,
          from: rel.from,
          to: rel.to,
          label: rel.field || '',
          arrows: { to: { enabled: true, scaleFactor: 0.6 } },
          color: {
            color: rel.mandatory ? 'rgba(239,68,68,0.7)' : 'rgba(71,85,105,0.55)',
            highlight: '#6366f1',
            hover: '#818cf8'
          },
          font: { size: 9, color: '#4e5a72', face: 'Inter, Segoe UI, sans-serif', strokeWidth: 0 },
          width: rel.mandatory ? 2 : 1,
          smooth: { type: 'curvedCW', roundness: 0.12 },
          relType: rel.mandatory ? 'mandatory' : 'optional'
        };
        edges.push(edgeData);
        allEdgeData.push(edgeData);
      });

      document.getElementById('emptyState').classList.add('hidden');
      var container = document.getElementById('network');
      container.classList.remove('hidden');
      document.getElementById('shortcutHint').style.display = 'flex';

      visNodes = new vis.DataSet(nodes);
      visEdges = new vis.DataSet(edges);

      var options = {
        physics: {
          enabled: true,
          barnesHut: {
            gravitationalConstant: -10000,
            centralGravity: 0.25,
            springLength: 200,
            springConstant: 0.04,
            damping: 0.12
          },
          stabilization: { iterations: 400, updateInterval: 20, fit: true }
        },
        interaction: {
          navigationButtons: false,
          keyboard: { enabled: true, bindToWindow: false },
          hover: true,
          tooltipDelay: 99999,
          multiselect: false
        },
        layout: { improvedLayout: true }
      };

      if (network) { network.destroy(); }
      network = new vis.Network(container, { nodes: visNodes, edges: visEdges }, options);
      physicsEnabled = true;

      /* Hover: tooltip */
      network.on('hoverNode', function(params) { showNodeTooltip(params.node, params.event); });
      network.on('blurNode', function() { hideNodeTooltip(); });

      /* Click: highlight + detail + inspector */
      network.on('click', function(params) {
        hideCtxMenu();
        if (params.nodes.length > 0) {
          var n = params.nodes[0];
          highlightRelated(n);
          showTableDetail(n);
          switchTab('detail');
          openInspector(n);
        } else {
          clearHighlight();
        }
      });

      /* Double-click: zoom */
      network.on('doubleClick', function(params) {
        if (params.nodes.length > 0) {
          network.focus(params.nodes[0], { scale: 2, animation: { duration: 500, easingFunction: 'easeInOutQuad' } });
        }
      });

      /* Right-click: context menu */
      network.on('oncontext', function(params) {
        params.event.preventDefault();
        var nodeId = network.getNodeAt(params.pointer.DOM);
        if (nodeId) {
          ctxTargetNode = nodeId;
          showCtxMenu(params.event.clientX, params.event.clientY);
        }
      });

      document.getElementById('canvasTitle').textContent = scheme.instance + ' \u2014 ' + nodes.length + ' tables';
      document.getElementById('canvasLegend').style.display = 'flex';
      document.getElementById('fitBtn').style.display = '';
      document.getElementById('physicsBtn').style.display = '';
    }

    /* ── Highlight related nodes ── */
    function highlightRelated(nodeName) {
      if (!visNodes || !visEdges) return;
      highlightedNode = nodeName;
      document.getElementById('highlightBtn').style.display = '';

      var connectedNodes = new Set([nodeName]);
      var connectedEdges = new Set();
      allEdgeData.forEach(function(e) {
        if (e.from === nodeName || e.to === nodeName) {
          connectedNodes.add(e.from);
          connectedNodes.add(e.to);
          connectedEdges.add(e.id);
        }
      });

      var nodeUpdates = [];
      visNodes.getIds().forEach(function(id) {
        var nd = allNodeData[id];
        if (!nd) return;
        var isConnected = connectedNodes.has(id);
        var isFocus = id === nodeName;
        nodeUpdates.push({
          id: id,
          color: {
            background: isConnected ? getTypeBgColor(nd.type) : 'rgba(22,25,41,0.4)',
            border: isFocus ? '#ffffff' : (isConnected ? getTypeColor(nd.type) : 'rgba(46,50,80,0.35)'),
            highlight: { background: getTypeBgColor(nd.type), border: '#ffffff' },
            hover: { background: getTypeBgColor(nd.type), border: '#ffffff' }
          },
          font: { color: isConnected ? '#e2e8f0' : '#252a40', size: 12, face: 'Inter, Segoe UI, sans-serif' },
          borderWidth: isFocus ? 3 : (isConnected ? 1.5 : 1)
        });
      });
      visNodes.update(nodeUpdates);

      var edgeUpdates = [];
      visEdges.getIds().forEach(function(id) {
        var isConnected = connectedEdges.has(id);
        var orig = allEdgeData.find(function(e) { return e.id === id; });
        edgeUpdates.push({
          id: id,
          color: {
            color: isConnected ? (orig && orig.relType === 'mandatory' ? 'rgba(239,68,68,0.9)' : 'rgba(99,102,241,0.7)') : 'rgba(46,50,80,0.12)',
            highlight: '#6366f1', hover: '#818cf8'
          },
          width: isConnected ? (orig && orig.relType === 'mandatory' ? 2.5 : 1.5) : 0.5
        });
      });
      visEdges.update(edgeUpdates);
    }

    function clearHighlight() {
      if (!visNodes || !visEdges) return;
      highlightedNode = null;
      document.getElementById('highlightBtn').style.display = 'none';

      var nodeUpdates = [];
      visNodes.getIds().forEach(function(id) {
        var nd = allNodeData[id];
        if (!nd) return;
        nodeUpdates.push({
          id: id,
          color: {
            background: getTypeBgColor(nd.type),
            border: getTypeColor(nd.type),
            highlight: { background: getTypeBgColor(nd.type), border: '#ffffff' },
            hover: { background: getTypeBgColor(nd.type), border: '#ffffff' }
          },
          font: { color: '#e2e8f0', size: 12, face: 'Inter, Segoe UI, sans-serif' },
          borderWidth: 1.5
        });
      });
      visNodes.update(nodeUpdates);

      var edgeUpdates = [];
      allEdgeData.forEach(function(e) {
        edgeUpdates.push({
          id: e.id,
          color: {
            color: e.relType === 'mandatory' ? 'rgba(239,68,68,0.7)' : 'rgba(71,85,105,0.55)',
            highlight: '#6366f1', hover: '#818cf8'
          },
          width: e.relType === 'mandatory' ? 2 : 1
        });
      });
      visEdges.update(edgeUpdates);
    }

    /* ── Hover tooltip ── */
    function showNodeTooltip(nodeId, event) {
      var nd = allNodeData[nodeId];
      if (!nd) return;
      var tt = document.getElementById('nodeTooltip');
      document.getElementById('ttName').textContent = nd.table.label || nodeId;
      document.getElementById('ttFields').textContent = nd.fieldCount;
      document.getElementById('ttRels').textContent = nd.relCount;
      document.getElementById('ttExt').textContent = nd.table.isExtendable ? 'Yes' : 'No';
      var typeLabel = nd.type.charAt(0).toUpperCase() + nd.type.slice(1);
      document.getElementById('ttType').innerHTML = '<span style="color:' + getTypeColor(nd.type) + ';font-weight:600">' + typeLabel + ' table</span>';
      var x = event.clientX + 14;
      var y = event.clientY - 10;
      if (x + 230 > window.innerWidth) x = event.clientX - 230;
      if (y + 120 > window.innerHeight) y = event.clientY - 120;
      tt.style.left = x + 'px';
      tt.style.top = y + 'px';
      tt.classList.add('visible');
    }
    function hideNodeTooltip() {
      document.getElementById('nodeTooltip').classList.remove('visible');
    }

    /* ── Context menu ── */
    function showCtxMenu(x, y) {
      var menu = document.getElementById('ctxMenu');
      menu.style.left = Math.min(x, window.innerWidth - 180) + 'px';
      menu.style.top = Math.min(y, window.innerHeight - 160) + 'px';
      menu.classList.add('visible');
    }
    function hideCtxMenu() {
      document.getElementById('ctxMenu').classList.remove('visible');
      ctxTargetNode = null;
    }
    function ctxAction(action) {
      hideCtxMenu();
      if (!ctxTargetNode && action !== 'fit') return;
      if (action === 'focus') {
        network.focus(ctxTargetNode, { scale: 2, animation: { duration: 500, easingFunction: 'easeInOutQuad' } });
      } else if (action === 'highlight') {
        highlightRelated(ctxTargetNode);
        showTableDetail(ctxTargetNode);
        switchTab('detail');
      } else if (action === 'detail') {
        showTableDetail(ctxTargetNode);
        switchTab('detail');
      } else if (action === 'fit') {
        fitNetwork();
      }
    }

    /* ── Table detail panel ── */
    function showTableDetail(name) {
      if (!currentScheme) return;
      var table = currentScheme.tables[name];
      if (!table) return;
      var fields = currentScheme.fields[name] || [];
      var type = getTableType(name);
      var typeLabel = type.charAt(0).toUpperCase() + type.slice(1);
      var rels = (currentScheme.relationships || []).filter(function(r) { return r.from === name || r.to === name; });
      var outgoing = rels.filter(function(r) { return r.from === name; });
      var incoming = rels.filter(function(r) { return r.to === name; });
      var mandatoryFields = fields.filter(function(f) { return f.mandatory; }).length;

      var html = '';
      html += '<div class="detail-table-name">' + (table.label || name) + '</div>';
      html += '<div class="detail-table-label">' + name + '</div>';
      html += '<div class="detail-badges">';
      html += '<span class="badge ' + getTypeBadgeClass(type) + '">' + typeLabel + '</span>';
      if (table.isExtendable) html += '<span class="badge badge-fields">Extendable</span>';
      if (table.superClass) html += '<span class="badge badge-system">Extends: ' + table.superClass + '</span>';
      html += '</div>';

      html += '<div class="detail-stats">';
      html += '<div class="detail-stat"><div class="ds-val">' + fields.length + '</div><div class="ds-lbl">Fields</div></div>';
      html += '<div class="detail-stat"><div class="ds-val">' + rels.length + '</div><div class="ds-lbl">Relations</div></div>';
      html += '<div class="detail-stat"><div class="ds-val">' + mandatoryFields + '</div><div class="ds-lbl">Required</div></div>';
      html += '</div>';

      if (outgoing.length > 0) {
        html += '<div class="detail-section-title">References (' + outgoing.length + ')</div>';
        html += '<div class="detail-rel-list">';
        outgoing.slice(0, 8).forEach(function(r) {
          html += '<div class="detail-rel-item" onclick="focusAndHighlight(\\'' + r.to + '\\')">';
          html += '<div class="' + (r.mandatory ? 'detail-rel-mandatory' : 'detail-rel-optional') + '"></div>';
          html += '<span class="detail-rel-arrow">&rarr;</span>';
          html += '<span class="detail-rel-table">' + r.to + '</span>';
          html += '<span class="detail-rel-field">' + (r.field || '') + '</span>';
          html += '</div>';
        });
        if (outgoing.length > 8) html += '<div style="font-size:11px;color:var(--text-muted);padding:4px 9px">+' + (outgoing.length - 8) + ' more</div>';
        html += '</div>';
      }

      if (incoming.length > 0) {
        html += '<div class="detail-section-title">Referenced by (' + incoming.length + ')</div>';
        html += '<div class="detail-rel-list">';
        incoming.slice(0, 8).forEach(function(r) {
          html += '<div class="detail-rel-item" onclick="focusAndHighlight(\\'' + r.from + '\\')">';
          html += '<div class="' + (r.mandatory ? 'detail-rel-mandatory' : 'detail-rel-optional') + '"></div>';
          html += '<span class="detail-rel-arrow">&larr;</span>';
          html += '<span class="detail-rel-table">' + r.from + '</span>';
          html += '<span class="detail-rel-field">' + (r.field || '') + '</span>';
          html += '</div>';
        });
        if (incoming.length > 8) html += '<div style="font-size:11px;color:var(--text-muted);padding:4px 9px">+' + (incoming.length - 8) + ' more</div>';
        html += '</div>';
      }

      if (fields.length > 0) {
        html += '<div class="detail-section-title">Fields (' + fields.length + ')</div>';
        html += '<div class="detail-field-list">';
        fields.slice(0, 30).forEach(function(f) {
          html += '<div class="detail-field-item">';
          html += '<span class="detail-field-name">' + (f.name || '') + '</span>';
          html += '<span class="detail-field-type">' + (f.type || '') + '</span>';
          if (f.mandatory) html += '<span class="detail-field-mandatory">REQ</span>';
          html += '</div>';
        });
        if (fields.length > 30) html += '<div style="font-size:11px;color:var(--text-muted);padding:4px 8px">+' + (fields.length - 30) + ' more fields</div>';
        html += '</div>';
      }

      html += '<div class="detail-actions">';
      html += '<button class="btn btn-ghost" onclick="focusAndHighlight(\\'' + name + '\\')" style="flex:1">&#x2728; Highlight</button>';
      html += '<button class="btn btn-ghost" onclick="if(network){network.focus(\\'' + name + '\\',{scale:2,animation:{duration:500,easingFunction:\\'easeInOutQuad\\'}})}" style="flex:1">&#x1F3AF; Focus</button>';
      html += '</div>';

      document.getElementById('detailContent').innerHTML = html;
    }

    function focusAndHighlight(name) {
      if (!network) return;
      highlightRelated(name);
      showTableDetail(name);
      network.focus(name, { scale: 1.5, animation: { duration: 500, easingFunction: 'easeInOutQuad' } });
      switchTab('detail');
    }

    /* ── Table list ── */
    function populateTableList(scheme) {
      activeFilter = 'all';
      searchQuery = '';
      document.getElementById('tableSearch').value = '';
      document.getElementById('searchClear').classList.remove('visible');
      renderTableList();
    }

    function renderTableList() {
      if (!currentScheme) return;
      var list = document.getElementById('tableList');
      list.innerHTML = '';
      var q = searchQuery.toLowerCase().trim();
      var matched = 0;
      var total = 0;

      Object.keys(currentScheme.tables).forEach(function(name) {
        var table = currentScheme.tables[name];
        var fieldCount = (currentScheme.fields[name] || []).length;
        var type = getTableType(name);
        total++;

        if (activeFilter !== 'all' && type !== activeFilter) return;

        var labelLower = (table.label || '').toLowerCase();
        var nameLower = name.toLowerCase();
        if (q && !nameLower.includes(q) && !labelLower.includes(q)) return;

        matched++;
        var card = document.createElement('div');
        card.className = 'table-card' + (q ? ' search-match' : '');
        if (highlightedNode === name) card.classList.add('highlighted');

        var displayLabel = table.label || name;
        var displayName = name;
        if (q) {
          displayLabel = highlightMatch(displayLabel, q);
          displayName = highlightMatch(displayName, q);
        }

        var relCount = (currentScheme.relationships || []).filter(function(r) { return r.from === name || r.to === name; }).length;

        card.innerHTML =
          '<div class="table-type-dot" style="background:' + getTypeColor(type) + '"></div>' +
          '<div class="table-info">' +
            '<div class="table-name">' + displayLabel + '</div>' +
            '<div class="table-meta">' + displayName + (relCount > 0 ? ' &bull; ' + relCount + ' rels' : '') + '</div>' +
          '</div>' +
          '<div class="table-badges">' +
            '<span class="badge ' + getTypeBadgeClass(type) + '">' + type + '</span>' +
            '<span class="badge badge-fields">' + fieldCount + ' f</span>' +
          '</div>';

        (function(n) {
          card.onclick = function() {
            if (network) {
              network.focus(n, { scale: 1.5, animation: { duration: 500, easingFunction: 'easeInOutQuad' } });
              highlightRelated(n);
              showTableDetail(n);
              switchTab('detail');
            }
          };
        })(name);

        list.appendChild(card);
      });

      var meta = document.getElementById('searchMeta');
      if (q || activeFilter !== 'all') {
        meta.innerHTML = '<span class="match-count">' + matched + '</span> of ' + total + ' tables';
      } else {
        meta.innerHTML = total + ' tables total';
      }

      if (matched === 0) {
        list.innerHTML = '<div class="no-results"><div class="no-results-icon">&#x1F50D;</div>No tables match your search.</div>';
      }
    }

    function highlightMatch(text, q) {
      var idx = text.toLowerCase().indexOf(q);
      if (idx === -1) return text;
      return text.slice(0, idx) + '<em>' + text.slice(idx, idx + q.length) + '</em>' + text.slice(idx + q.length);
    }

    /* ── Search & filter ── */
    function onSearchInput() {
      searchQuery = document.getElementById('tableSearch').value;
      document.getElementById('searchClear').classList.toggle('visible', searchQuery.length > 0);
      renderTableList();
    }

    function clearSearch() {
      searchQuery = '';
      document.getElementById('tableSearch').value = '';
      document.getElementById('searchClear').classList.remove('visible');
      renderTableList();
      document.getElementById('tableSearch').focus();
    }

    function setFilter(type) {
      activeFilter = type;
      ['all','core','custom','extended','system'].forEach(function(t) {
        var chip = document.getElementById('chip-' + t);
        if (chip) chip.classList.toggle('active', t === type);
      });
      renderTableList();
    }

    /* ── Network controls ── */
    function fitNetwork() {
      if (network) { network.fit({ animation: { duration: 600, easingFunction: 'easeInOutQuad' } }); }
    }

    function togglePhysics() {
      if (!network) return;
      physicsEnabled = !physicsEnabled;
      network.setOptions({ physics: { enabled: physicsEnabled } });
      document.getElementById('physicsBtn').textContent = physicsEnabled ? '\u23F8 Pause' : '\u25B6 Resume';
      document.getElementById('physicsBtn').classList.toggle('active', !physicsEnabled);
    }

    /* ── Export ── */
    function exportJSON() {
      if (!currentScheme) return;
      var blob = new Blob([JSON.stringify(currentScheme, null, 2)], { type: 'application/json' });
      triggerDownload(URL.createObjectURL(blob), 'scheme-map.json');
    }
    function exportGraphQL() {
      fetch('/api/scheme/export/graphql').then(function(r) { return r.text(); }).then(function(text) {
        triggerDownload(URL.createObjectURL(new Blob([text], { type: 'text/plain' })), 'schema.graphql');
      });
    }
    function exportReport() {
      triggerDownload('/api/scheme/export/report', 'schema-analysis-report.html');
    }
    function triggerDownload(url, filename) {
      var a = document.createElement('a');
      a.href = url; a.download = filename; a.click();
    }

    /* ── Global keyboard shortcuts ── */
    document.addEventListener('click', function(e) {
      if (!document.getElementById('ctxMenu').contains(e.target)) hideCtxMenu();
    });
    document.addEventListener('contextmenu', function(e) {
      if (!document.getElementById('network').contains(e.target)) hideCtxMenu();
    });
    document.addEventListener('keydown', function(e) {
      if ((e.key === 'Enter') && (e.ctrlKey || e.metaKey)) {
        generateScheme();
      } else if (e.key === 'f' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        switchTab('tables');
        setTimeout(function() { document.getElementById('tableSearch').focus(); }, 50);
      } else if (e.key === 'Escape') {
        clearHighlight();
        hideCtxMenu();
      }
    });

    // ── Inspector ──
    var inspectorData = null;
    var activeInspectorTab = 'overview';
    var inspectorTableName = null;

    function openInspector(tableName) {
      inspectorTableName = tableName;
      document.getElementById('inspector').classList.remove('collapsed');
      document.getElementById('inspectorTitle').textContent = tableName;
      document.getElementById('inspectorSubtitle').textContent = 'Loading details\u2026';
      document.getElementById('inspectorPills').innerHTML = '';
      document.getElementById('inspectorLoading').style.display = 'flex';
      document.getElementById('tabContent').innerHTML = '';
      switchInspectorTab(document.querySelector('.inspector-tab[data-tab="overview"]'), 'overview');
      fetchInspectorData(tableName);
    }

    function closeInspector() {
      document.getElementById('inspector').classList.add('collapsed');
      inspectorData = null;
      inspectorTableName = null;
    }

    async function fetchInspectorData(tableName) {
      try {
        var resp = await fetch('/api/scheme/table/' + encodeURIComponent(tableName) + '/details');
        var data = await resp.json();
        if (!resp.ok) throw new Error(data.error || 'Failed to load details');
        inspectorData = data;
        document.getElementById('inspectorLoading').style.display = 'none';
        renderInspectorHeader(data);
        renderInspectorTab(activeInspectorTab);
      } catch(err) {
        document.getElementById('inspectorLoading').style.display = 'none';
        document.getElementById('tabContent').innerHTML =
          '<div class="inspector-empty"><div class="empty-emoji">&#x26A0;</div><span>' + iEsc(err.message) + '</span></div>';
      }
    }

    function renderInspectorHeader(data) {
      var t = data.table || {};
      document.getElementById('inspectorTitle').textContent = t.label || inspectorTableName;
      document.getElementById('inspectorSubtitle').textContent = inspectorTableName;
      var pills = document.getElementById('inspectorPills');
      var fc = (data.fields || []).length;
      var br = (data.businessRules || []).length;
      var ui = (data.uiPolicies || []).length;
      var fl = (data.flows || []).length;
      var si = (data.scriptIncludes || []).length;
      pills.innerHTML =
        '<span class="meta-pill accent">' + fc + ' fields</span>' +
        (t.isExtendable ? '<span class="meta-pill success">Extendable</span>' : '') +
        (t.superClass ? '<span class="meta-pill muted">extends ' + iEsc(t.superClass) + '</span>' : '') +
        (br ? '<span class="meta-pill warning">' + br + ' rules</span>' : '') +
        (fl ? '<span class="meta-pill accent">' + fl + ' flows</span>' : '');
      document.getElementById('tabCountFields').textContent = fc;
      document.getElementById('tabCountUIPolicies').textContent = ui;
      document.getElementById('tabCountBizRules').textContent = br;
      document.getElementById('tabCountScriptIncludes').textContent = si;
      document.getElementById('tabCountFlows').textContent = fl;
    }

    function switchInspectorTab(el, tab) {
      activeInspectorTab = tab;
      document.querySelectorAll('.inspector-tab').forEach(function(t) { t.classList.remove('active'); });
      if (el) el.classList.add('active');
      if (inspectorData) renderInspectorTab(tab);
    }

    function renderInspectorTab(tab) {
      var c = document.getElementById('tabContent');
      if (!inspectorData) { c.innerHTML = ''; return; }
      if (tab === 'overview') iRenderOverview(c);
      else if (tab === 'fields') iRenderFields(c);
      else if (tab === 'uipolicies') iRenderUIPolicies(c);
      else if (tab === 'bizrules') iRenderBizRules(c);
      else if (tab === 'scriptincludes') iRenderScriptIncludes(c);
      else if (tab === 'flows') iRenderFlows(c);
    }

    function iRenderOverview(c) {
      var d = inspectorData;
      var t = d.table || {};
      var m = d.metrics || {};
      var dep = d.dependencies || { incoming: [], outgoing: [] };
      var fc = (d.fields || []).length;
      var mf = (d.fields || []).filter(function(f){ return f.mandatory; }).length;
      var rf = (d.fields || []).filter(function(f){ return f.reference; }).length;
      var html = '<div class="overview-grid">';
      html += iOvCard(fc, 'Fields', mf + ' mandatory');
      html += iOvCard((d.businessRules||[]).length, 'Business Rules', (d.businessRules||[]).filter(function(r){return r.active;}).length + ' active');
      html += iOvCard((d.uiPolicies||[]).length, 'UI Policies', (d.uiPolicies||[]).filter(function(p){return p.active;}).length + ' active');
      html += iOvCard((d.flows||[]).length, 'Flows', (d.flows||[]).filter(function(f){return f.active;}).length + ' active');
      html += iOvCard(rf, 'Ref Fields', 'foreign keys');
      html += iOvCard((d.scriptIncludes||[]).length, 'Script Includes', 'referenced');
      html += '</div>';
      if (m.complexity != null) {
        html += '<div class="rule-field"><div class="rule-field-label">Complexity Score</div>';
        html += '<div style="height:5px;background:var(--border);border-radius:99px;overflow:hidden;margin-top:4px">';
        html += '<div style="height:100%;width:' + Math.min(m.complexity, 100) + '%;background:linear-gradient(90deg,var(--accent),#818cf8);border-radius:99px"></div></div></div>';
      }
      if (t.superClass) {
        html += '<div class="rule-field"><div class="rule-field-label">Extends</div>';
        html += '<div class="rule-field-value"><span class="dep-chip outgoing" onclick="openInspector(\'' + iEsc(t.superClass) + '\')">' +
          '<span class="dep-dot"></span>' + iEsc(t.superClass) + '</span></div></div>';
      }
      if (dep.incoming && dep.incoming.length) {
        html += '<div class="dep-section"><div class="dep-section-title">Referenced by (' + dep.incoming.length + ')</div><div>';
        dep.incoming.slice(0,20).forEach(function(r) {
          html += '<span class="dep-chip incoming" onclick="openInspector(\'' + iEsc(r.table) + '\')">' +
            '<span class="dep-dot"></span>' + iEsc(r.table) + '</span>';
        });
        html += '</div></div>';
      }
      if (dep.outgoing && dep.outgoing.length) {
        html += '<div class="dep-section"><div class="dep-section-title">References (' + dep.outgoing.length + ')</div><div>';
        dep.outgoing.slice(0,20).forEach(function(r) {
          html += '<span class="dep-chip outgoing" onclick="openInspector(\'' + iEsc(r.table) + '\')">' +
            '<span class="dep-dot"></span>' + iEsc(r.table) + '</span>';
        });
        html += '</div></div>';
      }
      c.innerHTML = html;
    }

    function iOvCard(val, label, sub) {
      return '<div class="overview-card"><div class="ov-label">' + label + '</div><div class="ov-value">' + val + '</div><div class="ov-sub">' + sub + '</div></div>';
    }

    function iRenderFields(c) {
      var fields = (inspectorData.fields || []).slice();
      c.innerHTML = '<div class="inspector-search"><span class="search-icon">&#x1F50D;</span><input type="text" placeholder="Filter fields\u2026" oninput="iFilterFields(this)"></div><div id="fieldTableWrap"></div>';
      iRenderFieldTable(fields, document.getElementById('fieldTableWrap'), '');
    }

    function iFilterFields(input) {
      iRenderFieldTable(inspectorData.fields || [], document.getElementById('fieldTableWrap'), input.value.toLowerCase());
    }

    function iRenderFieldTable(fields, wrap, q) {
      var filtered = q ? fields.filter(function(f) {
        return (f.name||'').toLowerCase().includes(q) || (f.label||'').toLowerCase().includes(q) || (f.type||'').toLowerCase().includes(q);
      }) : fields;
      if (!filtered.length) { wrap.innerHTML = '<div class="inspector-empty"><div class="empty-emoji">&#x1F50D;</div><span>No fields match</span></div>'; return; }
      var isScript = function(t) { return t && (t.includes('script') || t === 'xml'); };
      var isRef = function(t) { return t === 'reference'; };
      var html = '<table class="field-table"><thead><tr><th>Field</th><th>Label</th><th>Type</th><th>Ref</th><th title="Mandatory">M</th><th title="Read Only">RO</th></tr></thead><tbody>';
      filtered.forEach(function(f) {
        var tc = isRef(f.type) ? ' ref' : isScript(f.type) ? ' script' : '';
        html += '<tr>';
        html += '<td><div class="field-name-cell"><span class="field-name-text">' + iEsc(f.name||'') + '</span>';
        html += '<button class="copy-btn" onclick="iCopyText(\'' + iEsc(f.name||'') + '\',this)" title="Copy field name">&#x2398;</button></div></td>';
        html += '<td>' + iEsc(f.label||'\u2014') + '</td>';
        html += '<td><span class="type-badge' + tc + '">' + iEsc(f.type||'\u2014') + '</span></td>';
        html += '<td>' + (f.reference ? '<span class="type-badge ref">' + iEsc(f.reference) + '</span>' : '\u2014') + '</td>';
        html += '<td><span class="bool-dot ' + (f.mandatory ? 'yes' : 'no') + '"></span></td>';
        html += '<td><span class="bool-dot ' + (f.readOnly ? 'yes' : 'no') + '"></span></td>';
        html += '</tr>';
      });
      html += '</tbody></table>';
      wrap.innerHTML = html;
    }

    function iRenderUIPolicies(c) {
      var policies = inspectorData.uiPolicies || [];
      var actions = inspectorData.uiPolicyActions || [];
      if (!policies.length) { c.innerHTML = iEmptyState('&#x1F6AB;', 'No UI Policies found for this table'); return; }
      c.innerHTML = '<div class="inspector-search"><span class="search-icon">&#x1F50D;</span><input type="text" placeholder="Filter policies\u2026" oninput="iFilterCards(this,\'uiPolicyCards\')"></div><div id="uiPolicyCards"></div>';
      var wrap = document.getElementById('uiPolicyCards');
      var html = '';
      policies.forEach(function(p) {
        var pActions = actions.filter(function(a){ return a.uiPolicyId === p.sysId; });
        html += '<div class="rule-card" data-search="' + iEsc(((p.name||'')+' '+(p.description||'')).toLowerCase()) + '">';
        html += '<div class="rule-card-header" onclick="iToggleCard(this.parentElement)">';
        html += '<span class="meta-pill ' + (p.active ? 'success' : 'muted') + '">' + (p.active ? 'Active' : 'Inactive') + '</span>';
        html += '<span class="rule-name">' + iEsc(p.name||'Unnamed') + '</span>';
        if (pActions.length) html += '<span class="meta-pill accent">' + pActions.length + ' actions</span>';
        html += '<span class="rule-chevron">&#x25B6;</span></div>';
        html += '<div class="rule-card-body">';
        html += '<div class="rule-meta-row">';
        if (p.description) html += '<span class="meta-pill muted">' + iEsc(p.description) + '</span>';
        if (p.runScripts) html += '<span class="meta-pill warning">Runs Scripts</span>';
        html += '</div>';
        if (p.conditions) html += '<div class="rule-field"><div class="rule-field-label">Condition</div><div class="rule-field-value">' + iEsc(p.conditions) + '</div></div>';
        if (pActions.length) {
          html += '<div class="rule-field"><div class="rule-field-label">Field Actions</div>';
          html += '<table class="field-table"><thead><tr><th>Field</th><th>Mandatory</th><th>Visible</th><th>Read Only</th></tr></thead><tbody>';
          pActions.forEach(function(a) {
            html += '<tr><td><span class="field-name-text">' + iEsc(a.field||'\u2014') + '</span></td>';
            html += '<td>' + iFmtTriState(a.mandatory) + '</td><td>' + iFmtTriState(a.visible) + '</td><td>' + iFmtTriState(a.readOnly) + '</td></tr>';
          });
          html += '</tbody></table></div>';
        }
        if (p.scriptTrue) html += '<div class="rule-field"><div class="rule-field-label">Script (True)</div>' + iCodeBlock(p.scriptTrue) + '</div>';
        if (p.scriptFalse) html += '<div class="rule-field"><div class="rule-field-label">Script (False)</div>' + iCodeBlock(p.scriptFalse) + '</div>';
        html += '</div></div>';
      });
      wrap.innerHTML = html;
    }

    function iRenderBizRules(c) {
      var rules = inspectorData.businessRules || [];
      if (!rules.length) { c.innerHTML = iEmptyState('&#x1F6AB;', 'No Business Rules found for this table'); return; }
      c.innerHTML = '<div class="inspector-search"><span class="search-icon">&#x1F50D;</span><input type="text" placeholder="Filter rules\u2026" oninput="iFilterCards(this,\'bizRuleCards\')"></div><div id="bizRuleCards"></div>';
      var wrap = document.getElementById('bizRuleCards');
      var html = '';
      rules.forEach(function(r) {
        html += '<div class="rule-card" data-search="' + iEsc(((r.name||'')+' '+(r.when||'')).toLowerCase()) + '">';
        html += '<div class="rule-card-header" onclick="iToggleCard(this.parentElement)">';
        html += '<span class="meta-pill ' + (r.active ? 'success' : 'muted') + '">' + (r.active ? 'Active' : 'Inactive') + '</span>';
        html += '<span class="rule-name">' + iEsc(r.name||'Unnamed') + '</span>';
        if (r.when) html += '<span class="meta-pill accent">' + iEsc(r.when) + '</span>';
        if (r.abortAction) html += '<span class="meta-pill warning">Abort</span>';
        html += '<span class="rule-chevron">&#x25B6;</span></div>';
        html += '<div class="rule-card-body"><div class="rule-meta-row">';
        if (r.order) html += '<span class="meta-pill muted">Order: ' + iEsc(String(r.order)) + '</span>';
        if (r.addMessage) html += '<span class="meta-pill warning">Adds Message</span>';
        html += '</div>';
        if (r.filterCondition) html += '<div class="rule-field"><div class="rule-field-label">Filter Condition</div><div class="rule-field-value">' + iEsc(r.filterCondition) + '</div></div>';
        if (r.message) html += '<div class="rule-field"><div class="rule-field-label">Message</div><div class="rule-field-value">' + iEsc(r.message) + '</div></div>';
        if (r.script) html += '<div class="rule-field"><div class="rule-field-label">Script</div>' + iCodeBlock(r.script) + '</div>';
        html += '</div></div>';
      });
      wrap.innerHTML = html;
    }

    function iRenderScriptIncludes(c) {
      var includes = inspectorData.scriptIncludes || [];
      if (!includes.length) { c.innerHTML = iEmptyState('&#x1F4DC;', 'No Script Includes found'); return; }
      c.innerHTML = '<div class="inspector-search"><span class="search-icon">&#x1F50D;</span><input type="text" placeholder="Filter includes\u2026" oninput="iFilterCards(this,\'siCards\')"></div><div id="siCards"></div>';
      var wrap = document.getElementById('siCards');
      var html = '';
      includes.forEach(function(inc) {
        html += '<div class="rule-card" data-search="' + iEsc(((inc.name||'')+' '+(inc.description||'')).toLowerCase()) + '">';
        html += '<div class="rule-card-header" onclick="iToggleCard(this.parentElement)">';
        html += '<span class="meta-pill ' + (inc.active ? 'success' : 'muted') + '">' + (inc.active ? 'Active' : 'Inactive') + '</span>';
        html += '<span class="rule-name">' + iEsc(inc.name||'Unnamed') + '</span>';
        if (inc.access) html += '<span class="meta-pill muted">' + iEsc(inc.access) + '</span>';
        html += '<button class="copy-btn" style="opacity:1;margin-right:4px" onclick="event.stopPropagation();iCopyText(\'' + iEsc(inc.name||'') + '\',this)" title="Copy name">&#x2398;</button>';
        html += '<span class="rule-chevron">&#x25B6;</span></div>';
        html += '<div class="rule-card-body">';
        if (inc.description) html += '<div class="rule-field"><div class="rule-field-label">Description</div><div class="rule-field-value">' + iEsc(inc.description) + '</div></div>';
        if (inc.apiName) html += '<div class="rule-field"><div class="rule-field-label">API Name</div><div class="rule-field-value"><span class="field-name-text">' + iEsc(inc.apiName) + '</span></div></div>';
        if (inc.scope) html += '<div class="rule-field"><div class="rule-field-label">Scope</div><div class="rule-field-value">' + iEsc(inc.scope) + '</div></div>';
        if (inc.script) html += '<div class="rule-field"><div class="rule-field-label">Script</div>' + iCodeBlock(inc.script) + '</div>';
        html += '</div></div>';
      });
      wrap.innerHTML = html;
    }

    function iRenderFlows(c) {
      var flows = inspectorData.flows || [];
      if (!flows.length) { c.innerHTML = iEmptyState('&#x26A1;', 'No Flows found for this table'); return; }
      c.innerHTML = '<div class="inspector-search"><span class="search-icon">&#x1F50D;</span><input type="text" placeholder="Filter flows\u2026" oninput="iFilterCards(this,\'flowCards\')"></div><div id="flowCards"></div>';
      var wrap = document.getElementById('flowCards');
      var html = '';
      flows.forEach(function(f) {
        html += '<div class="rule-card" data-search="' + iEsc(((f.name||'')+' '+(f.description||'')).toLowerCase()) + '">';
        html += '<div class="rule-card-header" onclick="iToggleCard(this.parentElement)">';
        html += '<span class="meta-pill ' + (f.active ? 'success' : 'muted') + '">' + (f.active ? 'Active' : 'Inactive') + '</span>';
        html += '<span class="rule-name">' + iEsc(f.name||'Unnamed') + '</span>';
        if (f.triggerType) html += '<span class="meta-pill accent">' + iEsc(f.triggerType) + '</span>';
        if (f.status) html += '<span class="meta-pill muted">' + iEsc(f.status) + '</span>';
        html += '<span class="rule-chevron">&#x25B6;</span></div>';
        html += '<div class="rule-card-body">';
        if (f.description) html += '<div class="rule-field"><div class="rule-field-label">Description</div><div class="rule-field-value">' + iEsc(f.description) + '</div></div>';
        if (f.runAs) html += '<div class="rule-field"><div class="rule-field-label">Run As</div><div class="rule-field-value">' + iEsc(f.runAs) + '</div></div>';
        html += '</div></div>';
      });
      wrap.innerHTML = html;
    }

    // Inspector helpers
    function iEsc(s) {
      return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
    }
    function iEmptyState(icon, msg) {
      return '<div class="inspector-empty"><div class="empty-emoji">' + icon + '</div><span>' + msg + '</span></div>';
    }
    function iToggleCard(card) { card.classList.toggle('open'); }
    function iFilterCards(input, containerId) {
      var q = input.value.toLowerCase();
      document.getElementById(containerId).querySelectorAll('.rule-card').forEach(function(card) {
        card.style.display = (!q || (card.getAttribute('data-search')||'').includes(q)) ? '' : 'none';
      });
    }
    function iFmtTriState(val) {
      if (val === 'true' || val === true) return '<span class="bool-dot yes"></span>';
      if (val === 'false' || val === false) return '<span class="bool-dot no"></span>';
      return '<span style="color:var(--text-muted);font-size:11px">\u2014</span>';
    }
    function iCodeBlock(code) {
      var id = 'cb_' + Math.random().toString(36).slice(2);
      return '<div class="code-block" id="' + id + '">' +
        '<button class="code-copy-btn" onclick="iCopyCode(\'' + id + '\',this)">Copy</button>' +
        iSyntaxHighlight(code || '') + '</div>';
    }
    function iSyntaxHighlight(code) {
      var e = iEsc(code);
      e = e.replace(/(\/\/[^\n]*)/g, '<span class="tok-cmt">$1</span>');
      e = e.replace(/(\/\*[\s\S]*?\*\/)/g, '<span class="tok-cmt">$1</span>');
      e = e.replace(/(&#39;[^&#39;]*&#39;|&quot;[^&quot;]*&quot;)/g, '<span class="tok-str">$1</span>');
      e = e.replace(/\b(var|let|const|function|return|if|else|for|while|new|this|true|false|null|undefined|typeof|instanceof|try|catch|throw|class|extends|import|export|async|await)\b/g, '<span class="tok-kw">$1</span>');
      e = e.replace(/\b(\d+\.?\d*)\b/g, '<span class="tok-num">$1</span>');
      e = e.replace(/([a-zA-Z_$][\w$]*)(?=\s*\()/g, '<span class="tok-fn">$1</span>');
      return e;
    }
    function iCopyText(text, btn) {
      navigator.clipboard.writeText(text).then(function() {
        btn.classList.add('copied'); btn.textContent = '\u2713';
        setTimeout(function() { btn.classList.remove('copied'); btn.innerHTML = '&#x2398;'; }, 1500);
      }).catch(function() {
        var ta = document.createElement('textarea');
        ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
        btn.classList.add('copied');
        setTimeout(function() { btn.classList.remove('copied'); btn.innerHTML = '&#x2398;'; }, 1500);
      });
    }
    function iCopyCode(blockId, btn) {
      var el = document.getElementById(blockId);
      var text = el ? el.innerText.replace(/^Copy\n/, '') : '';
      navigator.clipboard.writeText(text).then(function() {
        btn.textContent = 'Copied!'; btn.classList.add('copied');
        setTimeout(function() { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 1500);
      }).catch(function() {
        var ta = document.createElement('textarea');
        ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
        btn.textContent = 'Copied!';
        setTimeout(function() { btn.textContent = 'Copy'; }, 1500);
      });
    }
  <\/script>
</body>
</html>`;
  return html;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('ServiceNow ERD Visualizer running on port ' + PORT);
});

