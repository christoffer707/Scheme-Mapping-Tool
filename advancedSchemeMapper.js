import SchemeMapper from './schemeMapper.js';

/**
 * Advanced Scheme Mapper
 * Extends SchemeMapper with comprehensive analysis, metrics, and insights
 */

class AdvancedSchemeMapper extends SchemeMapper {
  constructor(instance, username, password) {
    super(instance, username, password);
    this.analysis = {
      tableMetrics: {},
      fieldMetrics: {},
      relationshipMetrics: {},
      complexityScore: 0,
      dataQualityScore: 0
    };
  }

  /**
   * Analyze table complexity and metrics
   */
  analyzeTableMetrics() {
    const metrics = {};

    Object.entries(this.cache.tables).forEach(([tableName, table]) => {
      const fields = this.cache.fields[tableName] || [];
      const incomingRels = this.cache.relationships.filter(r => r.to === tableName).length;
      const outgoingRels = this.cache.relationships.filter(r => r.from === tableName).length;
      const mandatoryFields = fields.filter(f => f.mandatory).length;
      const referenceFields = fields.filter(f => f.reference).length;

      metrics[tableName] = {
        name: tableName,
        label: table.label,
        fieldCount: fields.length,
        mandatoryFieldCount: mandatoryFields,
        referenceFieldCount: referenceFields,
        incomingRelationships: incomingRels,
        outgoingRelationships: outgoingRels,
        totalRelationships: incomingRels + outgoingRels,
        complexity: this.calculateTableComplexity(fields, incomingRels, outgoingRels),
        isExtendable: table.isExtendable,
        hasInheritance: !!table.superClass,
        superClass: table.superClass
      };
    });

    this.analysis.tableMetrics = metrics;
    return metrics;
  }

  /**
   * Calculate complexity score for a table
   */
  calculateTableComplexity(fields, incomingRels, outgoingRels) {
    let score = 0;
    
    // Field complexity
    score += fields.length * 0.5;
    score += fields.filter(f => f.reference).length * 2;
    score += fields.filter(f => f.mandatory).length * 1.5;
    
    // Relationship complexity
    score += incomingRels * 1.5;
    score += outgoingRels * 1.5;
    
    return Math.round(score);
  }

  /**
   * Analyze field types and distribution
   */
  analyzeFieldMetrics() {
    const metrics = {
      typeDistribution: {},
      mandatoryDistribution: {},
      referenceDistribution: {},
      totalFields: 0,
      mandatoryFields: 0,
      referenceFields: 0,
      uniqueFields: 0,
      readOnlyFields: 0
    };

    Object.values(this.cache.fields).forEach(fields => {
      fields.forEach(field => {
        metrics.totalFields++;
        
        // Type distribution
        const type = field.type || 'unknown';
        metrics.typeDistribution[type] = (metrics.typeDistribution[type] || 0) + 1;
        
        // Mandatory fields
        if (field.mandatory) {
          metrics.mandatoryFields++;
          metrics.mandatoryDistribution[type] = (metrics.mandatoryDistribution[type] || 0) + 1;
        }
        
        // Reference fields
        if (field.reference) {
          metrics.referenceFields++;
          metrics.referenceDistribution[field.reference] = (metrics.referenceDistribution[field.reference] || 0) + 1;
        }
        
        // Other metrics
        if (field.unique) metrics.uniqueFields++;
        if (field.readOnly) metrics.readOnlyFields++;
      });
    });

    this.analysis.fieldMetrics = metrics;
    return metrics;
  }

  /**
   * Analyze relationship patterns
   */
  analyzeRelationshipMetrics() {
    const metrics = {
      totalRelationships: this.cache.relationships.length,
      mandatoryRelationships: 0,
      optionalRelationships: 0,
      selfReferences: 0,
      circularDependencies: [],
      relationshipsByType: {},
      mostConnectedTables: [],
      orphanTables: []
    };

    // Analyze relationships
    this.cache.relationships.forEach(rel => {
      if (rel.mandatory) {
        metrics.mandatoryRelationships++;
      } else {
        metrics.optionalRelationships++;
      }

      if (rel.from === rel.to) {
        metrics.selfReferences++;
      }

      const key = `${rel.from}->${rel.to}`;
      metrics.relationshipsByType[key] = (metrics.relationshipsByType[key] || 0) + 1;
    });

    // Find most connected tables
    const connectionCounts = {};
    this.cache.relationships.forEach(rel => {
      connectionCounts[rel.from] = (connectionCounts[rel.from] || 0) + 1;
      connectionCounts[rel.to] = (connectionCounts[rel.to] || 0) + 1;
    });

    metrics.mostConnectedTables = Object.entries(connectionCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([table, count]) => ({ table, connectionCount: count }));

    // Find orphan tables (no relationships)
    const connectedTables = new Set();
    this.cache.relationships.forEach(rel => {
      connectedTables.add(rel.from);
      connectedTables.add(rel.to);
    });

    metrics.orphanTables = Object.keys(this.cache.tables)
      .filter(table => !connectedTables.has(table))
      .slice(0, 20);

    // Find circular dependencies
    metrics.circularDependencies = this.findCircularDependencies();

    this.analysis.relationshipMetrics = metrics;
    return metrics;
  }

