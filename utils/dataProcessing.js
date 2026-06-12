/**
 * dataProcessing.js
 * Core data processing utilities.
 */

import { v4 as uuidv4 } from 'uuid';

// ── Type Detection ─────────────────────────────────────────────────────────
const TYPE_PATTERNS = {
  email:       /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/,
  phone:       /^[\+]?[(]?[0-9]{3}[)]?[-\s\.]?[0-9]{3}[-\s\.]?[0-9]{4,6}$/,
  ssn:         /^\d{3}-\d{2}-\d{4}$/,
  credit_card: /^\d{4}[\s\-]?\d{4}[\s\-]?\d{4}[\s\-]?\d{4}$/,
  ip_address:  /^(\d{1,3}\.){3}\d{1,3}$/,
  uuid:        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  url:         /^https?:\/\/(www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_\+.~#?&//=]*)$/,
  date:        /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/,
  currency:    /^[\$€£¥]?\s*\d{1,3}(,\d{3})*(\.\d{2})?$/,
  boolean:     /^(true|false|yes|no|1|0|y|n)$/i,
  integer:     /^-?\d+$/,
  float:       /^-?\d+\.\d+$/,
  zip_code:    /^\d{5}(-\d{4})?$/,
};

const NAME_HINTS = {
  email:       ['email', 'e_mail', 'mail'],
  phone:       ['phone', 'mobile', 'cell', 'fax', 'tel'],
  ssn:         ['ssn', 'social_security', 'sin'],
  credit_card: ['credit_card', 'card_number', 'cc_num'],
  ip_address:  ['ip', 'ip_address', 'ipaddr'],
  uuid:        ['uuid', 'guid', 'sys_id'],
  url:         ['url', 'link', 'href', 'website'],
  date:        ['date', 'time', 'created', 'updated', 'modified', 'opened', 'closed', 'resolved'],
  currency:    ['price', 'cost', 'amount', 'salary', 'revenue', 'fee', 'charge'],
  boolean:     ['active', 'enabled', 'flag', 'is_', 'has_'],
  zip_code:    ['zip', 'postal', 'postcode'],
  name:        ['name', 'first_name', 'last_name', 'full_name', 'fname', 'lname'],
  address:     ['address', 'street', 'city', 'state', 'country', 'location'],
};

export function detectSemanticType(columnData, columnName) {
  const colLower = (columnName || '').toLowerCase();
  const sample = columnData.filter(v => v !== null && v !== undefined && String(v).trim() !== '').slice(0, 200).map(v => String(v).trim());
  if (sample.length === 0) return { type: 'unknown', confidence: 0 };

  for (const [type, hints] of Object.entries(NAME_HINTS)) {
    if (hints.some(h => colLower.includes(h))) {
      if (TYPE_PATTERNS[type]) {
        const matchRate = sample.filter(v => TYPE_PATTERNS[type].test(v)).length / sample.length;
        if (matchRate > 0.5) return { type, confidence: Math.min(0.5 + matchRate * 0.5, 1) };
      } else return { type, confidence: 0.75 };
    }
  }

  for (const [type, pattern] of Object.entries(TYPE_PATTERNS)) {
    const matchRate = sample.filter(v => pattern.test(v)).length / sample.length;
    if (matchRate > 0.8) return { type, confidence: matchRate };
  }

  const numericRate = sample.filter(v => !isNaN(Number(v))).length / sample.length;
  if (numericRate > 0.9) {
    const hasDecimal = sample.some(v => v.includes('.'));
    return { type: hasDecimal ? 'float' : 'integer', confidence: numericRate };
  }

  return { type: 'string', confidence: 1 };
}

// ── Schema Comparison ──────────────────────────────────────────────────────
export function compareSchemas(df1, df2) {
  const cols1 = df1.length > 0 ? Object.keys(df1[0]) : [];
  const cols2 = df2.length > 0 ? Object.keys(df2[0]) : [];
  const set1 = new Set(cols1);
  const set2 = new Set(cols2);

  const common  = cols1.filter(c => set2.has(c));
  const added   = cols2.filter(c => !set1.has(c));   
  const removed = cols1.filter(c => !set2.has(c));   

  const typeInfo1 = {}; const typeInfo2 = {};
  for (const col of cols1) typeInfo1[col] = detectSemanticType(df1.map(r => r[col]), col);
  for (const col of cols2) typeInfo2[col] = detectSemanticType(df2.map(r => r[col]), col);

  const comparisonData = common.map(col => ({
    column:      col,
    type_file1:  typeInfo1[col]?.type  ?? 'unknown',
    type_file2:  typeInfo2[col]?.type  ?? 'unknown',
    type_match:  typeInfo1[col]?.type === typeInfo2[col]?.type,
    conf_file1:  +(typeInfo1[col]?.confidence ?? 0).toFixed(3),
    conf_file2:  +(typeInfo2[col]?.confidence ?? 0).toFixed(3),
  }));

  return {
    common, added, removed, comparison_data: comparisonData,
    summary: {
      total_file1: cols1.length, total_file2: cols2.length, common_count: common.length,
      added_count:  added.length, removed_count: removed.length,
      type_mismatches: comparisonData.filter(r => !r.type_match).length,
    },
  };
}

// ── Data Comparison ────────────────────────────────────────────────────────
function buildKey(row, keyColumns) {
  return keyColumns.map(k => String(row[k] ?? '')).join('||');
}

export function compareData(df1, df2, keyColumns, compareColumns) {
  if (!keyColumns || keyColumns.length === 0) throw new Error('Key column is required.');

  const map1 = new Map(); const map2 = new Map();
  for (const row of df1) map1.set(buildKey(row, keyColumns), row);
  for (const row of df2) map2.set(buildKey(row, keyColumns), row);

  const keys1 = new Set(map1.keys()); const keys2 = new Set(map2.keys());

  const added_rows = [];
  for (const k of keys2) if (!keys1.has(k)) added_rows.push(map2.get(k));

  const removed_rows = [];
  for (const k of keys1) if (!keys2.has(k)) removed_rows.push(map1.get(k));

  const changed_rows = [];
  const cols = compareColumns && compareColumns.length > 0 ? compareColumns : (df1.length > 0 ? Object.keys(df1[0]).filter(c => !keyColumns.includes(c)) : []);

  for (const k of keys1) {
    if (!keys2.has(k)) continue;
    const r1 = map1.get(k); const r2 = map2.get(k);
    const diffs = [];
    for (const col of cols) {
      const v1 = r1[col] ?? null; const v2 = r2[col] ?? null;
      if (String(v1) !== String(v2)) diffs.push({ column: col, old_value: v1, new_value: v2 });
    }
    if (diffs.length > 0) changed_rows.push({ key: k, key_values: Object.fromEntries(keyColumns.map(c => [c, r1[c]])), changes: diffs });
  }

  return {
    added_rows, removed_rows, changed_rows,
    summary: {
      total_file1: df1.length, total_file2: df2.length, added_count: added_rows.length,
      removed_count: removed_rows.length, changed_count: changed_rows.length,
      unchanged_count: [...keys1].filter(k => keys2.has(k)).length - changed_rows.length,
    },
  };
}

// ── File Splitter ──────────────────────────────────────────────────────────
export function splitDataFrame(df, chunkSize) {
  const chunks = [];
  for (let i = 0; i < df.length; i += chunkSize) {
    chunks.push(df.slice(i, i + chunkSize));
  }
  return chunks;
}

// ── Column Normalizer ──────────────────────────────────────────────────────
export function normalizeColumns(df, columns, action) {
  return df.map(row => {
    const newRow = { ...row };
    for (const col of columns) {
      if (newRow[col] !== undefined && newRow[col] !== null) {
        let val = String(newRow[col]);
        switch(action) {
          case 'trim': val = val.trim(); break;
          case 'lowercase': val = val.toLowerCase(); break;
          case 'uppercase': val = val.toUpperCase(); break;
          case 'remove_special': val = val.replace(/[^a-zA-Z0-9 \-_]/g, ''); break;
          case 'extract_numbers': val = val.replace(/[^0-9.]/g, ''); break;
        }
        newRow[col] = val;
      }
    }
    return newRow;
  });
}

// ── Find & Replace ─────────────────────────────────────────────────────────
export function findAndReplace(df, columns, searchStr, replaceStr, useRegex, matchCase) {
  let regex;
  if (useRegex) {
    regex = new RegExp(searchStr, matchCase ? 'g' : 'gi');
  } else {
    const escaped = searchStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    regex = new RegExp(escaped, matchCase ? 'g' : 'gi');
  }

  return df.map(row => {
    const newRow = { ...row };
    for (const col of columns) {
      if (newRow[col] !== undefined && newRow[col] !== null) {
        newRow[col] = String(newRow[col]).replace(regex, replaceStr);
      }
    }
    return newRow;
  });
}

// ── Column Operations ──────────────────────────────────────────────────────
export function columnOperations(df, ops) {
  return df.map(row => {
    const newRow = {};
    for (const key of Object.keys(row)) {
      if (ops.drop && ops.drop.includes(key)) continue;
      const newKey = (ops.rename && ops.rename[key]) ? ops.rename[key] : key;
      newRow[newKey] = row[key];
    }
    return newRow;
  });
}

// ── Row Filter ─────────────────────────────────────────────────────────────
export function rowFilter(df, col, op, val) {
  return df.filter(row => {
    const rv = String(row[col] || '').toLowerCase();
    const cv = String(val || '').toLowerCase();
    switch(op) {
      case 'eq': return rv === cv;
      case 'neq': return rv !== cv;
      case 'contains': return rv.includes(cv);
      case 'not_contains': return !rv.includes(cv);
      case 'gt': return Number(row[col]) > Number(val);
      case 'lt': return Number(row[col]) < Number(val);
      case 'empty': return rv === '';
      case 'not_empty': return rv !== '';
      default: return true;
    }
  });
}

// ── Calculated Columns ─────────────────────────────────────────────────────
export function calculatedColumns(df, newColumnName, expression) {
  return df.map(row => {
    const newRow = { ...row };
    try {
      let jsExpr = expression.replace(/\[([^\]]+)\]/g, "row['$1']");
      const fn = new Function('row', `return ${jsExpr};`);
      newRow[newColumnName] = fn(row);
    } catch(e) {
      newRow[newColumnName] = "ERROR: Invalid Formula";
    }
    return newRow;
  });
}

