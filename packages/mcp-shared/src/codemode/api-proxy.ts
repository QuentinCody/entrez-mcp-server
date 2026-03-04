/**
 * API Proxy source — pure JS injected into V8 isolates.
 *
 * Provides an `api` object with .get() and .post() methods that route
 * through the hidden __api_proxy tool back to the server's HTTP layer.
 * API keys never enter the isolate.
 *
 * Large responses (>100KB) are auto-staged into SQLite. When this happens,
 * the result has `__staged: true` with a `data_access_id` and `schema`.
 * LLM-generated code should check for this and return the staging info.
 */

/**
 * Returns the JS source string to inject into V8 isolates.
 * Relies on `codemode` proxy being available (from evaluator prefix).
 */
export function buildApiProxySource(): string {
	return `
// --- API proxy helpers (injected) ---
var api = {
  /**
   * GET request. Path params are interpolated: api.get("/lookup/id/{id}", { id: "ENSG..." })
   * becomes GET /lookup/id/ENSG...
   * Extra params become query string parameters.
   *
   * If the response is very large (>500KB), it is auto-staged into SQLite.
   * In that case the return value has __staged=true, data_access_id, and schema.
   * Return this object directly — the caller can use query_data to explore it.
   */
  get: async function(path, params) {
    var result = await codemode.__api_proxy({
      method: "GET",
      path: path,
      params: params || {},
    });
    if (result && result.__api_error) {
      var err = new Error("API error " + result.status + ": " + (result.message || "Unknown error"));
      err.status = result.status;
      err.data = result.data;
      throw err;
    }
    return result;
  },

  /**
   * POST request with JSON body.
   * Same staging behavior as api.get() for large responses.
   */
  post: async function(path, body, params) {
    var result = await codemode.__api_proxy({
      method: "POST",
      path: path,
      params: params || {},
      body: body,
    });
    if (result && result.__api_error) {
      var err = new Error("API error " + result.status + ": " + (result.message || "Unknown error"));
      err.status = result.status;
      err.data = result.data;
      throw err;
    }
    return result;
  },
};
// --- End API proxy helpers ---
`;
}
