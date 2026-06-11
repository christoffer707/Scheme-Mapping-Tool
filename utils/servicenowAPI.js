/**
 * utils/servicenowAPI.js
 * Utility functions for communicating directly with live ServiceNow instances.
 * Uses Basic Auth via axios. Credentials are never logged or persisted.
 */

import axios from 'axios';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build an axios instance pre-configured for a ServiceNow REST API call.
 * @param {string} instanceUrl  Full URL, e.g. https://dev12345.service-now.com
 * @param {string} username
 * @param {string} password
 */
function buildClient(instanceUrl, username, password) {
  const base = instanceUrl.replace(/\/+$/, ''); // strip trailing slash
  return axios.create({
    baseURL: base,
    auth: { username, password },
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    timeout: 30_000,
  });
}

/**
 * Normalise a ServiceNow instance URL.
 * Accepts bare instance names (dev12345) or full URLs.
 */
export function normaliseInstanceUrl(raw) {
  const s = (raw || '').trim();
  if (!s) throw new Error('Instance URL is required.');
  // Already a full URL
  if (/^https?:\/\//i.test(s)) return s.replace(/\/+$/, '');
  // Bare instance name — assume .service-now.com
  if (/^[\w-]+$/.test(s)) return `https://${s}.service-now.com`;
  throw new Error(`Invalid instance URL: "${s}". Provide a full URL or a bare instance name.`);
}

// ---------------------------------------------------------------------------
// Connection test
// ---------------------------------------------------------------------------

/**
 * Verify that credentials work against the given instance.
 * @returns {{ success: boolean, instance_url: string, error?: string }}
 */
export async function testServiceNowConnection(instanceUrl, username, password) {
  const url = normaliseInstanceUrl(instanceUrl);
  const client = buildClient(url, username, password);
  try {
    await client.get('/api/now/table/sys_db_object', {
      params: { sysparm_limit: 1, sysparm_fields: 'name' },
    });
    return { success: true, instance_url: url };
  } catch (err) {
    const status = err.response?.status;
    if (status === 401 || status === 403) {
      return { success: false, instance_url: url, error: 'Authentication failed — check username and password.' };
    }
    return { success: false, instance_url: url, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Schema fetch
// ---------------------------------------------------------------------------

/**
 * Fetch the full schema (tables + columns + relationships) from a live instance.
 *
 * Strategy:
 *  - Always fetch ALL tables from the instance (no server-side prefix filter) so we
 *    can report the true total count and let the client apply display filters.
 *  - `tables`     — filtered/limited set used for ERD display (u_* / x_* by default)
 *  - `raw_tables` — every table returned by the instance (up to a generous hard cap)
 *
 * @param {string} instanceUrl
 * @param {string} username
 * @param {string} password
 * @param {{ tableLimit?: number, includeCore?: boolean }} [opts]
 * @returns {{ tables: object[], columns: object, relationships: object[], raw_tables: object[],
 *             total_tables: number, filtered_tables: number, filter_applied: string }}
 */
export async function fetchServiceNowSchema(instanceUrl, username, password, opts = {}) {
  const url = normaliseInstanceUrl(instanceUrl);
  const client = buildClient(url, username, password);
  // Display limit for the filtered (ERD-ready) table set
  const tableLimit  = opts.tableLimit  ?? 1000;
  const includeCore = opts.includeCore ?? false;

  // 1. Fetch ALL tables from the instance (hard cap at 2000 to stay safe)
  let allTablesRaw;
  try {
    const res = await client.get('/api/now/table/sys_db_object', {
      params: {
        sysparm_limit: 2000,
        sysparm_fields: 'name,label,sys_id,super_class',
        sysparm_orderby: 'name',
      },
    });
    allTablesRaw = res.data.result || [];
  } catch (err) {
    const status = err.response?.status;
    if (status === 401 || status === 403) throw new Error('Authentication failed — check username and password.');
    throw new Error(`Failed to fetch table list: ${err.message}`);
  }

  // 2. Apply display filter to produce the working table set
  let filterApplied;
  let tablesRaw;
  if (includeCore) {
    // "All tables" mode — include everything up to the display limit
    filterApplied = 'all';
    tablesRaw = allTablesRaw.slice(0, tableLimit);
  } else {
    // Default: user-created (u_*) and custom-scoped (x_*) tables only
    filterApplied = 'user_custom';
    tablesRaw = allTablesRaw
      .filter(t => t.name.startsWith('u_') || t.name.startsWith('x_'))
      .slice(0, tableLimit);
  }

  // 3. Fetch dictionary entries (columns) for all fetched tables in one call
  const tableNames = tablesRaw.map(t => t.name);
  let dictRaw = [];
  if (tableNames.length > 0) {
    try {
      // ServiceNow allows up to ~250 values in an IN query; chunk if needed
      const chunks = chunkArray(tableNames, 100);
      for (const chunk of chunks) {
        const res = await client.get('/api/now/table/sys_dictionary', {
          params: {
            sysparm_query: `nameIN${chunk.join(',')}^internal_type!=collection`,
            sysparm_limit: 5000,
            sysparm_fields: 'name,element,label,internal_type,reference,mandatory,max_length',
          },
        });
        dictRaw = dictRaw.concat(res.data.result || []);
      }
    } catch (err) {
      // Non-fatal — continue with empty columns
      dictRaw = [];
    }
  }

  // 4. Group columns by table
  const columnsByTable = {};
  for (const col of dictRaw) {
    if (!col.element) continue; // skip table-level entries
    const tbl = col.name;
    if (!columnsByTable[tbl]) columnsByTable[tbl] = [];
    columnsByTable[tbl].push({
      name: col.element,
      label: col.label || col.element,
      type: col.internal_type || 'string',
      reference: col.reference?.value || col.reference || null,
      mandatory: col.mandatory === 'true' || col.mandatory === true,
      max_length: col.max_length || null,
    });
  }

  // 5. Build relationships list — only include edges where both ends are in the fetched set
  const tableNameSet = new Set(tablesRaw.map(t => t.name));
  const relationships = [];
  for (const [tableName, cols] of Object.entries(columnsByTable)) {
    for (const col of cols) {
      if (
        col.reference &&
        col.reference !== tableName &&
        tableNameSet.has(col.reference)
      ) {
        relationships.push({
          from: tableName,
          to: col.reference,
          field: col.name,
          type: 'reference',
        });
      }
    }
  }

  // 6. Build normalised tables array
  const tables = tablesRaw.map(t => ({
    name: t.name,
    label: t.label || t.name,
    sys_id: t.sys_id,
    super_class: t.super_class?.value || t.super_class || null,
    column_count: (columnsByTable[t.name] || []).length,
  }));

  // Build a lightweight raw_tables list (name + label only) for all tables
  // so the client can apply its own filters without re-fetching.
  const rawTablesNormalised = allTablesRaw.map(t => ({
    name: t.name,
    label: t.label || t.name,
    sys_id: t.sys_id,
    super_class: t.super_class?.value || t.super_class || null,
  }));

  return {
    tables,
    columns: columnsByTable,
    relationships,
    raw_tables: rawTablesNormalised,
    total_tables:    allTablesRaw.length,
    filtered_tables: tables.length,
    filter_applied:  filterApplied,
    fetched_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Table data fetch
// ---------------------------------------------------------------------------

/**
 * Fetch rows from a specific table on a live instance.
 *
 * @param {string} instanceUrl
 * @param {string} username
 * @param {string} password
 * @param {string} tableName
 * @param {{ limit?: number, fields?: string[], query?: string }} [opts]
 * @returns {{ rows: object[], table: string, count: number }}
 */
export async function fetchServiceNowTableData(instanceUrl, username, password, tableName, opts = {}) {
  const url = normaliseInstanceUrl(instanceUrl);
  const client = buildClient(url, username, password);
  const limit = opts.limit ?? 1000;

  const params = {
    sysparm_limit: limit,
    sysparm_display_value: false,
    sysparm_exclude_reference_link: true,
  };
  if (opts.fields && opts.fields.length > 0) {
    params.sysparm_fields = opts.fields.join(',');
  }
  if (opts.query) {
    params.sysparm_query = opts.query;
  }

  try {
    const res = await client.get(`/api/now/table/${tableName}`, { params });
    const rows = res.data.result || [];
    return { rows, table: tableName, count: rows.length };
  } catch (err) {
    const status = err.response?.status;
    if (status === 401 || status === 403) throw new Error('Authentication failed — check username and password.');
    if (status === 404) throw new Error(`Table "${tableName}" not found on this instance.`);
    throw new Error(`Failed to fetch data from ${tableName}: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}
