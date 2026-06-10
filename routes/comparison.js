/**
 * routes/comparison.js
 * Express router for all comparison, analysis, and scrubbing endpoints.
 * Mounts at /api in server.js.
 */

import { Router } from 'express';
import multer from 'multer';
import {
  compareSchemas,
  compareData,
  scrubDataFrame,
  analyzeDataFrame,
  findNaturalKeys,
  detectSemanticType,
  parseFileBuffer,
  buildExcelReport,
} from '../utils/dataProcessing.js';

const router = Router();

// ---------------------------------------------------------------------------
// Multer — in-memory storage (no disk writes)
// ---------------------------------------------------------------------------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB per file
  fileFilter(_req, file, cb) {
    const allowed = ['.csv', '.xlsx', '.xls'];
    const ext = '.' + file.originalname.split('.').pop().toLowerCase();
    if (allowed.includes(ext)) return cb(null, true);
    cb(new Error(`Unsupported file type: ${ext}. Allowed: ${allowed.join(', ')}`));
  },
});

// ---------------------------------------------------------------------------
// SSE progress helper
// ---------------------------------------------------------------------------
function sseWrite(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// ---------------------------------------------------------------------------
// POST /api/compare/schemas
// Body (multipart): file1, file2
// ---------------------------------------------------------------------------
router.post('/compare/schemas', upload.fields([{ name: 'file1', maxCount: 1 }, { name: 'file2', maxCount: 1 }]), async (req, res) => {
  try {
    const f1 = req.files?.file1?.[0];
    const f2 = req.files?.file2?.[0];
    if (!f1 || !f2) return res.status(400).json({ error: 'Both file1 and file2 are required.' });

    const df1 = await parseFileBuffer(f1.buffer, f1.originalname);
    const df2 = await parseFileBuffer(f2.buffer, f2.originalname);

    const result = compareSchemas(df1, df2);

    res.json({
      success: true,
      file1_name: f1.originalname,
      file2_name: f2.originalname,
      ...result,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/compare/data
// Body (multipart): file1, file2, key_columns (JSON array), compare_columns (JSON array, optional)
// ---------------------------------------------------------------------------
router.post('/compare/data', upload.fields([{ name: 'file1', maxCount: 1 }, { name: 'file2', maxCount: 1 }]), async (req, res) => {
  try {
    const f1 = req.files?.file1?.[0];
    const f2 = req.files?.file2?.[0];
    if (!f1 || !f2) return res.status(400).json({ error: 'Both file1 and file2 are required.' });

    let keyColumns = [];
    let compareColumns = [];

    try { keyColumns     = JSON.parse(req.body.key_columns     || '[]'); } catch { /* ignore */ }
    try { compareColumns = JSON.parse(req.body.compare_columns || '[]'); } catch { /* ignore */ }

    if (keyColumns.length === 0) {
      return res.status(400).json({ error: 'key_columns is required and must be a non-empty JSON array.' });
    }

    const df1 = await parseFileBuffer(f1.buffer, f1.originalname);
    const df2 = await parseFileBuffer(f2.buffer, f2.originalname);

    // Validate key columns exist in both files
    const cols1 = df1.length > 0 ? Object.keys(df1[0]) : [];
    const cols2 = df2.length > 0 ? Object.keys(df2[0]) : [];
    const missingIn1 = keyColumns.filter(c => !cols1.includes(c));
    const missingIn2 = keyColumns.filter(c => !cols2.includes(c));
    if (missingIn1.length > 0) return res.status(400).json({ error: `Key columns missing in file1: ${missingIn1.join(', ')}` });
    if (missingIn2.length > 0) return res.status(400).json({ error: `Key columns missing in file2: ${missingIn2.join(', ')}` });

    const result = compareData(df1, df2, keyColumns, compareColumns);

    res.json({
      success: true,
      file1_name: f1.originalname,
      file2_name: f2.originalname,
      key_columns: keyColumns,
      ...result,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/scrub-data
// Body (multipart): file, columns_to_scrub (JSON array), preserve_relationships (bool), export_mapping (bool)
// ---------------------------------------------------------------------------
router.post('/scrub-data', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'A file is required.' });

    let columnsToScrub = [];
    try { columnsToScrub = JSON.parse(req.body.columns_to_scrub || '[]'); } catch { /* ignore */ }
    if (columnsToScrub.length === 0) return res.status(400).json({ error: 'columns_to_scrub must be a non-empty JSON array.' });

    const preserveRelationships = req.body.preserve_relationships !== 'false';
    const exportMapping         = req.body.export_mapping !== 'false';

    const df = await parseFileBuffer(req.file.buffer, req.file.originalname);

    // Validate columns exist
    const cols = df.length > 0 ? Object.keys(df[0]) : [];
    const missing = columnsToScrub.filter(c => !cols.includes(c));
    if (missing.length > 0) return res.status(400).json({ error: `Columns not found in file: ${missing.join(', ')}` });

    const { data: scrubbed, mapping } = scrubDataFrame(df, columnsToScrub, preserveRelationships);

    // Build Excel report
    const sheets = { 'Anonymized Data': scrubbed };
    if (exportMapping) {
      for (const [col, map] of Object.entries(mapping)) {
        const sheetName = `Map_${col}`.slice(0, 31);
        sheets[sheetName] = Object.entries(map).map(([original, anonymized]) => ({ original, anonymized }));
      }
    }

    const xlsxBuffer = await buildExcelReport(sheets);

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="scrubbed_${req.file.originalname.replace(/\.[^.]+$/, '')}.xlsx"`);
    res.send(Buffer.from(xlsxBuffer));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/analyze-data
// Body (multipart): file
// ---------------------------------------------------------------------------
router.post('/analyze-data', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'A file is required.' });

    const df = await parseFileBuffer(req.file.buffer, req.file.originalname);
    const analysis = analyzeDataFrame(df);

    res.json({
      success: true,
      file_name: req.file.originalname,
      ...analysis,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/find-keys
// Body (multipart): file, selected_columns (JSON array, optional)
// ---------------------------------------------------------------------------
router.post('/find-keys', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'A file is required.' });

    let selectedColumns = [];
    try { selectedColumns = JSON.parse(req.body.selected_columns || '[]'); } catch { /* ignore */ }

    const df = await parseFileBuffer(req.file.buffer, req.file.originalname);
    const result = findNaturalKeys(df, selectedColumns);

    res.json({
      success: true,
      file_name: req.file.originalname,
      row_count: df.length,
      ...result,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/compare/report  (full comparison + Excel download)
// Body (multipart): file1, file2, key_columns, compare_columns, include_schema, include_data
// ---------------------------------------------------------------------------
router.post('/compare/report', upload.fields([{ name: 'file1', maxCount: 1 }, { name: 'file2', maxCount: 1 }]), async (req, res) => {
  try {
    const f1 = req.files?.file1?.[0];
    const f2 = req.files?.file2?.[0];
    if (!f1 || !f2) return res.status(400).json({ error: 'Both file1 and file2 are required.' });

    let keyColumns     = [];
    let compareColumns = [];
    try { keyColumns     = JSON.parse(req.body.key_columns     || '[]'); } catch { /* ignore */ }
    try { compareColumns = JSON.parse(req.body.compare_columns || '[]'); } catch { /* ignore */ }

    const includeSchema = req.body.include_schema !== 'false';
    const includeData   = req.body.include_data   !== 'false';

    const df1 = await parseFileBuffer(f1.buffer, f1.originalname);
    const df2 = await parseFileBuffer(f2.buffer, f2.originalname);

    const sheets = {};

    // Summary sheet
    sheets['Summary'] = [
      { item: 'File 1',       value: f1.originalname },
      { item: 'File 2',       value: f2.originalname },
      { item: 'File 1 Rows',  value: df1.length },
      { item: 'File 2 Rows',  value: df2.length },
      { item: 'Generated At', value: new Date().toISOString() },
    ];

    if (includeSchema) {
      const schema = compareSchemas(df1, df2);
      sheets['Schema - Common']  = schema.comparison_data;
      sheets['Schema - Added']   = schema.added.map(c => ({ column: c }));
      sheets['Schema - Removed'] = schema.removed.map(c => ({ column: c }));
    }

    if (includeData && keyColumns.length > 0) {
      const dataDiff = compareData(df1, df2, keyColumns, compareColumns);
      sheets['Data - Added']   = dataDiff.added_rows;
      sheets['Data - Removed'] = dataDiff.removed_rows;
      sheets['Data - Changed'] = dataDiff.changed_rows.map(r => ({
        key: r.key,
        ...r.key_values,
        changes: JSON.stringify(r.changes),
      }));
    }

    const xlsxBuffer = await buildExcelReport(sheets);

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="comparison_report.xlsx"');
    res.send(Buffer.from(xlsxBuffer));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/compare/progress  (SSE stream — demo endpoint)
// Clients connect here to receive progress events during long operations.
// Real progress is emitted by the individual endpoints above via a shared
// in-memory event bus keyed by a client-supplied jobId.
// ---------------------------------------------------------------------------
const progressClients = new Map(); // jobId -> res

router.get('/progress/:jobId', (req, res) => {
  const { jobId } = req.params;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  progressClients.set(jobId, res);

  req.on('close', () => {
    progressClients.delete(jobId);
  });
});

export function emitProgress(jobId, step, total, message) {
  const client = progressClients.get(jobId);
  if (client) {
    sseWrite(client, 'progress', { step, total, message, pct: Math.round((step / total) * 100) });
    if (step >= total) {
      sseWrite(client, 'done', { message: 'Complete' });
      client.end();
      progressClients.delete(jobId);
    }
  }
}

export default router;
