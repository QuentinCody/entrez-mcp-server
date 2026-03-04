/**
 * Catalog search — pure JS source injected into V8 isolates.
 *
 * Provides searchSpec(), listCategories(), getEndpoint(), describeEndpoint()
 * functions that operate on the frozen SPEC object inside the isolate.
 */

/**
 * Returns the JS source string to inject into V8 isolates.
 * The catalog JSON is embedded as a frozen global `SPEC`.
 */
export function buildCatalogSearchSource(catalogJson: string): string {
	return `
// --- Catalog search helpers (injected) ---
const SPEC = Object.freeze(JSON.parse(${JSON.stringify(catalogJson)}));

/**
 * Token-based fuzzy search across endpoints. Returns top N matches.
 */
function searchSpec(query, maxResults = 10) {
  const tokens = query.toLowerCase().split(/\\s+/).filter(Boolean);
  if (tokens.length === 0) return [];

  const scored = SPEC.endpoints.map(function(ep) {
    const text = [
      ep.path, ep.summary, ep.description || "",
      ep.category, ep.method,
      (ep.pathParams || []).map(function(p) { return p.name + " " + p.description; }).join(" "),
      (ep.queryParams || []).map(function(p) { return p.name + " " + p.description; }).join(" "),
    ].join(" ").toLowerCase();

    var score = 0;
    for (var i = 0; i < tokens.length; i++) {
      if (text.indexOf(tokens[i]) !== -1) score++;
    }
    return { endpoint: ep, score: score };
  });

  return scored
    .filter(function(s) { return s.score > 0; })
    .sort(function(a, b) { return b.score - a.score; })
    .slice(0, maxResults)
    .map(function(s) { return s.endpoint; });
}

/**
 * List all categories with endpoint counts.
 */
function listCategories() {
  var cats = {};
  for (var i = 0; i < SPEC.endpoints.length; i++) {
    var cat = SPEC.endpoints[i].category;
    cats[cat] = (cats[cat] || 0) + 1;
  }
  return Object.keys(cats).map(function(k) {
    return { category: k, count: cats[k] };
  });
}

/**
 * Get a specific endpoint by path and optional method.
 */
function getEndpoint(path, method) {
  for (var i = 0; i < SPEC.endpoints.length; i++) {
    var ep = SPEC.endpoints[i];
    if (ep.path === path && (!method || ep.method === method)) return ep;
  }
  return null;
}

/**
 * Describe an endpoint with full documentation.
 */
function describeEndpoint(path, method) {
  var ep = getEndpoint(path, method);
  if (!ep) return "Endpoint not found: " + (method || "GET") + " " + path;

  var lines = [
    ep.method + " " + ep.path,
    "Category: " + ep.category,
    "Summary: " + ep.summary,
  ];
  if (ep.description) lines.push("Description: " + ep.description);
  if (ep.coveredByTool) lines.push("Also available via tool: " + ep.coveredByTool);

  if (ep.pathParams && ep.pathParams.length > 0) {
    lines.push("Path parameters:");
    for (var i = 0; i < ep.pathParams.length; i++) {
      var p = ep.pathParams[i];
      lines.push("  " + p.name + " (" + p.type + ", " + (p.required ? "required" : "optional") + "): " + p.description);
    }
  }

  if (ep.queryParams && ep.queryParams.length > 0) {
    lines.push("Query parameters:");
    for (var j = 0; j < ep.queryParams.length; j++) {
      var q = ep.queryParams[j];
      var extra = [];
      if (q.default !== undefined) extra.push("default: " + JSON.stringify(q.default));
      if (q.enum) extra.push("values: " + JSON.stringify(q.enum));
      lines.push("  " + q.name + " (" + q.type + ", " + (q.required ? "required" : "optional") + "): " + q.description + (extra.length ? " [" + extra.join(", ") + "]" : ""));
    }
  }

  if (ep.body) {
    lines.push("Request body: " + ep.body.contentType + (ep.body.description ? " — " + ep.body.description : ""));
  }

  if (ep.response && ep.response.description) {
    lines.push("Response: " + ep.response.description);
  }

  return lines.join("\\n");
}
// --- End catalog search helpers ---
`;
}
