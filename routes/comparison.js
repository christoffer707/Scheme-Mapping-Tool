/**
 * routes/comparison.js
 * Express router for all comparison, analysis, and scrubbing endpoints.
 */

import { Router } from 'express';
import multer from 'multer';
import { fetchServiceNowTableData } from '../utils/servicenowAPI.js';
import {
  compareSchemas,
  compareData,
  scrubDataFrame,
  analyzeDataFrame,
  findNaturalKeys,
  parseFileBuffer,
  buildExcelReport,
  splitDataFrame,
  normalizeColumns
} from '../utils/dataProcessing.js';

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, 
  fileFilter(_req, file, cb) {
    const allowed = ['.csv', '.xlsx', '.xls'];
    const ext = '.' + file.originalname.split('.').pop().toLowerCase();
    if (allowed.includes(ext)) return cb(null, true);
    cb(new Error(`Unsupported file type: ${ext}. Allowed: ${allowed.join(', ')}`));
  },
});

// ── Universal Data Source Handler ──────────────────────────────────────────
async function getDataFrame(req) {
  if (req.file) {
    return await parseFileBuffer(req.file.buffer, req.file.originalname);
  } else if (req.body.instance_url && req.body.table_name) {
    const { instance_url, username, password, table_name, query, limit } = req.body;
    const fetchLimit = limit ? parseInt(limit, 10) : 10000;
    const result = await fetchServiceNowTableData(instance_url, username, password, table_name, { query, limit: fetchLimit });
    return result.rows;
  }
  throw new Error("No data source provided. Upload a file or provide instance credentials and a table name.");
}

