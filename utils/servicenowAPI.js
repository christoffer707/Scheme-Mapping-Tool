// ---------------------------------------------------------------------------
// Table Artifacts (Drill-Down)
// ---------------------------------------------------------------------------

/**
 * Fetch related artifacts (Business Rules, Client Scripts, UI Policies) for a specific table.
 */
export async function fetchServiceNowTableArtifacts(instanceUrl, username, password, tableName) {
  const url = normaliseInstanceUrl(instanceUrl);
  const client = buildClient(url, username, password);

  try {
    // Run all artifact queries concurrently to speed up the drill-down response
    const [brRes, csRes, uiRes] = await Promise.allSettled([
      // Business Rules (sys_script) where collection = table
      client.get('/api/now/table/sys_script', {
        params: {
          sysparm_query: `collection=${tableName}`,
          sysparm_limit: 100,
          sysparm_fields: 'name,active,when,action_insert,action_update,action_delete,action_query',
        }
      }),
      // Client Scripts (sys_script_client) where table = table
      client.get('/api/now/table/sys_script_client', {
        params: {
          sysparm_query: `table=${tableName}`,
          sysparm_limit: 100,
          sysparm_fields: 'name,active,type',
        }
      }),
      // UI Policies (sys_ui_policy) where table = table
      client.get('/api/now/table/sys_ui_policy', {
        params: {
          sysparm_query: `table=${tableName}`,
          sysparm_limit: 100,
          sysparm_fields: 'short_description,active',
        }
      })
    ]);

    // Safely extract the results
    const businessRules = brRes.status === 'fulfilled' ? (brRes.value.data.result || []) : [];
    const clientScripts = csRes.status === 'fulfilled' ? (csRes.value.data.result || []) : [];
    const uiPolicies    = uiRes.status === 'fulfilled' ? (uiRes.value.data.result || []) : [];

    return {
      table: tableName,
      businessRules,
      clientScripts,
      uiPolicies
    };
  } catch (err) {
    throw new Error(`Failed to fetch artifacts for ${tableName}: ${err.message}`);
  }
}
