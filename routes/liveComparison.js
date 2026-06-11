/**
 * routes/liveComparison.js
 * Express router for live dual-instance comparison endpoints.
 * Mounts at /api/live in server.js.
 *
 * All endpoints accept credentials in the request body and use them only
 * for the duration of the request — they are never logged or persisted.
 */

import { Router } from 'express';
import {
  testServiceNowConnection,
  fetchServiceNowSchema,
  fetchServiceNowTableData,
  normaliseInstanceUrl,
} from '../utils/servicenowAPI.js';
import { compareSchemas, compareData } from '../utils/dataProcessing.js';

const router = Router();

// ---------------------------------------------------------------------------
// In-memory schema cache  (keyed by "<normalised_url>:<username>")
// TTL: 5 minutes
// ---------------------------------------------------------------------------
const schemaCache = new Map(); // key -> { schema, expires }
const CACHE_TTL_MS = 5 * 60 * 1000;

function getCachedSchema(key) {
  const entry = schemaCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expires) { schemaCache.delete(key); return null; }
  return entry.schema;
}

function setCachedSchema(key, schema) {
  schemaCache.set(key, { schema, expires: Date.now() + CACHE_TTL_MS });
}

function cacheKey(instanceUrl, username) {
  return `${instanceUrl}::${username}`;
}

// ---------------------------------------------------------------------------
// Input validation helpers
// ---------------------------------------------------------------------------

function requireFields(body, fields) {
  const missing = fields.filter(f => !body[f] || String(body[f]).trim() === '');
  if (missing.length > 0) {
    throw new Error(`Missing required fields: ${missing.join(', ')}`);
  }
}