// ── NEW: Transpose Data ────────────────────────────────────────────────────
export function transposeData(df) {
  if (!df || df.length === 0) return [];
  const originalCols = Object.keys(df[0]);
  const result = [];
  
  for (const col of originalCols) {
    const newRow = { "Original_Column": col };
    df.forEach((row, idx) => {
      newRow[`Row_${idx + 1}`] = row[col];
    });
    result.push(newRow);
  }
  return result;
}

// ── NEW: Pivot Table Generator ─────────────────────────────────────────────
export function pivotData(df, groupCol, valCol, aggFunc) {
  const groups = {};
  
  // 1. Group records
  df.forEach(row => {
    const k = String(row[groupCol] ?? 'Unknown');
    if (!groups[k]) groups[k] = { count: 0, values: [] };
    groups[k].count++;
    
    if (valCol) {
      const v = Number(row[valCol]);
      if (!isNaN(v)) groups[k].values.push(v);
    }
  });

  // 2. Aggregate
  const result = [];
  for (const [k, data] of Object.entries(groups)) {
    let aggVal = 0;
    if (aggFunc === 'count') {
      aggVal = data.count;
    } else if (data.values.length > 0) {
      const vals = data.values;
      if (aggFunc === 'sum') aggVal = vals.reduce((a, b) => a + b, 0);
      else if (aggFunc === 'avg') aggVal = vals.reduce((a, b) => a + b, 0) / vals.length;
      else if (aggFunc === 'max') aggVal = Math.max(...vals);
      else if (aggFunc === 'min') aggVal = Math.min(...vals);
    }
    result.push({ 
      [groupCol]: k, 
      [`${aggFunc}_${valCol || 'records'}`]: +aggVal.toFixed(4) 
    });
  }
  
  // Sort alphabetically by the group key to make the table readable
  return result.sort((a, b) => String(a[groupCol]).localeCompare(String(b[groupCol])));
}