  /**
   * Calculate overall complexity score
   */
  calculateComplexityScore() {
    const tableCount = Object.keys(this.cache.tables).length;
    const fieldCount = Object.values(this.cache.fields).reduce((sum, fields) => sum + fields.length, 0);
    const relationshipCount = this.cache.relationships.length;
    const avgFieldsPerTable = fieldCount / tableCount || 0;
    const avgRelationshipsPerTable = relationshipCount / tableCount || 0;

    let score = 0;
    score += Math.min(tableCount / 10, 20); // Table count (max 20 points)
    score += Math.min(avgFieldsPerTable / 2, 20); // Field density (max 20 points)
    score += Math.min(avgRelationshipsPerTable * 5, 20); // Relationship density (max 20 points)
    score += Math.min(this.findCircularDependencies().length * 5, 20); // Circular deps (max 20 points)
    score += Math.min(Object.values(this.cache.fields).filter(f => f.some(field => field.reference)).length / 5, 20); // Reference complexity (max 20 points)

    this.analysis.complexityScore = Math.round(score);
    return this.analysis.complexityScore;
  }

  /**
   * Calculate data quality score
   */
  calculateDataQualityScore() {
    let score = 100;
    const tableCount = Object.keys(this.cache.tables).length;

    // Deduct for orphan tables
    const orphanCount = this.analysis.relationshipMetrics?.orphanTables?.length || 0;
    score -= Math.min(orphanCount * 2, 20);

    // Deduct for circular dependencies
    const circularCount = this.analysis.relationshipMetrics?.circularDependencies?.length || 0;
    score -= Math.min(circularCount * 3, 20);

    // Deduct for tables with no mandatory fields
    const tablesWithoutMandatory = Object.entries(this.analysis.tableMetrics || {})
      .filter(([_, metrics]) => metrics.mandatoryFieldCount === 0).length;
    score -= Math.min(tablesWithoutMandatory * 1, 15);

    // Bonus for well-connected schema
    const avgConnections = (this.analysis.relationshipMetrics?.totalRelationships || 0) / tableCount;
    if (avgConnections > 2) score += 10;

    this.analysis.dataQualityScore = Math.max(0, Math.round(score));
    return this.analysis.dataQualityScore;
  }

  /**
   * Generate comprehensive analysis report
   */
  async generateAnalysisReport(tableLimit = 50) {
    // Generate base scheme map
    const schemeMap = await this.generateSchemeMap(tableLimit);

    // Run all analyses
    this.analyzeTableMetrics();
    this.analyzeFieldMetrics();
    this.analyzeRelationshipMetrics();
    this.calculateComplexityScore();
    this.calculateDataQualityScore();

    return {
      schemeMap,
      analysis: this.analysis,
      insights: this.generateInsights()
    };
  }

  /**
   * Generate actionable insights from analysis
   */
  generateInsights() {
    const insights = [];

    // Complexity insights
    if (this.analysis.complexityScore > 80) {
      insights.push({
        type: 'warning',
        category: 'complexity',
        message: 'High schema complexity detected. Consider breaking down large tables or simplifying relationships.',
        severity: 'high'
      });
    }

    // Circular dependency insights
    const circularCount = this.analysis.relationshipMetrics?.circularDependencies?.length || 0;
    if (circularCount > 0) {
      insights.push({
        type: 'warning',
        category: 'circular_dependencies',
        message: `Found ${circularCount} circular dependency chain(s). This may impact data integrity and query performance.`,
        severity: 'high',
        details: this.analysis.relationshipMetrics.circularDependencies
      });
    }

    // Orphan table insights
    const orphanCount = this.analysis.relationshipMetrics?.orphanTables?.length || 0;
    if (orphanCount > 0) {
      insights.push({
        type: 'info',
        category: 'orphan_tables',
        message: `Found ${orphanCount} tables with no relationships. These may be standalone lookup tables or unused tables.`,
        severity: 'low',
        details: this.analysis.relationshipMetrics.orphanTables
      });
    }

    // Data quality insights
    if (this.analysis.dataQualityScore < 70) {
      insights.push({
        type: 'warning',
        category: 'data_quality',
        message: 'Data quality score is below 70. Review schema design and relationships.',
        severity: 'medium'
      });
    }

    // Field type insights
    const fieldMetrics = this.analysis.fieldMetrics;
    const referenceFieldRatio = fieldMetrics.referenceFields / fieldMetrics.totalFields;
    if (referenceFieldRatio > 0.3) {
      insights.push({
        type: 'info',
        category: 'field_types',
        message: `High proportion of reference fields (${Math.round(referenceFieldRatio * 100)}%). Schema is heavily relational.`,
        severity: 'low'
      });
    }

    // Most connected tables insight
    const mostConnected = this.analysis.relationshipMetrics?.mostConnectedTables?.[0];
    if (mostConnected && mostConnected.connectionCount > 10) {
      insights.push({
        type: 'info',
        category: 'hub_tables',
        message: `Table "${mostConnected.table}" is a hub with ${mostConnected.connectionCount} connections. Ensure proper indexing.`,
        severity: 'low'
      });
    }

    return insights;
  }