// ── File Splitter ──────────────────────────────────────────────────────────
router.post('/split-data', upload.single('file'), async (req, res) => {
  try {
    const df = await getDataFrame(req);
    if (df.length === 0) return res.status(400).json({ error: 'Data source returned 0 rows.' });
    
    const chunkSize = parseInt(req.body.chunk_size, 10) || 5000;
    const chunks = splitDataFrame(df, chunkSize);
    
    const sheets = {};
    chunks.forEach((chunk, index) => {
      sheets[`Chunk_${index + 1}`] = chunk;
    });

    const xlsxBuffer = await buildExcelReport(sheets);
    const fileName = req.file ? req.file.originalname.replace(/\.[^.]+$/, '') : req.body.table_name;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="split_${fileName}.xlsx"`);
    res.send(Buffer.from(xlsxBuffer));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Column Normalizer ──────────────────────────────────────────────────────
router.post('/normalize-data', upload.single('file'), async (req, res) => {
  try {
    const df = await getDataFrame(req);
    if (df.length === 0) return res.status(400).json({ error: 'Data source returned 0 rows.' });
    
    let columns = [];
    try { columns = JSON.parse(req.body.columns || '[]'); } catch {}
    if (columns.length === 0) return res.status(400).json({ error: 'Please specify at least one column.' });

    const action = req.body.action || 'trim';
    const normalizedData = normalizeColumns(df, columns, action);

    const sheets = { 'Normalized Data': normalizedData };
    const xlsxBuffer = await buildExcelReport(sheets);
    const fileName = req.file ? req.file.originalname.replace(/\.[^.]+$/, '') : req.body.table_name;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="normalized_${fileName}.xlsx"`);
    res.send(Buffer.from(xlsxBuffer));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Duplicate Finder ───────────────────────────────────────────────────────
router.post('/find-duplicates', upload.single('file'), async (req, res) => {
  try {
    let checkColumns = [];
    try { checkColumns = JSON.parse(req.body.check_columns || '[]'); } catch { /* ignore */ }
    
    const df = await getDataFrame(req);
    if (df.length === 0) return res.status(400).json({ error: 'Data source returned 0 rows.' });

    const colsToCompare = checkColumns.length > 0 ? checkColumns : Object.keys(df[0]);
    const seen = new Set();
    const uniqueRows = [];
    const duplicateRows = [];

    for (const row of df) {
      const hash = colsToCompare.map(c => String(row[c] ?? '')).join('||');
      if (seen.has(hash)) {
        duplicateRows.push(row);
      } else {
        seen.add(hash);
        uniqueRows.push(row);
      }
    }

    const sheets = { 'Unique Data': uniqueRows, 'Removed Duplicates': duplicateRows };
    const xlsxBuffer = await buildExcelReport(sheets);
    const fileName = req.file ? req.file.originalname.replace(/\.[^.]+$/, '') : req.body.table_name;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="deduplicated_${fileName}.xlsx"`);
    res.send(Buffer.from(xlsxBuffer));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Anonymizer / Scrub Data ───────────────────────────────────────────────
router.post('/scrub-data', upload.single('file'), async (req, res) => {
  try {
    let columnsToScrub = [];
    try { columnsToScrub = JSON.parse(req.body.columns_to_scrub || '[]'); } catch { /* ignore */ }
    if (columnsToScrub.length === 0) return res.status(400).json({ error: 'columns_to_scrub must be a non-empty JSON array.' });

    const preserveRelationships = req.body.preserve_relationships !== 'false';
    const exportMapping         = req.body.export_mapping !== 'false';

    const df = await getDataFrame(req);
    if (df.length === 0) return res.status(400).json({ error: 'Data source returned 0 rows.' });

    const cols = Object.keys(df[0]);
    const missing = columnsToScrub.filter(c => !cols.includes(c));
    if (missing.length > 0) return res.status(400).json({ error: `Columns not found in dataset: ${missing.join(', ')}` });

    const { data: scrubbed, mapping } = scrubDataFrame(df, columnsToScrub, preserveRelationships);

    const sheets = { 'Anonymized Data': scrubbed };
    if (exportMapping) {
      for (const [col, map] of Object.entries(mapping)) {
        const sheetName = `Map_${col}`.slice(0, 31);
        sheets[sheetName] = Object.entries(map).map(([original, anonymized]) => ({ original, anonymized }));
      }
    }

    const xlsxBuffer = await buildExcelReport(sheets);
    const fileName = req.file ? req.file.originalname.replace(/\.[^.]+$/, '') : req.body.table_name;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="scrubbed_${fileName}.xlsx"`);
    res.send(Buffer.from(xlsxBuffer));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Analyze Data ───────────────────────────────────────────────────────────
router.post('/analyze-data', upload.single('file'), async (req, res) => {
  try {
    const df = await getDataFrame(req);
    if (df.length === 0) return res.status(400).json({ error: 'Data source returned 0 rows.' });
    
    const analysis = analyzeDataFrame(df);
    const fileName = req.file ? req.file.originalname : req.body.table_name;
    res.json({ success: true, file_name: fileName, ...analysis });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Find Natural Keys ──────────────────────────────────────────────────────
router.post('/find-keys', upload.single('file'), async (req, res) => {
  try {
    let selectedColumns = [];
    try { selectedColumns = JSON.parse(req.body.selected_columns || '[]'); } catch { /* ignore */ }
    
    const df = await getDataFrame(req);
    if (df.length === 0) return res.status(400).json({ error: 'Data source returned 0 rows.' });
    
    const result = findNaturalKeys(df, selectedColumns);
    const fileName = req.file ? req.file.originalname : req.body.table_name;
    res.json({ success: true, file_name: fileName, row_count: df.length, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Legacy File-Only Schemas
router.post('/compare/schemas', upload.fields([{ name: 'file1', maxCount: 1 }, { name: 'file2', maxCount: 1 }]), async (req, res) => {
  try {
    const f1 = req.files?.file1?.[0]; const f2 = req.files?.file2?.[0];
    if (!f1 || !f2) return res.status(400).json({ error: 'Both file1 and file2 are required.' });
    const df1 = await parseFileBuffer(f1.buffer, f1.originalname);
    const df2 = await parseFileBuffer(f2.buffer, f2.originalname);
    const result = compareSchemas(df1, df2);
    res.json({ success: true, file1_name: f1.originalname, file2_name: f2.originalname, ...result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/compare/data', upload.fields([{ name: 'file1', maxCount: 1 }, { name: 'file2', maxCount: 1 }]), async (req, res) => {
  try {
    const f1 = req.files?.file1?.[0]; const f2 = req.files?.file2?.[0];
    if (!f1 || !f2) return res.status(400).json({ error: 'Both files are required.' });
    let keyColumns = []; let compareColumns = [];
    try { keyColumns = JSON.parse(req.body.key_columns || '[]'); } catch {}
    try { compareColumns = JSON.parse(req.body.compare_columns || '[]'); } catch {}
    if (keyColumns.length === 0) return res.status(400).json({ error: 'key_columns is required.' });
    const df1 = await parseFileBuffer(f1.buffer, f1.originalname);
    const df2 = await parseFileBuffer(f2.buffer, f2.originalname);
    const result = compareData(df1, df2, keyColumns, compareColumns);
    res.json({ success: true, file1_name: f1.originalname, file2_name: f2.originalname, key_columns: keyColumns, ...result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