// ── Anonymization ──────────────────────────────────────────────────────────
const FAKE_FIRST_NAMES = ['Alex','Jordan','Taylor','Morgan','Casey','Riley','Avery','Quinn','Skyler','Dakota'];
const FAKE_LAST_NAMES  = ['Smith','Johnson','Williams','Brown','Jones','Garcia','Miller','Davis','Wilson','Moore'];
const FAKE_DOMAINS     = ['example.com','test.org','sample.net','demo.io','placeholder.co'];

function fakeEmail(seed) { return `${FAKE_FIRST_NAMES[seed % FAKE_FIRST_NAMES.length].toLowerCase()}.${seed}@${FAKE_DOMAINS[seed % FAKE_DOMAINS.length]}`; }
function fakeName(seed) { return `${FAKE_FIRST_NAMES[seed % FAKE_FIRST_NAMES.length]} ${FAKE_LAST_NAMES[seed % FAKE_LAST_NAMES.length]}`; }
function fakePhone(seed) { const n = String(seed).padStart(7, '0').slice(0, 7); return `555-${n.slice(0,3)}-${n.slice(3)}`; }
function fakeSSN(seed) { const n = String(seed).padStart(9, '0'); return `${n.slice(0,3)}-${n.slice(3,5)}-${n.slice(5)}`; }
function fakeIP(seed) { return `10.${seed % 256}.${(seed >> 8) % 256}.${(seed >> 16) % 256}`; }
function fakeAddress(seed) { return `${(seed % 9999) + 1} Main St, City ${seed % 100}, ST ${String(seed % 99999).padStart(5,'0')}`; }

