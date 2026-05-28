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
   * Fetch UI Policies for a specific table
   */
  async fetchUIPolicies(tableName) {
    try {
      const response = await axios.get(`${this.baseUrl}/table/sys_ui_policy`, {
        headers: this.headers,
        timeout: 30000,
        params: {
          sysparm_query: `table=${tableName}`,
          sysparm_limit: 200,
          sysparm_fields: 'name,short_description,conditions,active,run_scripts,script_true,script_false,sys_id',
          sysparm_exclude_reference_link: true
        }
      });

      const policies = response.data.result || [];
      if (!this.cache.uiPolicies) this.cache.uiPolicies = {};
      this.cache.uiPolicies[tableName] = policies.map(p => ({
        sysId: p.sys_id,
        name: p.name,
        description: p.short_description,
        conditions: p.conditions,
        active: p.active === 'true' || p.active === true,
        runScripts: p.run_scripts === 'true' || p.run_scripts === true,
        scriptTrue: p.script_true,
        scriptFalse: p.script_false
      }));

      return this.cache.uiPolicies[tableName];
    } catch (error) {
      if (!this.cache.uiPolicies) this.cache.uiPolicies = {};
      this.cache.uiPolicies[tableName] = [];
      return [];
    }
  }

  /**
   * Fetch UI Policy Actions for a specific table
   */
  async fetchUIPolicyActions(tableName) {
    try {
      const response = await axios.get(`${this.baseUrl}/table/sys_ui_policy_action`, {
        headers: this.headers,
        timeout: 30000,
        params: {
          sysparm_query: `ui_policy.table=${tableName}`,
          sysparm_limit: 500,
          sysparm_fields: 'field,mandatory,visible,read_only,ui_policy,sys_id',
          sysparm_exclude_reference_link: true
        }
      });

      const actions = response.data.result || [];
      if (!this.cache.uiPolicyActions) this.cache.uiPolicyActions = {};
      this.cache.uiPolicyActions[tableName] = actions.map(a => ({
        sysId: a.sys_id,
        field: a.field,
        mandatory: a.mandatory,
        visible: a.visible,
        readOnly: a.read_only,
        uiPolicyId: typeof a.ui_policy === 'object' ? a.ui_policy.value : a.ui_policy
      }));

      return this.cache.uiPolicyActions[tableName];
    } catch (error) {
      if (!this.cache.uiPolicyActions) this.cache.uiPolicyActions = {};
      this.cache.uiPolicyActions[tableName] = [];
      return [];
    }
  }

  /**
   * Fetch Business Rules for a specific table
   */
  async fetchBusinessRules(tableName) {
    try {
      const response = await axios.get(`${this.baseUrl}/table/sys_script`, {
        headers: this.headers,
        timeout: 30000,
        params: {
          sysparm_query: `collection=${tableName}`,
          sysparm_limit: 200,
          sysparm_fields: 'name,active,when,order,filter_condition,script,add_message,message,abort_action,sys_id',
          sysparm_exclude_reference_link: true
        }
      });

      const rules = response.data.result || [];
      if (!this.cache.businessRules) this.cache.businessRules = {};
      this.cache.businessRules[tableName] = rules.map(r => ({
        sysId: r.sys_id,
        name: r.name,
        active: r.active === 'true' || r.active === true,
        when: r.when,
        order: r.order,
        filterCondition: r.filter_condition,
        script: r.script,
        addMessage: r.add_message === 'true' || r.add_message === true,
        message: r.message,
        abortAction: r.abort_action === 'true' || r.abort_action === true
      }));

      return this.cache.businessRules[tableName];
    } catch (error) {
      if (!this.cache.businessRules) this.cache.businessRules = {};
      this.cache.businessRules[tableName] = [];
      return [];
    }
  }

  /**
   * Fetch Script Includes referenced by a table's business rules / UI policies
   */
  async fetchScriptIncludes(tableName) {
    try {
      // Fetch all script includes (they are global, not table-scoped)
      // We search for ones whose name appears in the business rules for this table
      const rules = this.cache.businessRules ? (this.cache.businessRules[tableName] || []) : [];
      const policies = this.cache.uiPolicies ? (this.cache.uiPolicies[tableName] || []) : [];

      // Collect all script text to search for include names
      const allScripts = [
        ...rules.map(r => r.script || ''),
        ...policies.map(p => (p.scriptTrue || '') + ' ' + (p.scriptFalse || ''))
      ].join('\n');

      // Also fetch script includes that are scoped to the same app scope as the table
      const response = await axios.get(`${this.baseUrl}/table/sys_script_include`, {
        headers: this.headers,
        timeout: 30000,
        params: {
          sysparm_limit: 200,
          sysparm_fields: 'name,description,active,access,script,api_name,sys_id,sys_scope',
          sysparm_exclude_reference_link: true
        }
      });

      const includes = response.data.result || [];
      if (!this.cache.scriptIncludes) this.cache.scriptIncludes = {};

      // Filter to those referenced in scripts, or return all if no scripts exist
      const referenced = includes.filter(inc => {
        if (!allScripts.trim()) return true; // return all if no scripts to search
        return allScripts.includes(inc.name);
      });

      this.cache.scriptIncludes[tableName] = (referenced.length > 0 ? referenced : includes.slice(0, 50)).map(inc => ({
        sysId: inc.sys_id,
        name: inc.name,
        description: inc.description,
        active: inc.active === 'true' || inc.active === true,
        access: inc.access,
        script: inc.script,
        apiName: inc.api_name,
        scope: typeof inc.sys_scope === 'object' ? inc.sys_scope.display_value : inc.sys_scope
      }));

      return this.cache.scriptIncludes[tableName];
    } catch (error) {
      if (!this.cache.scriptIncludes) this.cache.scriptIncludes = {};
      this.cache.scriptIncludes[tableName] = [];
      return [];
    }
  }

  /**
   * Fetch Flows (Flow Designer) for a specific table
   */
  async fetchFlows(tableName) {
    try {
      const response = await axios.get(`${this.baseUrl}/table/sys_hub_flow`, {
        headers: this.headers,
        timeout: 30000,
        params: {
          sysparm_query: `table_name=${tableName}^ORtrigger_table=${tableName}`,
          sysparm_limit: 100,
          sysparm_fields: 'name,description,active,trigger_type,table_name,sys_id,status,run_as',
          sysparm_exclude_reference_link: true
        }
      });

      const flows = response.data.result || [];
      if (!this.cache.flows) this.cache.flows = {};
      this.cache.flows[tableName] = flows.map(f => ({
        sysId: f.sys_id,
        name: f.name,
        description: f.description,
        active: f.active === 'true' || f.active === true,
        triggerType: f.trigger_type,
        tableName: f.table_name,
        status: f.status,
        runAs: f.run_as
      }));

      return this.cache.flows[tableName];
    } catch (error) {
      if (!this.cache.flows) this.cache.flows = {};
      this.cache.flows[tableName] = [];
      return [];
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
   * Fetch all extended metadata for a single table (on-demand)
   */
  async fetchTableDetails(tableName) {
    const [uiPolicies, uiPolicyActions, businessRules, flows] = await Promise.all([
      this.fetchUIPolicies(tableName),
      this.fetchUIPolicyActions(tableName),
      this.fetchBusinessRules(tableName),
      this.fetchFlows(tableName)
    ]);
    // Script includes depend on business rules being fetched first
    const scriptIncludes = await this.fetchScriptIncludes(tableName);

    return {
      tableName,
      fields: this.cache.fields[tableName] || [],
      uiPolicies,
      uiPolicyActions,
      businessRules,
      scriptIncludes,
      flows
    };
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