  /**
   * Export detailed analysis as JSON
   */
  exportAnalysisJSON() {
    return JSON.stringify({
      analysis: this.analysis,
      insights: this.generateInsights()
    }, null, 2);
  }

  /**
   * Generate HTML report
   */
  generateHTMLReport() {
    const tableMetrics = this.analysis.tableMetrics || {};
    const fieldMetrics = this.analysis.fieldMetrics || {};
    const relMetrics = this.analysis.relationshipMetrics || {};
    const insights = this.generateInsights();

    let html = `
<!DOCTYPE html>
<html>
<head>
  <title>ServiceNow Schema Analysis Report</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 20px; background: #f5f5f5; }
    .container { max-width: 1200px; margin: 0 auto; background: white; padding: 20px; border-radius: 8px; }
    h1 { color: #0066cc; border-bottom: 2px solid #0066cc; padding-bottom: 10px; }
    h2 { color: #333; margin-top: 30px; }
    .metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; margin: 20px 0; }
    .metric-box { background: #f9f9f9; padding: 15px; border-radius: 4px; border-left: 4px solid #0066cc; }
    .metric-label { font-size: 12px; color: #666; text-transform: uppercase; }
    .metric-value { font-size: 28px; font-weight: bold; color: #0066cc; }
    .insight { padding: 15px; margin: 10px 0; border-radius: 4px; border-left: 4px solid; }
    .insight.warning { background: #fff3cd; border-color: #ffc107; }
    .insight.info { background: #d1ecf1; border-color: #17a2b8; }
    table { width: 100%; border-collapse: collapse; margin: 15px 0; }
    th, td { padding: 10px; text-align: left; border-bottom: 1px solid #ddd; }
    th { background: #f9f9f9; font-weight: bold; }
    tr:hover { background: #f5f5f5; }
    .score-bar { width: 100%; height: 20px; background: #ddd; border-radius: 4px; overflow: hidden; }
    .score-fill { height: 100%; background: #0066cc; }
  </style>
</head>
<body>
  <div class="container">
    <h1>ServiceNow Schema Analysis Report</h1>
    <p>Generated: ${new Date().toISOString()}</p>

    <h2>Overall Metrics</h2>
    <div class="metrics">
      <div class="metric-box">
        <div class="metric-label">Complexity Score</div>
        <div class="metric-value">${this.analysis.complexityScore}/100</div>
        <div class="score-bar"><div class="score-fill" style="width: ${this.analysis.complexityScore}%"></div></div>
      </div>
      <div class="metric-box">
        <div class="metric-label">Data Quality Score</div>
        <div class="metric-value">${this.analysis.dataQualityScore}/100</div>
        <div class="score-bar"><div class="score-fill" style="width: ${this.analysis.dataQualityScore}%"></div></div>
      </div>
      <div class="metric-box">
        <div class="metric-label">Total Tables</div>
        <div class="metric-value">${Object.keys(this.cache.tables).length}</div>
      </div>
      <div class="metric-box">
        <div class="metric-label">Total Fields</div>
        <div class="metric-value">${fieldMetrics.totalFields || 0}</div>
      </div>
      <div class="metric-box">
        <div class="metric-label">Total Relationships</div>
        <div class="metric-value">${relMetrics.totalRelationships || 0}</div>
      </div>
      <div class="metric-box">
        <div class="metric-label">Circular Dependencies</div>
        <div class="metric-value">${relMetrics.circularDependencies?.length || 0}</div>
      </div>
    </div>

    <h2>Insights & Recommendations</h2>
    ${insights.map(insight => `
      <div class="insight ${insight.type}">
        <strong>${insight.category.replace(/_/g, ' ').toUpperCase()}</strong>
        <p>${insight.message}</p>
      </div>
    `).join('')}

    <h2>Top Connected Tables</h2>
    <table>
      <tr><th>Table</th><th>Connections</th></tr>
      ${(relMetrics.mostConnectedTables || []).map(t => `
        <tr><td>${t.table}</td><td>${t.connectionCount}</td></tr>
      `).join('')}
    </table>

    <h2>Field Type Distribution</h2>
    <table>
      <tr><th>Type</th><th>Count</th><th>Percentage</th></tr>
      ${Object.entries(fieldMetrics.typeDistribution || {})
        .sort((a, b) => b[1] - a[1])
        .slice(0, 15)
        .map(([type, count]) => `
          <tr>
            <td>${type}</td>
            <td>${count}</td>
            <td>${Math.round((count / (fieldMetrics.totalFields || 1)) * 100)}%</td>
          </tr>
        `).join('')}
    </table>
  </div>
</body>
</html>
    `;

    return html;
  }
}

export default AdvancedSchemeMapper;