function generateFakeValue(originalValue, semanticType, seed) {
  switch (semanticType) {
    case 'email':       return fakeEmail(seed);
    case 'phone':       return fakePhone(seed);
    case 'ssn':         return fakeSSN(seed);
    case 'ip_address':  return fakeIP(seed);
    case 'name':        return fakeName(seed);
    case 'address':     return fakeAddress(seed);
    case 'uuid':        return uuidv4();
    case 'credit_card': return `4000-0000-0000-${String(seed % 9999).padStart(4,'0')}`;
    case 'url':         return `https://example.com/user/${seed}`;
    case 'integer':     return seed;
    case 'float':       return +(seed * 1.337).toFixed(2);
    case 'currency':    return `$${(seed * 9.99).toFixed(2)}`;
    default:            return `REDACTED_${seed}`;
  }
}

export function scrubDataFrame(df, columnsToScrub, preserveRelationships = true) {
  if (!df || df.length === 0) return { data: [], mapping: {} };
  const semanticTypes = {};
  for (const col of columnsToScrub) semanticTypes[col] = detectSemanticType(df.map(r => r[col]), col).type;

  const valueMaps = {};
  for (const col of columnsToScrub) valueMaps[col] = new Map();

  let globalSeed = 1;
  const scrubbed = df.map(row => {
    const newRow = { ...row };
    for (const col of columnsToScrub) {
      if (!(col in row)) continue;
      const original = row[col];
      const key = String(original ?? '');
      if (preserveRelationships) {
        if (!valueMaps[col].has(key)) valueMaps[col].set(key, generateFakeValue(original, semanticTypes[col], globalSeed++));
        newRow[col] = valueMaps[col].get(key);
      } else {
        newRow[col] = generateFakeValue(original, semanticTypes[col], globalSeed++);
      }
    }
    return newRow;
  });

  const mapping = {};
  for (const col of columnsToScrub) mapping[col] = Object.fromEntries(valueMaps[col]);
  return { data: scrubbed, mapping };
}

// ── Data Analysis ──────────────────────────────────────────────────────────
function numericStats(values) {
  const nums = values.map(Number).filter(n => !isNaN(n));
  if (nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const sum = nums.reduce((a, b) => a + b, 0);
  const mean = sum / nums.length;
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  const variance = nums.reduce((acc, v) => acc + (v - mean) ** 2, 0) / nums.length;
  return { min: sorted[0], max: sorted[sorted.length - 1], mean: +mean.toFixed(4), median: +median.toFixed(4), std: +Math.sqrt(variance).toFixed(4), sum: +sum.toFixed(4) };
}

export function analyzeDataFrame(df) {
  if (!df || df.length === 0) return { overview: { row_count: 0, column_count: 0 }, columns: {}, memory_info: {}, detected_types: {} };

  const columns = Object.keys(df[0]);
  const rowCount = df.length;
  const columnAnalysis = {};
  const detectedTypes = {};

  for (const col of columns) {
    const values = df.map(r => r[col]);
    const nonNull = values.filter(v => v !== null && v !== undefined && String(v).trim() !== '');
    const nullCount = rowCount - nonNull.length;
    const unique = new Set(nonNull.map(v => String(v)));
    const { type, confidence } = detectSemanticType(nonNull, col);
    detectedTypes[col] = { type, confidence: +confidence.toFixed(3) };

    const freq = {};
    for (const v of nonNull) { const k = String(v); freq[k] = (freq[k] || 0) + 1; }
    const topValues = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([value, count]) => ({ value, count, pct: +((count / rowCount) * 100).toFixed(2) }));
    const stats = ['integer', 'float', 'currency'].includes(type) ? numericStats(nonNull) : null;

    columnAnalysis[col] = {
      total: rowCount, non_null: nonNull.length, null_count: nullCount, null_pct: +((nullCount / rowCount) * 100).toFixed(2),
      unique_count: unique.size, uniqueness: +((unique.size / rowCount) * 100).toFixed(2), is_unique: unique.size === rowCount,
      top_values: topValues, stats, semantic_type: type, type_confidence: +confidence.toFixed(3),
    };
  }

  const jsonSize = JSON.stringify(df).length;
  const rowKeys = df.map(r => JSON.stringify(r));
  const dupSet = new Set();
  const seen = new Set();
  for (const k of rowKeys) { if (seen.has(k)) dupSet.add(k); seen.add(k); }

  return {
    overview: { row_count: rowCount, column_count: columns.length, duplicate_rows: dupSet.size, duplicate_pct: +((dupSet.size / rowCount) * 100).toFixed(2), total_nulls: Object.values(columnAnalysis).reduce((s, c) => s + c.null_count, 0), columns },
    columns: columnAnalysis,
    memory_info: { estimated_bytes: jsonSize, estimated_kb: +(jsonSize / 1024).toFixed(2), estimated_mb: +(jsonSize / 1024 / 1024).toFixed(4) },
    detected_types: detectedTypes,
  };
}

