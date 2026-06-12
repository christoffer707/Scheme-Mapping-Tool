/**
 * routes/comparison.js
 * Express router for all comparison, analysis, and scrubbing endpoints.
 */

import { Router } from 'express';
import multer from 'multer';
import pdfParse from 'pdf-parse';
import { Document, Packer, Paragraph, TextRun } from 'docx';
import { fetchServiceNowTableData } from '../utils/servicenowAPI.js';
import {
  compareSchemas, compareData, scrubDataFrame, analyzeDataFrame, findNaturalKeys, parseFileBuffer,
  buildExcelReport, splitDataFrame, normalizeColumns, findAndReplace, columnOperations,
  rowFilter, calculatedColumns, transposeData, pivotData, dataMergeJoin
} from '../utils/dataProcessing.js';

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, 
  fileFilter(_req, file, cb) {
    const allowed = ['.csv', '.xlsx', '.xls', '.pdf'];
    const ext = '.' + file.originalname.split('.').pop().toLowerCase();
    if (allowed.includes(ext)) return cb(null, true);
    cb(new Error(`Unsupported file type: ${ext}.`));
  },
});

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

// ── NEW: Guided Pipeline Runner ────────────────────────────────────────────
router.post('/run-pipeline', upload.single('file'), async (req, res) => {
  try {
    let df = await getDataFrame(req);
    if (df.length === 0) return res.status(400).json({ error: 'Data source returned 0 rows.' });

    let transforms = [];
    try { transforms = JSON.parse(req.body.transforms || '[]'); } catch {}

    // Apply queued transformations sequentially in memory
    for (const t of transforms) {
      if (t.type === 'normalize' && t.columns.length > 0) {
        df = normalizeColumns(df, t.columns, t.action);
      } else if (t.type === 'drop' && t.columns.length > 0) {
        df = columnOperations(df, { drop: t.columns, rename: {} });
      }
    }

    const postAnalysis = analyzeDataFrame(df);

    const reportData = [
      { Metric: 'Pipeline Execution Date', Value: new Date().toISOString() },
      { Metric: 'Final Row Count', Value: postAnalysis.overview.row_count },
      { Metric: 'Final Column Count', Value: postAnalysis.overview.column_count },
      { Metric: 'Remaining Duplicates', Value: postAnalysis.overview.duplicate_rows },
      { Metric: 'Remaining Nulls', Value: postAnalysis.overview.total_nulls },
      { Metric: 'Transformations Applied', Value: transforms.length }
    ];

    const sheets = {
      'Cleaned Data': df,
      'Pipeline Report': reportData
    };

    const xlsxBuffer = await buildExcelReport(sheets);
    const fileName = req.file ? req.file.originalname.replace(/\.[^.]+$/, '') : req.body.table_name;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="pipeline_export_${fileName}.xlsx"`);
    res.send(Buffer.from(xlsxBuffer));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ── Document Conversion ────────────────────────────────────────────────────
router.post('/pdf-to-word', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Please upload a PDF file.' });
    const pdfData = await pdfParse(req.file.buffer);
    const lines = pdfData.text.split('\n');
    const doc = new Document({ sections: [{ properties: {}, children: lines.map(line => new Paragraph({ children: [new TextRun(line)] })) }] });
    const b64string = await Packer.toBase64String(doc);
    const buffer = Buffer.from(b64string, 'base64');
    const fileName = req.file.originalname.replace(/\.[^.]+$/, '');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}.docx"`);
    res.send(buffer);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Data Merge / Join ──────────────────────────────────────────────────────
router.post('/merge-data', upload.fields([{ name: 'file1', maxCount: 1 }, { name: 'file2', maxCount: 1 }]), async (req, res) => {
  try {
    const getDF = async (prefix) => {
      const mode = req.body[`mode${prefix}`];
      if (mode === 'file') {
        const file = req.files && req.files[`file${prefix}`] ? req.files[`file${prefix}`][0] : null;
        if (!file) throw new Error(`Source ${prefix} is set to File but no file was uploaded.`);
        return await parseFileBuffer(file.buffer, file.originalname);
      } else {
        const url = req.body[`url${prefix}`];
        const user = req.body[`user${prefix}`];
        const pass = req.body[`pass${prefix}`];
        const table = req.body[`table${prefix}`];
        const query = req.body[`query${prefix}`] || '';
        const limit = parseInt(req.body[`limit${prefix}`], 10) || 10000;
        if (!url || !table) throw new Error(`Source ${prefix} is missing live credentials or table name.`);
        const result = await fetchServiceNowTableData(url, user, pass, table, { query, limit });
        return result.rows;
      }
    };
    const df1 = await getDF('1'); const df2 = await getDF('2');
    if (df1.length === 0 || df2.length === 0) return res.status(400).json({ error: 'One or both data sources returned 0 rows.' });
    const { key1, key2, join_type } = req.body;
    if (!key1 || !key2) return res.status(400).json({ error: 'Join Keys for both sources are required.' });
    const merged = dataMergeJoin(df1, df2, key1, key2, join_type || 'left');
    const sheets = { 'Merged Data': merged };
    const xlsxBuffer = await buildExcelReport(sheets);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="merged_data.xlsx"`);
    res.send(Buffer.from(xlsxBuffer));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Existing Single-Source Endpoints ───────────────────────────────────────
router.post('/transpose-data', upload.single('file'), async (req, res) => {
  try {
    const df = await getDataFrame(req);
    if (df.length === 0) return res.status(400).json({ error: 'Data source returned 0 rows.' });
    const transposed = transposeData(df);
    const sheets = { 'Transposed Data': transposed };
    const xlsxBuffer = await buildExcelReport(sheets);
    const fileName = req.file ? req.file.originalname.replace(/\.[^.]+$/, '') : req.body.table_name;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="transposed_${fileName}.xlsx"`);
    res.send(Buffer.from(xlsxBuffer));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/pivot-data', upload.single('file'), async (req, res) => {
  try {
    const df = await getDataFrame(req);
    if (df.length === 0) return res.status(400).json({ error: 'Data source returned 0 rows.' });
    const { group_col, value_col, agg_func } = req.body;
    if (!group_col) return res.status(400).json({ error: 'Group By column is required.' });
    const pivoted = pivotData(df, group_col, value_col, agg_func || 'count');
    const sheets = { 'Pivot Table': pivoted };
    const xlsxBuffer = await buildExcelReport(sheets);
    const fileName = req.file ? req.file.originalname.replace(/\.[^.]+$/, '') : req.body.table_name;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="pivot_${fileName}.xlsx"`);
    res.send(Buffer.from(xlsxBuffer));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/row-filter', upload.single('file'), async (req, res) => {
  try {
    const df = await getDataFrame(req);
    if (df.length === 0) return res.status(400).json({ error: 'Data source returned 0 rows.' });
    const { filter_col, filter_op, filter_val } = req.body;
    if (!filter_col) return res.status(400).json({ error: 'Filter column is required.' });
    const filteredData = rowFilter(df, filter_col, filter_op, filter_val);
    const sheets = { 'Filtered Data': filteredData };
    const xlsxBuffer = await buildExcelReport(sheets);
    const fileName = req.file ? req.file.originalname.replace(/\.[^.]+$/, '') : req.body.table_name;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="filtered_${fileName}.xlsx"`);
    res.send(Buffer.from(xlsxBuffer));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/calculated-columns', upload.single('file'), async (req, res) => {
  try {
    const df = await getDataFrame(req);
    if (df.length === 0) return res.status(400).json({ error: 'Data source returned 0 rows.' });
    const { new_col_name, expression } = req.body;
    if (!new_col_name || !expression) return res.status(400).json({ error: 'New column name and expression are required.' });
    const calculatedData = calculatedColumns(df, new_col_name, expression);
    const sheets = { 'Calculated Data': calculatedData };
    const xlsxBuffer = await buildExcelReport(sheets);
    const fileName = req.file ? req.file.originalname.replace(/\.[^.]+$/, '') : req.body.table_name;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="calc_${fileName}.xlsx"`);
    res.send(Buffer.from(xlsxBuffer));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/find-replace', upload.single('file'), async (req, res) => {
  try {
    const df = await getDataFrame(req);
    if (df.length === 0) return res.status(400).json({ error: 'Data source returned 0 rows.' });
    let columns = [];
    try { columns = JSON.parse(req.body.columns || '[]'); } catch {}
    if (columns.length === 0) columns = Object.keys(df[0]); 
    const searchStr = req.body.search_str || '';
    const replaceStr = req.body.replace_str || '';
    const useRegex = req.body.use_regex === 'true';
    const matchCase = req.body.match_case === 'true';
    const processedData = findAndReplace(df, columns, searchStr, replaceStr, useRegex, matchCase);
    const sheets = { 'Modified Data': processedData };
    const xlsxBuffer = await buildExcelReport(sheets);
    const fileName = req.file ? req.file.originalname.replace(/\.[^.]+$/, '') : req.body.table_name;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="replaced_${fileName}.xlsx"`);
    res.send(Buffer.from(xlsxBuffer));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/column-ops', upload.single('file'), async (req, res) => {
  try {
    const df = await getDataFrame(req);
    if (df.length === 0) return res.status(400).json({ error: 'Data source returned 0 rows.' });
    let dropCols = []; let renameCols = {};
    try { dropCols = JSON.parse(req.body.drop_columns || '[]'); } catch {}
    try { renameCols = JSON.parse(req.body.rename_columns || '{}'); } catch {}
    const processedData = columnOperations(df, { drop: dropCols, rename: renameCols });
    const sheets = { 'Modified Data': processedData };
    const xlsxBuffer = await buildExcelReport(sheets);
    const fileName = req.file ? req.file.originalname.replace(/\.[^.]+$/, '') : req.body.table_name;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="col_ops_${fileName}.xlsx"`);
    res.send(Buffer.from(xlsxBuffer));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/split-data', upload.single('file'), async (req, res) => {
  try {
    const df = await getDataFrame(req);
    if (df.length === 0) return res.status(400).json({ error: 'Data source returned 0 rows.' });
    const chunkSize = parseInt(req.body.chunk_size, 10) || 5000;
    const chunks = splitDataFrame(df, chunkSize);
    const sheets = {};
    chunks.forEach((chunk, index) => { sheets[`Chunk_${index + 1}`] = chunk; });
    const xlsxBuffer = await buildExcelReport(sheets);
    const fileName = req.file ? req.file.originalname.replace(/\.[^.]+$/, '') : req.body.table_name;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="split_${fileName}.xlsx"`);
    res.send(Buffer.from(xlsxBuffer));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

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
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/find-duplicates', upload.single('file'), async (req, res) => {
  try {
    let checkColumns = [];
    try { checkColumns = JSON.parse(req.body.check_columns || '[]'); } catch {}
    const df = await getDataFrame(req);
    if (df.length === 0) return res.status(400).json({ error: 'Data source returned 0 rows.' });
    const colsToCompare = checkColumns.length > 0 ? checkColumns : Object.keys(df[0]);
    const seen = new Set(); const uniqueRows = []; const duplicateRows = [];
    for (const row of df) {
      const hash = colsToCompare.map(c => String(row[c] ?? '')).join('||');
      if (seen.has(hash)) { duplicateRows.push(row); } else { seen.add(hash); uniqueRows.push(row); }
    }
    const sheets = { 'Unique Data': uniqueRows, 'Removed Duplicates': duplicateRows };
    const xlsxBuffer = await buildExcelReport(sheets);
    const fileName = req.file ? req.file.originalname.replace(/\.[^.]+$/, '') : req.body.table_name;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="deduplicated_${fileName}.xlsx"`);
    res.send(Buffer.from(xlsxBuffer));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/scrub-data', upload.single('file'), async (req, res) => {
  try {
    let columnsToScrub = [];
    try { columnsToScrub = JSON.parse(req.body.columns_to_scrub || '[]'); } catch {}
    if (columnsToScrub.length === 0) return res.status(400).json({ error: 'columns_to_scrub must be a non-empty JSON array.' });
    const preserveRelationships = req.body.preserve_relationships !== 'false';
    const exportMapping = req.body.export_mapping !== 'false';
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
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/analyze-data', upload.single('file'), async (req, res) => {
  try {
    const df = await getDataFrame(req);
    if (df.length === 0) return res.status(400).json({ error: 'Data source returned 0 rows.' });
    const analysis = analyzeDataFrame(df);
    const fileName = req.file ? req.file.originalname : req.body.table_name;
    res.json({ success: true, file_name: fileName, ...analysis });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/find-keys', upload.single('file'), async (req, res) => {
  try {
    let selectedColumns = [];
    try { selectedColumns = JSON.parse(req.body.selected_columns || '[]'); } catch {}
    const df = await getDataFrame(req);
    if (df.length === 0) return res.status(400).json({ error: 'Data source returned 0 rows.' });
    const result = findNaturalKeys(df, selectedColumns);
    const fileName = req.file ? req.file.originalname : req.body.table_name;
    res.json({ success: true, file_name: fileName, row_count: df.length, ...result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
