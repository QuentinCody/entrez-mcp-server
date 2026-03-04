/**
 * Execute tool factory — creates a `<prefix>_execute` tool for Code Mode.
 *
 * Uses DynamicWorkerExecutor (inlined from @cloudflare/codemode) to run user
 * code in a sandboxed V8 isolate via the Worker Loader binding.
 *
 * The isolate gets:
 * - codemode.__api_proxy() — routes API calls through server HTTP layer
 * - Pre-injected catalog search helpers (searchSpec, listCategories, etc.)
 * - Pre-injected api.get/api.post wrappers
 * - console.log() capture
 *
 * API keys never enter the isolate — all HTTP goes through the host's apiFetch.
 */

import { z } from "zod";
import { RpcTarget } from "cloudflare:workers";
import type { ApiCatalog, ApiFetchFn } from "./catalog";
import { buildCatalogSearchSource } from "./catalog-search";
import { buildApiProxySource } from "./api-proxy";
import { createApiProxyTool, type ApiProxyToolOptions } from "../tools/api-proxy";
import { createCodeModeResponse, createCodeModeError, ErrorCodes } from "./response";

// ---------------------------------------------------------------------------
// Inlined from @cloudflare/codemode v0.1.1 — avoids bundling zod-to-ts →
// typescript (CJS, uses __filename, crashes Workers).
// Only DynamicWorkerExecutor + ToolDispatcher are needed.
// ---------------------------------------------------------------------------

type ExecutorFns = Record<string, (...args: unknown[]) => Promise<unknown>>;

interface ExecutorResult {
  result?: unknown;
  error?: string;
  logs?: string[];
}

/** RPC target that dispatches tool calls from the isolate back to the host. */
class ToolDispatcher extends RpcTarget {
  #fns: ExecutorFns;
  constructor(fns: ExecutorFns) {
    super();
    this.#fns = fns;
  }
  async call(name: string, argsJson: string): Promise<string> {
    const fn = this.#fns[name];
    if (!fn) return JSON.stringify({ error: `Tool "${name}" not found` });
    try {
      const result = await fn(argsJson ? JSON.parse(argsJson) : {});
      return JSON.stringify({ result });
    } catch (err) {
      return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
    }
  }
}

/** Executes code in an isolated V8 Worker via the Worker Loader binding. */
class DynamicWorkerExecutor {
  #loader: any;
  #timeout: number;

  constructor(options: { loader: unknown; timeout?: number }) {
    this.#loader = options.loader;
    this.#timeout = options.timeout ?? 30_000;
  }

  async execute(code: string, fns: ExecutorFns): Promise<ExecutorResult> {
    const timeoutMs = this.#timeout;
    const modulePrefix = [
      'import { WorkerEntrypoint } from "cloudflare:workers";',
      "",
      "export default class CodeExecutor extends WorkerEntrypoint {",
      "  async evaluate(dispatcher) {",
      "    const __logs = [];",
      '    console.log = (...a) => { __logs.push(a.map(String).join(" ")); };',
      '    console.warn = (...a) => { __logs.push("[warn] " + a.map(String).join(" ")); };',
      '    console.error = (...a) => { __logs.push("[error] " + a.map(String).join(" ")); };',
      "    const codemode = new Proxy({}, {",
      "      get: (_, toolName) => async (args) => {",
      "        const resJson = await dispatcher.call(String(toolName), JSON.stringify(args ?? {}));",
      "        const data = JSON.parse(resJson);",
      "        if (data.error) throw new Error(data.error);",
      "        return data.result;",
      "      }",
      "    });",
      "",
      "    try {",
      "      const result = await Promise.race([",
      "        (",
    ].join("\n");

    const moduleSuffix = [
      ")(),",
      `        new Promise((_, reject) => setTimeout(() => reject(new Error("Execution timed out")), ${timeoutMs}))`,
      "      ]);",
      "      return { result, logs: __logs };",
      "    } catch (err) {",
      "      return { result: undefined, error: err.message, logs: __logs };",
      "    }",
      "  }",
      "}",
    ].join("\n");

    const executorModule = modulePrefix + code + moduleSuffix;
    const dispatcher = new ToolDispatcher(fns);

    const response = await this.#loader
      .get(`codemode-${crypto.randomUUID()}`, () => ({
        compatibilityDate: "2025-06-01",
        compatibilityFlags: ["nodejs_compat"],
        mainModule: "executor.js",
        modules: { "executor.js": executorModule },
        globalOutbound: null,
      }))
      .getEntrypoint()
      .evaluate(dispatcher);

    if (response.error) {
      return { result: undefined, error: response.error, logs: response.logs };
    }
    return { result: response.result, logs: response.logs };
  }
}

// ---------------------------------------------------------------------------
// Execute tool factory
// ---------------------------------------------------------------------------