// ── Natural Keys ───────────────────────────────────────────────────────────
function isUnique(df, cols) {
  const seen = new Set();
  for (const row of df) {
    const key = cols.map(c => String(row[c] ?? '')).join('||');
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

function combinations(arr, size) {
  if (size === 0) return [[]];
  if (arr.length < size) return [];
  const [first, ...rest] = arr;
  const withFirst = combinations(rest, size - 1).map(c => [first, ...c]);
  const withoutFirst = combinations(rest, size);
  return [...withFirst, ...withoutFirst];
}

export function findNaturalKeys(df, selectedColumns) {
  if (!df || df.length === 0) return { minimal_combinations: [], primary_key: null, alternatives: [], stats: {} };
  const cols = selectedColumns && selectedColumns.length > 0 ? selectedColumns.filter(c => c in (df[0] || {})) : Object.keys(df[0] || {});
  if (cols.length === 0) return { minimal_combinations: [], primary_key: null, alternatives: [], stats: {} };

  const uniqueCols = [];
  const colStats = {};
  for (const col of cols) {
    const vals = df.map(r => String(r[col] ?? ''));
    const unique = new Set(vals);
    const uniqueness = unique.size / df.length;
    colStats[col] = { uniqueness: +uniqueness.toFixed(4), unique_count: unique.size };
    if (unique.size === df.length) uniqueCols.push(col);
  }

  if (uniqueCols.length > 0) return { minimal_combinations: uniqueCols.map(c => [c]), primary_key: [uniqueCols[0]], alternatives: uniqueCols.slice(1).map(c => [c]), stats: colStats };

  const maxSize = Math.min(cols.length, 4); 
  let found = [];
  for (let size = 2; size <= maxSize; size++) {
    const combos = combinations(cols, size);
    for (const combo of combos) if (isUnique(df, combo)) found.push(combo);
    if (found.length > 0) break;
  }
  return { minimal_combinations: found, primary_key: found[0] ?? null, alternatives: found.slice(1), stats: colStats };
}

// ── Parsers & Exporters ────────────────────────────────────────────────────
export async function parseCSV(csvString) {
  const { parse } = await import('csv-parse/sync');
  return parse(csvString, { columns: true, skip_empty_lines: true, trim: true });
}

export async function parseFileBuffer(buffer, originalName) {
  const ext = (originalName || '').split('.').pop().toLowerCase();
  if (ext === 'csv') {
    const { parse } = await import('csv-parse/sync');
    return parse(buffer.toString('utf8'), { columns: true, skip_empty_lines: true, trim: true });
  }
  if (ext === 'xlsx' || ext === 'xls') {
    const XLSX = await import('xlsx');
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    return XLSX.utils.sheet_to_json(sheet, { defval: null });
  }
  throw new Error(`Unsupported file type: .${ext}. Please upload .csv, .xlsx, or .xls files.`);
}

export async function buildExcelReport(report) {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Scheme-Mapping-Tool';
  wb.created = new Date();

  for (const [sheetName, rows] of Object.entries(report)) {
    const ws = wb.addWorksheet(sheetName.slice(0, 31)); 
    if (!rows || rows.length === 0) { ws.addRow(['No data']); continue; }
    const headers = Object.keys(rows[0]);
    ws.addRow(headers);
    ws.getRow(1).eachCell(cell => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0066CC' } };
    });
    for (const row of rows) ws.addRow(headers.map(h => row[h] ?? ''));
    ws.columns.forEach(col => { col.width = 20; });
  }
  return wb.xlsx.writeBuffer();
}
