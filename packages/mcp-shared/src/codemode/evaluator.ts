/**
 * V8 Isolate evaluator for Code Mode.
 *
 * Uses Worker Loader to spin up sandboxed V8 isolates that execute
 * agent-provided JavaScript code. The isolate gets a `codemode` Proxy
 * that routes function calls through CodeModeProxy (a WorkerEntrypoint
 * accessed via service binding) back to the agent's callTool() method.
 *
 * Flow: Isolate → CodeModeProxy (RPC) → DO.callTool() (RPC, reentrancy)
 *
 * The user's code is embedded directly in the module source (not eval'd),
 * since V8 isolates don't allow eval/new Function by default.
 */

const MODULE_SOURCE_PREFIX = [
	'import { WorkerEntrypoint } from "cloudflare:workers";',
	"",
	"export default class CodeModeWorker extends WorkerEntrypoint {",
	"  async evaluate() {",
	"    const { CODE_MODE_PROXY } = this.env;",
	"    const codemode = new Proxy(",
	"      {},",
	"      {",
	"        get(_target, prop) {",
	'          if (typeof prop !== "string") return undefined;',
	"          return (args) => CODE_MODE_PROXY.callFunction({",
	"            functionName: prop,",
	"            args: args,",
	"            doId: ",
].join("\n");

const MODULE_SOURCE_MIDDLE = [
	",",
	"          });",
	"        }",
	"      }",
	"    );",
	"    // --- Direct query helpers ---",
	"    async function query(sql, params) {",
	"      const result = await codemode.__query({ sql, params: params || [] });",
	"      if (result && result.error) throw new Error(result.error);",
	"      return result.rows || [];",
	"    }",
	"    async function queryBatch(queriesArr) {",
	"      const result = await codemode.__query_batch({ queries: queriesArr });",
	"      if (result && result.error) throw new Error(result.error);",
	"      const items = result.results || [];",
	"      for (let i = 0; i < items.length; i++) {",
	"        if (items[i] && items[i].error) {",
	'          throw new Error("Query " + i + " failed: " + items[i].error);',
	"        }",
	"      }",
	"      return items;",
	"    }",
	"    async function store(tableName, data) {",
	"      const result = await codemode.__store({ table: tableName, data: data });",
	"      if (result && result.error) {",
	"        const err = new Error(result.error);",
	"        err.code = result.error_code;",
	"        err.hint = result.hint;",
	"        err.details = result.details;",
	"        throw err;",
	"      }",
	"      return result;",
	"    }",
	"    try {",
	"      // --- User code begins ---",
	"",
].join("\n");

const MODULE_SOURCE_SUFFIX = [
	"",
	"      // --- User code ends ---",
	"    } catch (err) {",
	"      return { error: err.message, stack: err.stack };",
	"    }",
	"  }",
	"}",
].join("\n");

export function createEvaluator(
	code: string,
	options: {
		loader: WorkerLoader;
		proxy: Fetcher;
		doId: string;
	}
) {
	// Static boilerplate is precomputed once at module load; only doId and user code vary.
	const moduleSource =
		MODULE_SOURCE_PREFIX +
		JSON.stringify(options.doId) +
		MODULE_SOURCE_MIDDLE +
		code +
		MODULE_SOURCE_SUFFIX;

	return async (): Promise<unknown> => {
		const worker = options.loader.get(`code-${Math.random()}`, () => {
			return {
				compatibilityDate: "2025-06-01",
				compatibilityFlags: ["nodejs_compat"],
				mainModule: "evaluator.js",
				modules: {
					"evaluator.js": moduleSource,
				},
				env: {
					CODE_MODE_PROXY: options.proxy,
				},
				globalOutbound: null,
			};
		});

		// @ts-expect-error Worker Loader types not fully typed
		return await worker.getEntrypoint().evaluate();
	};
}