export interface ExecuteToolOptions {
  /** Tool name prefix (e.g., "gtex" → "gtex_execute") */
  prefix: string;
  /** The API catalog (frozen inside the isolate) */
  catalog: ApiCatalog;
  /** Server's HTTP fetch adapter */
  apiFetch: ApiFetchFn;
  /** DO namespace for auto-staging large responses */
  doNamespace?: unknown;
  /** Worker Loader binding for V8 isolate creation */
  loader: unknown;
  /** Byte threshold for auto-staging (default 100KB) */
  stagingThreshold?: number;
  /** Execution timeout in ms (default 30000) */
  timeout?: number;
  /** Optional JavaScript source injected into the isolate before user code.
   *  Use to provide domain-specific helper functions (e.g. stats.computePRR). */
  preamble?: string;
}

/**
 * Build the user code wrapped with catalog search + API proxy helpers.
 */
function wrapUserCode(catalogJson: string, userCode: string, preamble?: string): string {
  const catalogSearch = buildCatalogSearchSource(catalogJson);
  const apiProxy = buildApiProxySource();

  return `async () => {
${catalogSearch}
${apiProxy}
${preamble ? `\n// --- Preamble (domain helpers) ---\n${preamble}\n// --- End preamble ---\n` : ""}
// --- User code ---
${userCode}
// --- End user code ---
}`;
}

/**
 * Create an execute tool registration object.
 */
export function createExecuteTool(options: ExecuteToolOptions) {
  const {
    prefix,
    catalog,
    apiFetch,
    doNamespace,
    loader,
    stagingThreshold,
    timeout = 30_000,
    preamble,
  } = options;

  const toolName = `${prefix}_execute`;
  const catalogJson = JSON.stringify(catalog);

  // Create the __api_proxy handler
  const apiProxyToolOpts: ApiProxyToolOptions = {
    apiFetch,
    doNamespace,
    stagingPrefix: prefix,
    stagingThreshold,
  };
  const apiProxyTool = createApiProxyTool(apiProxyToolOpts);

  // Build the function map for the executor
  const executorFns: ExecutorFns = {
    __api_proxy: async (args: unknown) => {
      const input = (args ?? {}) as Record<string, unknown>;
      return apiProxyTool.handler(input, {} as any);
    },
  };

  return {
    name: toolName,
    apiProxyTool,
    description:
      `Execute JavaScript code against the ${catalog.name} API (${catalog.endpointCount} endpoints). ` +
      `Code runs in a sandboxed V8 isolate with:\n` +
      `- api.get(path, params) — make GET requests (path params auto-interpolated from params object)\n` +
      `- api.post(path, body, params) — make POST requests\n` +
      `- searchSpec(query) — search the API catalog\n` +
      `- listCategories() — list endpoint categories\n` +
      `- getEndpoint(path) — get full endpoint docs\n` +
      `- console.log() — output logging\n` +
      (preamble ? `\nDomain-specific helper functions are also available — see the catalog notes for details.\n` : "") +
      `\nUse ${prefix}_search first to discover endpoints, then write code here to call them.\n` +
      `The last expression or return value is the result.\n\n` +
      `STAGING: Large responses (>100KB) are auto-staged into SQLite. When this happens, ` +
      `api.get/api.post returns {__staged: true, data_access_id, schema, tables_created, total_rows, message}. ` +
      `Check result.__staged and return the staging info — use ${prefix}_query_data with the data_access_id to explore staged data.\n\n` +
      `IMPORTANT: Use limit/pagination params to keep responses small. If you need large datasets, let them auto-stage and use ${prefix}_query_data to query with SQL.`,
    schema: {
      code: z.string().describe(
        "JavaScript code to execute. Use api.get/api.post for API calls. " +
          "The last expression or explicit return value becomes the result. " +
          "Example: return await api.get('/dataset/tissueSiteDetail')",
      ),
    },

    register(server: { tool: (...args: unknown[]) => void }) {
      const description = this.description;
      const schema = this.schema;

      server.tool(toolName, description, schema, async (input: { code: string }) => {
        const code = input.code?.trim();
        if (!code) {
          return createCodeModeError(ErrorCodes.INVALID_ARGUMENTS, "code is required");
        }

        try {
          const wrappedCode = wrapUserCode(catalogJson, code, preamble);

          const executor = new DynamicWorkerExecutor({ loader, timeout });
          const result = await executor.execute(wrappedCode, executorFns);

          if (result.error) {
            const logOutput = result.logs?.length
              ? `\n\nConsole output:\n${result.logs.join("\n")}`
              : "";
            return createCodeModeError(ErrorCodes.API_ERROR, `${result.error}${logOutput}`);
          }

          const logOutput = result.logs?.length ? result.logs.join("\n") : undefined;

          return createCodeModeResponse(result.result, {
            meta: {
              ...(logOutput ? { console_output: logOutput } : {}),
              executed_at: new Date().toISOString(),
            },
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return createCodeModeError(
            ErrorCodes.UNKNOWN_ERROR,
            `${prefix}_execute failed: ${message}`,
          );
        }
      });
    },
  };
}
