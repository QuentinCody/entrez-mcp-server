# Using Entrez MCP Tools from Cloudflare Code Mode

Cloudflare's Code Mode runtime mounts MCP tools on a `codemode` proxy object whose keys include hyphens (for example `tool_Z1YjsltQ_entrez-capabilities`). In JavaScript, the `.` operator treats hyphens as subtraction, so expressions such as `codemode.tool_Z1YjsltQ_entrez-capabilities` are parsed as `(codemode.tool_Z1YjsltQ_entrez) - capabilities`. Because `capabilities` (and similar suffixes like `api`, `query`, `external`) are not defined identifiers, the runtime throws `ReferenceError: capabilities is not defined` before your tool call even executes.

To avoid this, always look up the tool functions with bracket notation (or another indirection) and call them through that reference. The proxy object is also non-enumerable, so `Object.keys(codemode)` will not expose the available tool IDs—store the IDs you expect to use.

## Minimal Helper

```ts
const TOOL_IDS = {
  apiKey: "tool_Z1YjsltQ_system-api-key-status",
  query: "tool_Z1YjsltQ_entrez-query",
  data: "tool_Z1YjsltQ_entrez-data",
  external: "tool_Z1YjsltQ_entrez-external",
  capabilities: "tool_Z1YjsltQ_entrez-capabilities",
};

async function callTool(toolId, input) {
  const fn = codemode[toolId];
  if (typeof fn !== "function") {
    throw new Error(`Tool ${toolId} is not available in this Code Mode sandbox.`);
  }
  return fn(input);
}
```

Use `callTool(TOOL_IDS.query, { ... })` instead of dotted access, and the hyphenated identifiers will no longer trigger ReferenceErrors.

## End-to-End Demo Snippet

The following Code Mode function reproduces the “use all tools” workflow from the README by leveraging the helper above. It handles partial failures, avoids assuming array shapes, and returns a compact JSON payload.

```ts
async function runNcbiWorkflow() {
  const TOOL_IDS = {
    apiKey: "tool_Z1YjsltQ_system-api-key-status",
    query: "tool_Z1YjsltQ_entrez-query",
    data: "tool_Z1YjsltQ_entrez-data",
    external: "tool_Z1YjsltQ_entrez-external",
    capabilities: "tool_Z1YjsltQ_entrez-capabilities",
  };

  const callTool = async (toolId, input) => {
    const fn = codemode[toolId];
    if (typeof fn !== "function") {
      throw new Error(`Tool ${toolId} unavailable`);
    }
    return fn(input);
  };

  const result = {
    systemApiKey: {},
    tools: {},
    pubmed: {},
    staging: {},
    pubchem: {},
    pmc: {},
  };

  // 1) API key + rate limits
  try {
    const apiStatus = await callTool(TOOL_IDS.apiKey, {});
    result.systemApiKey = {
      present: !!apiStatus.keyPresent ?? apiStatus.present,
      rateLimits: apiStatus.rateLimits ?? apiStatus.rate_limit ?? apiStatus,
    };
  } catch (error) {
    result.systemApiKey = { error: error.message ?? String(error) };
  }

  // 2) Tool manifest / guidance
  try {
    const tools = await callTool(TOOL_IDS.capabilities, {
      format: "summary",
      include_metadata: false,
    });
    result.tools = tools;
  } catch (error) {
    result.tools = { error: error.message ?? String(error) };
  }

  // 3) PubMed search + summaries (last 7 days)
  let idList = [];
  try {
    const search = await callTool(TOOL_IDS.query, {
      operation: "search",
      database: "pubmed",
      term: "cancer immunotherapy",
      datetype: "pdat",
      reldate: 7,
      retmax: 3,
      retmode: "json",
    });
    idList = search?.esearchresult?.idlist ?? [];
    let firstTitle;
    if (idList.length) {
      const summaries = await callTool(TOOL_IDS.query, {
        operation: "summary",
        database: "pubmed",
        ids: idList.join(","),
        retmode: "json",
      });
      const uids = Array.isArray(summaries?.result?.uids)
        ? summaries.result.uids
        : Object.keys(summaries?.result ?? {}).filter((key) => key !== "uids");
      if (uids.length && summaries.result[uids[0]]?.title) {
        firstTitle = summaries.result[uids[0]].title;
      }
      result.pubmed.summaries = { count: uids.length, firstTitle };
    }
    result.pubmed.search = {
      ids: idList,
      count: idList.length,
    };
  } catch (error) {
    result.pubmed = { error: error.message ?? String(error) };
    idList = [];
  }

  // 4) Stage + SQL + smart summary
  try {
    if (idList.length) {
      const staged = await callTool(TOOL_IDS.data, {
        operation: "fetch_and_stage",
        database: "pubmed",
        ids: idList.join(","),
        rettype: "summary",
      });
      const accessId = staged?.data_access_id;
      result.staging.status = staged?.status ?? staged?.staging_status ?? staged;
      if (accessId) {
        const sql = await callTool(TOOL_IDS.data, {
          operation: "query",
          data_access_id: accessId,
          sql: "SELECT COUNT(*) AS total FROM data",
        });
        result.staging.count =
          Array.isArray(sql?.output) && sql.output[0]?.total !== undefined
            ? sql.output[0].total
            : sql;
        const summary = await callTool(TOOL_IDS.data, {
          operation: "query",
          data_access_id: accessId,
          smart_summary: true,
          max_tokens: 120,
        });
        result.staging.smartSummary =
          summary?.summary ?? summary?.output ?? summary;
      }
    } else {
      result.staging = { error: "No IDs to stage" };
    }
  } catch (error) {
    result.staging = { error: error.message ?? String(error) };
  }

  // 5) PubChem compounds
  try {
    const fetchCompound = async (cid) => {
      const data = await callTool(TOOL_IDS.external, {
        service: "pubchem",
        operation: "compound",
        identifier: `${cid}`,
        identifier_type: "cid",
        output_format: "json",
      });
      return { cid, raw: data };
    };
    const [caffeine, aspirin] = await Promise.all([
      fetchCompound(2519),
      fetchCompound(2244),
    ]);
    result.pubchem = { caffeine, aspirin };
  } catch (error) {
    result.pubchem = { error: error.message ?? String(error) };
  }

  // 6) PMC metadata
  try {
    const pmc = await callTool(TOOL_IDS.external, {
      service: "pmc",
      operation: "oa_service",
      id: "PMC7394273",
      output_format: "json",
    });
    result.pmc = {
      id: "PMC7394273",
      title: pmc?.record?.title ?? pmc?.title ?? pmc?.article_title,
    };
  } catch (error) {
    result.pmc = { error: error.message ?? String(error) };
  }

  return result;
}
```

Paste the helper or the entire workflow into the Code Mode editor, press “Run,” and the script will execute against the Entrez MCP server without hitting `capabilities is not defined`, `api is not defined`, etc.
