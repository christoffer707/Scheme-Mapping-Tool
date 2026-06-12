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
// High-Performance Concurrent Fetcher
// ---------------------------------------------------------------------------
async function fastFetchAll(client, endpoint, query, fields) {
  const PAGE_SIZE = 2500; 
  let total = NaN;
  
  const baseParams = {
    sysparm_exclude_reference_link: true,
    sysparm_fields: fields
  };
  if (query) baseParams.sysparm_query = query;

  try {
    const initial = await client.get(endpoint, {
      params: { ...baseParams, sysparm_limit: 1 }
    });
    if (initial.headers['x-total-count']) {
      total = parseInt(initial.headers['x-total-count'], 10);
    }
  } catch (err) {
    console.warn(`[FastFetch] Could not get x-total-count for ${endpoint}`);
  }

  const results = [];

  if (!isNaN(total) && total > 0) {
    console.log(`[FastFetch] ${endpoint} total records: ${total}. Fetching concurrently...`);
    const offsets = [];
    for (let i = 0; i < total; i += PAGE_SIZE) offsets.push(i);

    const CONCURRENCY = 3; 
    for (let i = 0; i < offsets.length; i += CONCURRENCY) {
      const batch = offsets.slice(i, i + CONCURRENCY);
      const promises = batch.map(offset => client.get(endpoint, {
        params: { ...baseParams, sysparm_limit: PAGE_SIZE, sysparm_offset: offset }
      }).then(res => res.data?.result || []).catch(e => {
        console.error(`[FastFetch] Batch failed at offset ${offset}:`, e.message);
        return [];
      }));
      
      const batchRes = await Promise.all(promises);
      batchRes.forEach(arr => results.push(...arr));
      
      // Tiny breather so we don't trip the firewall too quickly
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  } else {
    console.log(`[FastFetch] ${endpoint} falling back to sequential fetch...`);
    let offset = 0;
    while (true) {
      const res = await client.get(endpoint, {
        params: { ...baseParams, sysparm_limit: PAGE_SIZE, sysparm_offset: offset }
      });
      const page = res.data?.result || [];
      results.push(...page);
      if (page.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
    }
  }
  return results;
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
  const includeCore = opts.includeCore ?? opts.include_core ?? false;
  
  const cacheKey = `${url}_${includeCore ? 'core' : 'custom'}`;
  
  if (BACKEND_SCHEMA_CACHE.has(cacheKey)) {
    console.log(`[CACHE HIT] Instantly returned schema for ${cacheKey}`);
    return BACKEND_SCHEMA_CACHE.get(cacheKey);
  }
  
  console.log(`[CACHE MISS] Fetching fresh schema for ${cacheKey}...`);
  const schema = await fetchServiceNowSchemaInternal(url, username, password, { ...opts, includeCore });
  
  BACKEND_SCHEMA_CACHE.set(cacheKey, schema);
  return schema;
}

// Internal Fetcher
async function fetchServiceNowSchemaInternal(url, username, password, opts) {
  const client = buildClient(url, username, password);
  
  const tableLimit  = opts.tableLimit ?? Infinity;
  const includeCore = opts.includeCore;

  // 1. Fetch all tables concurrently
  let allTablesRaw = [];
  try {
    allTablesRaw = await fastFetchAll(client, '/api/now/table/sys_db_object', '', 'name,label,sys_id,super_class');
  } catch (err) {
    throw new Error(`Failed to fetch table list: ${err.message}`);
  }

  if (!allTablesRaw || allTablesRaw.length === 0) {
    throw new Error("ServiceNow API returned 0 tables. Verify user roles, API permissions, or transaction quotas.");
  }

  // 2. Filter tables based on user settings
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

  const tableNameSet = new Set(tablesRaw.map(t => t.name));

  // 3. Fetch entire dictionary concurrently
  let dictRaw = [];
  if (tableNameSet.size > 0) {
    try {
      dictRaw = await fastFetchAll(client, '/api/now/table/sys_dictionary', 'internal_type!=collection', 'name,element,label,internal_type,reference,mandatory,max_length');
    } catch (err) {
      console.error("Dictionary fetch error:", err.message);
    }
  }

  // 4. In-Memory Mapping
  const columnsByTable = {};
  for (const col of dictRaw) {
    if (!col.element) continue; 
    const tbl = col.name;
    
    if (!tableNameSet.has(tbl)) continue;

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
