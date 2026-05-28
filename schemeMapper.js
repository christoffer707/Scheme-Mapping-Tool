import axios from 'axios';

/**
 * ServiceNow Scheme Mapper
 * Maps entire ServiceNow instance schema including tables, fields, relationships, and metadata
 */

class SchemeMapper {
  constructor(instance, username, password) {
    this.instance = instance;
    this.baseUrl = `https://${instance}.service-now.com/api/now`;
    this.auth = Buffer.from(`${username}:${password}`).toString('base64');
    this.headers = {
      'Authorization': `Basic ${this.auth}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    };
    this.cache = {
      tables: {},
      fields: {},
      relationships: [],
      metadata: {}
    };
  }

  /**
   * Fetch all tables from ServiceNow
   */
  async fetchAllTables(limit = 1000) {
    try {
      const response = await axios.get(`${this.baseUrl}/table/sys_db_object`, {
        headers: this.headers,
        timeout: 30000,
        params: {
          sysparm_limit: limit,
          sysparm_fields: 'name,label,sys_id,super_class,is_extendable,access_controls',
          sysparm_exclude_reference_link: true
        }
      });

      const tables = response.data.result || [];
      tables.forEach(table => {
        this.cache.tables[table.name] = {
          name: table.name,
          label: table.label,
          sysId: table.sys_id,
          superClass: table.super_class,
          isExtendable: table.is_extendable === '1',
          accessControls: table.access_controls
        };
      });

      return tables;
    } catch (error) {
      if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
        throw new Error(`Request timed out fetching tables from ${this.instance}. The instance may be slow or unreachable.`);
      }
      throw new Error(`Failed to fetch tables: ${error.message}`);
    }
  }

  /**
   * Fetch all fields for a specific table
   */
  async fetchTableFields(tableName) {
    try {
      const response = await axios.get(`${this.baseUrl}/table/sys_dictionary`, {
        headers: this.headers,
        timeout: 30000,
        params: {
          sysparm_query: `name=${tableName}^ORname=${tableName}%5EORDERBY%5Eelement`,
          sysparm_limit: 500,
          sysparm_fields: 'element,label,internal_type,reference,mandatory,read_only,unique,max_length,default_value,comments,choices',
          sysparm_exclude_reference_link: true
        }
      });

      const fields = response.data.result || [];
      this.cache.fields[tableName] = fields.map(field => ({
        name: field.element,
        label: field.label,
        type: field.internal_type,
        reference: field.reference,
        mandatory: field.mandatory === '1',
        readOnly: field.read_only === '1',
        unique: field.unique === '1',
        maxLength: field.max_length,
        defaultValue: field.default_value,
        comments: field.comments,
        choices: field.choices
      }));

      return this.cache.fields[tableName];
    } catch (error) {
      if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
        throw new Error(`Request timed out fetching fields for ${tableName}. The instance may be slow or unreachable.`);
      }
      throw new Error(`Failed to fetch fields for ${tableName}: ${error.message}`);
    }
  }

  /**
   * Analyze relationships between tables
   */
  analyzeRelationships() {
    const relationships = [];
    const relationshipMap = new Map();

    Object.entries(this.cache.fields).forEach(([tableName, fields]) => {
      fields.forEach(field => {
        if (field.reference && field.reference !== tableName) {
          const key = `${tableName}:${field.reference}:${field.name}`;
          
          if (!relationshipMap.has(key)) {
            relationships.push({
              id: key,
              from: tableName,
              to: field.reference,
              field: field.name,
              fieldLabel: field.label,
              type: 'foreign_key',
              mandatory: field.mandatory,
              cardinality: '1:N' // Default, can be refined
            });
            relationshipMap.set(key, true);
          }
        }
      });
    });

    this.cache.relationships = relationships;
    return relationships;
  }

  /**
   * Detect table inheritance hierarchy
   */
  buildInheritanceHierarchy() {
    const hierarchy = {};

    Object.entries(this.cache.tables).forEach(([name, table]) => {
      if (table.superClass) {
        if (!hierarchy[table.superClass]) {
          hierarchy[table.superClass] = [];
        }
        hierarchy[table.superClass].push(name);
      }
    });

    return hierarchy;
  }

  /**
   * Generate comprehensive schema map
   */
  async generateSchemeMap(tableLimit = 50) {
    try {
      console.log(`Fetching tables from ${this.instance}...`);
      const tables = await this.fetchAllTables(tableLimit);
      console.log(`Found ${tables.length} tables. Fetching fields...`);

      // Fetch fields for each table
      const tablesToProcess = tables.slice(0, tableLimit);
      for (let i = 0; i < tablesToProcess.length; i++) {
        const table = tablesToProcess[i];
        try {
          await this.fetchTableFields(table.name);
          if ((i + 1) % 10 === 0) {
            console.log(`Processed ${i + 1}/${tablesToProcess.length} tables`);
          }
        } catch (error) {
          console.warn(`Skipping ${table.name}: ${error.message}`);
        }
      }

      console.log('Analyzing relationships...');
      const relationships = this.analyzeRelationships();

      console.log('Building inheritance hierarchy...');
      const inheritance = this.buildInheritanceHierarchy();

      const schemeMap = {
        instance: this.instance,
        timestamp: new Date().toISOString(),
        summary: {
          totalTables: Object.keys(this.cache.tables).length,
          totalFields: Object.values(this.cache.fields).reduce((sum, fields) => sum + fields.length, 0),
          totalRelationships: relationships.length,
          inheritanceHierarchies: Object.keys(inheritance).length
        },
        tables: this.cache.tables,
        fields: this.cache.fields,
        relationships: relationships,
        inheritance: inheritance,
        metadata: {
          fetchedAt: new Date().toISOString(),
          version: '1.0'
        }
      };

      return schemeMap;
    } catch (error) {
      throw new Error(`Failed to generate scheme map: ${error.message}`);
    }
  }

  /**
   * Get table dependency graph
   */
  getTableDependencies(tableName) {
    const dependencies = {
      incoming: [], // Tables that reference this table
      outgoing: []  // Tables this table references
    };

    this.cache.relationships.forEach(rel => {
      if (rel.from === tableName) {
        dependencies.outgoing.push({
          table: rel.to,
          field: rel.field,
          mandatory: rel.mandatory
        });
      }
      if (rel.to === tableName) {
        dependencies.incoming.push({
          table: rel.from,
          field: rel.field,
          mandatory: rel.mandatory
        });
      }
    });

    return dependencies;
  }

  /**
   * Find circular dependencies
   */
  findCircularDependencies() {
    const visited = new Set();
    const recursionStack = new Set();
    const cycles = [];

    const dfs = (table, path) => {
      visited.add(table);
      recursionStack.add(table);
      path.push(table);

      const outgoing = this.cache.relationships
        .filter(rel => rel.from === table)
        .map(rel => rel.to);

      for (const nextTable of outgoing) {
        if (!visited.has(nextTable)) {
          dfs(nextTable, [...path]);
        } else if (recursionStack.has(nextTable)) {
          const cycleStart = path.indexOf(nextTable);
          cycles.push(path.slice(cycleStart).concat(nextTable));
        }
      }

      recursionStack.delete(table);
    };

    Object.keys(this.cache.tables).forEach(table => {
      if (!visited.has(table)) {
        dfs(table, []);
      }
    });

    return cycles;
  }

  /**
   * Export scheme map as JSON
   */
  exportJSON() {
    return JSON.stringify(this.cache, null, 2);
  }

  /**
   * Export scheme map as GraphQL schema
   */
  exportGraphQL() {
    let schema = '# Auto-generated GraphQL Schema from ServiceNow\n\n';

    Object.entries(this.cache.tables).forEach(([tableName, table]) => {
      const fields = this.cache.fields[tableName] || [];
      const typeName = this.camelCaseToTitleCase(tableName);

      schema += `type ${typeName} {\n`;
      schema += `  id: ID!\n`;

      fields.forEach(field => {
        const fieldType = this.mapServiceNowTypeToGraphQL(field.type);
        const required = field.mandatory ? '!' : '';
        schema += `  ${field.name}: ${fieldType}${required}\n`;
      });

      schema += `}\n\n`;
    });

    return schema;
  }

  /**
   * Helper: Map ServiceNow field types to GraphQL types
   */
  mapServiceNowTypeToGraphQL(snType) {
    const typeMap = {
      'string': 'String',
      'integer': 'Int',
      'decimal': 'Float',
      'boolean': 'Boolean',
      'date': 'String', // ISO date
      'datetime': 'String', // ISO datetime
      'reference': 'ID',
      'table_name': 'String',
      'user': 'String',
      'glide_date': 'String',
      'glide_date_time': 'String',
      'glide_duration': 'String',
      'glide_time': 'String',
      'glide_list': '[String]',
      'glide_var': 'String',
      'journal': 'String',
      'journal_input': 'String',
      'multi_two_lines': 'String',
      'script': 'String',
      'script_plain': 'String',
      'script_server': 'String',
      'translated_field': 'String',
      'translated_html': 'String',
      'translated_text': 'String',
      'url': 'String',
      'xml': 'String'
    };

    return typeMap[snType] || 'String';
  }

  /**
   * Helper: Convert snake_case to TitleCase
   */
  camelCaseToTitleCase(str) {
    return str
      .split('_')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join('');
  }
}

export default SchemeMapper;

