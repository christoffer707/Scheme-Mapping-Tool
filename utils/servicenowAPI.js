/**
 * utils/servicenowAPI.js
 * Utility functions for communicating directly with live ServiceNow instances.
 * Uses Basic Auth via axios. Credentials are never logged or persisted.
 */

import axios from 'axios';

// ── Global Backend Schema Cache ────────────────────────────────────────────
// This prevents identical requests from fetching massive payloads twice.
const BACKEND_SCHEMA_CACHE = new Map();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildClient(instanceUrl, username, password) {
  const base = instanceUrl.replace(/\/+$/, ''); 
  return axios.create({
    baseURL: base,
    auth: { username, password },
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    timeout: 120_000,
  });
}

export function normaliseInstanceUrl(raw) {
  const s = (raw || '').trim();
  if (!s) throw new Error('Instance URL is required.');
  if (/^https?:\/\//i.test(s)) return s.replace(/\/+$/, '');
  if (/^[\w-]+$/.test(s)) return `https://${s}.service-now.com`;
  throw new Error(`Invalid instance URL: "${s}". Provide a full URL or a bare instance name.`);
}

// ---------------------------------------------------------------------------
// Connection test
// ---------------------------------------------------------------------------

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
// Schema fetch (Wrapped with Cache)
// ---------------------------------------------------------------------------

export async function fetchServiceNowSchema(instanceUrl, username, password, opts = {}) {
  const url = normaliseInstanceUrl(instanceUrl);
  const cacheKey = `${url}_${opts.includeCore ? 'core' : 'custom'}`;
  
  if (BACKEND_SCHEMA_CACHE.has(cacheKey)) {
    console.log(`[CACHE HIT] Instantly returned schema for ${cacheKey}`);
    return BACKEND_SCHEMA_CACHE.get(cacheKey);
  }
  
  console.log(`[CACHE MISS] Fetching fresh schema for ${cacheKey}...`);
  const schema = await fetchServiceNowSchemaInternal(url, username, password, opts);
  
  // Save the result in RAM so the next tab loads instantly
  BACKEND_SCHEMA_CACHE.set(cacheKey, schema);
  
  return schema;
}

// Internal Fetcher containing the optimized Concurrent Logic
async function fetchServiceNowSchemaInternal(url, username, password, opts) {
  const client = buildClient(url, username, password);
  
  const tableLimit  = opts.tableLimit  ?? Infinity;
  const includeCore = opts.includeCore ?? false;

  const PAGE_SIZE = 10_000;
  let allTablesRaw = [];
  let offset = 0;
  try {
    while (true) {
      const res = await client.get('/api/now/table/sys_db_object', {
        params: {
          sysparm_limit:   PAGE_SIZE,
          sysparm_offset:  offset,
          sysparm_fields:  'name,label,sys_id,super_class',
          sysparm_orderby: 'name',
        },
      });
      const page = res.data.result || [];
      allTablesRaw = allTablesRaw.concat(page);
      if (page.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
    }
  } catch (err) {
    throw new Error(`Failed to fetch table list: ${err.message}`);
  }

  let filterApplied;
  let tablesRaw;
  if (includeCore) {
    filterApplied = 'all';
    tablesRaw = allTablesRaw.slice(0, tableLimit);
  } else {
    filterApplied = 'user_custom';
    tablesRaw = allTablesRaw
      .filter(t => t.name.startsWith('u_') || t.name.startsWith('x_'))
      .slice(0, tableLimit);
  }

  const tableNames = tablesRaw.map(t => t.name);
  let dictRaw = [];
  if (tableNames.length > 0) {
    try {
      // OPTIMIZATION: Chunk by 100 tables at a time, and process 3 chunks concurrently 
      // to drastically reduce total HTTP connection time and bypass Cloud Timeouts
      const chunks = chunkArray(tableNames, 100); 
      const DICT_PAGE_SIZE = 10_000;

      for (let i = 0; i < chunks.length; i += 3) {
        const batch = chunks.slice(i, i + 3);
        const promises = batch.map(async (chunk) => {
          let localDict = [];
          let dictOffset = 0;
          while (true) {
            const res = await client.get('/api/now/table/sys_dictionary', {
              params: {
                sysparm_query: `nameIN${chunk.join(',')}^internal_type!=collection`,
                sysparm_limit:  DICT_PAGE_SIZE,
                sysparm_offset: dictOffset,
                sysparm_fields: 'name,element,label,internal_type,reference,mandatory,max_length',
              },
            });
            const page = res.data.result || [];
            localDict = localDict.concat(page);
            if (page.length < DICT_PAGE_SIZE) break;
            dictOffset += DICT_PAGE_SIZE;
          }
          return localDict;
        });
        
        // Wait for the 3 concurrent chunks to finish before firing the next 3
        const results = await Promise.all(promises);
        for (const r of results) dictRaw = dictRaw.concat(r);
      }
    } catch (err) {
      console.error("Dictionary fetch error:", err.message);
      // Failsafe: if the dictionary times out, we still return the tables so the app doesn't die.
    }
  }

  const columnsByTable = {};
  for (const col of dictRaw) {
    if (!col.element) continue; 
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

  const tableNameSet = new Set(tablesRaw.map(t => t.name));
  const relationships = [];
  for (const [tableName, cols] of Object.entries(columnsByTable)) {
    for (const col of cols) {
      if (col.reference && col.reference !== tableName && tableNameSet.has(col.reference)) {
        relationships.push({ from: tableName, to: col.reference, field: col.name, type: 'reference' });
      }
    }
  }

  const tables = tablesRaw.map(t => ({
    name: t.name, label: t.label || t.name, sys_id: t.sys_id,
    super_class: t.super_class?.value || t.super_class || null,
    column_count: (columnsByTable[t.name] || []).length,
  }));

  const rawTablesNormalised = allTablesRaw.map(t => ({
    name: t.name, label: t.label || t.name, sys_id: t.sys_id,
    super_class: t.super_class?.value || t.super_class || null,
  }));

  return {
    tables, columns: columnsByTable, relationships, raw_tables: rawTablesNormalised,
    total_tables: allTablesRaw.length, filtered_tables: tables.length, filter_applied: filterApplied,
    fetched_at: new Date().toISOString(),
  };
}

export async function fetchServiceNowTableData(instanceUrl, username, password, tableName, opts = {}) {
  const url = normaliseInstanceUrl(instanceUrl);
  const client = buildClient(url, username, password);
  const limit = opts.limit ?? 1000;

  const params = { sysparm_limit: limit, sysparm_display_value: false, sysparm_exclude_reference_link: true };
  if (opts.fields && opts.fields.length > 0) params.sysparm_fields = opts.fields.join(',');
  if (opts.query) params.sysparm_query = opts.query;

  try {
    const res = await client.get(`/api/now/table/${tableName}`, { params });
    const rows = res.data.result || [];
    return { rows, table: tableName, count: rows.length };
  } catch (err) {
    throw new Error(`Failed to fetch data from ${tableName}: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Table Artifacts (Drill-Down)
// ---------------------------------------------------------------------------

export async function fetchServiceNowTableArtifacts(instanceUrl, username, password, tableName) {
  const url = normaliseInstanceUrl(instanceUrl);
  const client = buildClient(url, username, password);

  try {
    const [brRes, csRes, uiRes, wfRes, siRes] = await Promise.allSettled([
      client.get('/api/now/table/sys_script', { params: { sysparm_query: `collection=${tableName}`, sysparm_limit: 100, sysparm_fields: 'name,active,when,action_insert,action_update,action_delete,action_query' } }),
      client.get('/api/now/table/sys_script_client', { params: { sysparm_query: `table=${tableName}`, sysparm_limit: 100, sysparm_fields: 'name,active,type' } }),
      client.get('/api/now/table/sys_ui_policy', { params: { sysparm_query: `table=${tableName}`, sysparm_limit: 100, sysparm_fields: 'short_description,active' } }),
      client.get('/api/now/table/wf_workflow', { params: { sysparm_query: `table=${tableName}`, sysparm_limit: 50, sysparm_fields: 'name,active' } }),
      client.get('/api/now/table/sys_script_include', { params: { sysparm_query: `scriptLIKE${tableName}`, sysparm_limit: 50, sysparm_fields: 'name,active,api_name' } })
    ]);

    return {
      table: tableName,
      businessRules: brRes.status === 'fulfilled' ? (brRes.value.data.result || []) : [],
      clientScripts: csRes.status === 'fulfilled' ? (csRes.value.data.result || []) : [],
      uiPolicies:    uiRes.status === 'fulfilled' ? (uiRes.value.data.result || []) : [],
      workflows:     wfRes.status === 'fulfilled' ? (wfRes.value.data.result || []) : [],
      scriptIncludes: siRes.status === 'fulfilled' ? (siRes.value.data.result || []) : [],
    };
  } catch (err) {
    throw new Error(`Failed to fetch artifacts for ${tableName}: ${err.message}`);
  }
}

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}