// ---------------------------------------------------------------------------
// POST /api/live/test-connection
// Body: { instance_url, username, password }
// ---------------------------------------------------------------------------
router.post('/test-connection', async (req, res) => {
  try {
    requireFields(req.body, ['instance_url', 'username', 'password']);
    const { instance_url, username, password } = req.body;
    const result = await testServiceNowConnection(instance_url, username, password);
    res.json(result);
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/live/fetch-schema
// Body: { instance_url, username, password, table_limit? }
// Returns: { tables, columns, relationships, fetched_at }
// ---------------------------------------------------------------------------
router.post('/fetch-schema', async (req, res) => {
  try {
    requireFields(req.body, ['instance_url', 'username', 'password']);
    const { instance_url, username, password, table_limit, include_core } = req.body;

    const normUrl    = normaliseInstanceUrl(instance_url);
    const includeCore = include_core === true || include_core === 'true';
    // Cache key includes the includeCore flag so toggling it bypasses the cache
    const key = cacheKey(normUrl, `${username}:${includeCore}`);
    const cached = getCachedSchema(key);
    if (cached) {
      return res.json({ success: true, cached: true, ...cached });
    }

    const schema = await fetchServiceNowSchema(normUrl, username, password, {
      tableLimit:  table_limit ? parseInt(table_limit, 10) : 100,
      includeCore,
    });

    setCachedSchema(key, schema);
    res.json({ success: true, cached: false, ...schema });
  } catch (err) {
    const status = err.message.includes('Authentication') ? 401 : 500;
    res.status(status).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/live/compare-schemas
// Body: { instance1_url, instance1_user, instance1_pass,
//         instance2_url, instance2_user, instance2_pass }
// Returns: { added, removed, common, type_mismatches, summary, ... }
// ---------------------------------------------------------------------------
router.post('/compare-schemas', async (req, res) => {
  try {
    requireFields(req.body, [
      'instance1_url', 'instance1_user', 'instance1_pass',
      'instance2_url', 'instance2_user', 'instance2_pass',
    ]);

    const {
      instance1_url, instance1_user, instance1_pass,
      instance2_url, instance2_user, instance2_pass,
    } = req.body;

    const url1 = normaliseInstanceUrl(instance1_url);
    const url2 = normaliseInstanceUrl(instance2_url);

    // Fetch schemas (use cache where available)
    const [schema1, schema2] = await Promise.all([
      (async () => {
        const key = cacheKey(url1, instance1_user);
        const cached = getCachedSchema(key);
        if (cached) return cached;
        const s = await fetchServiceNowSchema(url1, instance1_user, instance1_pass);
        setCachedSchema(key, s);
        return s;
      })(),
      (async () => {
        const key = cacheKey(url2, instance2_user);
        const cached = getCachedSchema(key);
        if (cached) return cached;
        const s = await fetchServiceNowSchema(url2, instance2_user, instance2_pass);
        setCachedSchema(key, s);
        return s;
      })(),
    ]);

    // Build table-level comparison
    const tables1 = new Map(schema1.tables.map(t => [t.name, t]));
    const tables2 = new Map(schema2.tables.map(t => [t.name, t]));

    const added   = schema2.tables.filter(t => !tables1.has(t.name));
    const removed = schema1.tables.filter(t => !tables2.has(t.name));
    const common  = schema1.tables.filter(t => tables2.has(t.name));

    // Column-level diff for common tables
    const modified = [];
    for (const table of common) {
      const cols1 = new Map((schema1.columns[table.name] || []).map(c => [c.name, c]));
      const cols2 = new Map((schema2.columns[table.name] || []).map(c => [c.name, c]));

      const colsAdded   = [...cols2.keys()].filter(c => !cols1.has(c));
      const colsRemoved = [...cols1.keys()].filter(c => !cols2.has(c));
      const typeMismatches = [];

      for (const [colName, col1] of cols1) {
        const col2 = cols2.get(colName);
        if (col2 && col1.type !== col2.type) {
          typeMismatches.push({ column: colName, type_inst1: col1.type, type_inst2: col2.type });
        }
      }

      if (colsAdded.length > 0 || colsRemoved.length > 0 || typeMismatches.length > 0) {
        modified.push({
          table: table.name,
          label: table.label,
          columns_added:   colsAdded,
          columns_removed: colsRemoved,
          type_mismatches: typeMismatches,
          change_count: colsAdded.length + colsRemoved.length + typeMismatches.length,
        });
      }
    }

    res.json({
      success: true,
      instance1_url: url1,
      instance2_url: url2,
      added_tables:   added,
      removed_tables: removed,
      common_tables:  common,
      modified_tables: modified,
      summary: {
        total_inst1:    schema1.tables.length,
        total_inst2:    schema2.tables.length,
        added_count:    added.length,
        removed_count:  removed.length,
        common_count:   common.length,
        modified_count: modified.length,
      },
    });
  } catch (err) {
    const status = err.message.includes('Authentication') ? 401 : 500;
    res.status(status).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/live/compare-data
// Body: { instance1_url, instance1_user, instance1_pass,
//         instance2_url, instance2_user, instance2_pass,
//         table_name, key_columns (JSON array), compare_columns? (JSON array) }
// Returns: { added_rows, removed_rows, changed_rows, summary }
// ---------------------------------------------------------------------------
router.post('/compare-data', async (req, res) => {
  try {
    requireFields(req.body, [
      'instance1_url', 'instance1_user', 'instance1_pass',
      'instance2_url', 'instance2_user', 'instance2_pass',
      'table_name', 'key_columns',
    ]);

    const {
      instance1_url, instance1_user, instance1_pass,
      instance2_url, instance2_user, instance2_pass,
      table_name,
    } = req.body;

    let keyColumns = [];
    let compareColumns = [];
    try { keyColumns     = JSON.parse(req.body.key_columns     || '[]'); } catch { /* ignore */ }
    try { compareColumns = JSON.parse(req.body.compare_columns || '[]'); } catch { /* ignore */ }

    if (keyColumns.length === 0) {
      return res.status(400).json({ success: false, error: 'key_columns must be a non-empty JSON array.' });
    }

    const url1 = normaliseInstanceUrl(instance1_url);
    const url2 = normaliseInstanceUrl(instance2_url);

    const fields = compareColumns.length > 0
      ? [...new Set([...keyColumns, ...compareColumns])]
      : undefined;

    const [result1, result2] = await Promise.all([
      fetchServiceNowTableData(url1, instance1_user, instance1_pass, table_name, { fields }),
      fetchServiceNowTableData(url2, instance2_user, instance2_pass, table_name, { fields }),
    ]);

    const diff = compareData(result1.rows, result2.rows, keyColumns, compareColumns);

    res.json({
      success: true,
      instance1_url: url1,
      instance2_url: url2,
      table_name,
      key_columns: keyColumns,
      ...diff,
    });
  } catch (err) {
    const status = err.message.includes('Authentication') ? 401 : 500;
    res.status(status).json({ success: false, error: err.message });
  }
});

export default router;
