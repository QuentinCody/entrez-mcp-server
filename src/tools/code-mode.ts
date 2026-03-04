/**
 * Entrez Code Mode — registers search + execute tools for full API access.
 *
 * search: In-process catalog query, returns matching endpoints with docs.
 * execute: V8 isolate with api.get/api.post + searchSpec/listCategories.
 *
 * Uses prefix "entrez_api" to avoid collision with existing "entrez_*" tools.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createSearchTool } from "@bio-mcp/shared/codemode/search-tool";
import { createExecuteTool } from "@bio-mcp/shared/codemode/execute-tool";
import { entrezCatalog } from "../spec/catalog.js";
import { createEntrezApiFetch } from "../lib/api-adapter.js";

interface CodeModeEnv {
	ENTREZ_DATA_DO: DurableObjectNamespace;
	CODE_MODE_LOADER: WorkerLoader;
	NCBI_API_KEY?: string;
}

/**
 * Register entrez_api_search and entrez_api_execute tools.
 */
export function registerCodeMode(
	server: McpServer,
	env: CodeModeEnv,
) {
	// Pass API key to the adapter if available
	const apiKey = env.NCBI_API_KEY && !env.NCBI_API_KEY.startsWith("${")
		? env.NCBI_API_KEY
		: undefined;
	const apiFetch = createEntrezApiFetch(apiKey);

	// Register the search tool (in-process, no isolate)
	const searchTool = createSearchTool({
		prefix: "entrez_api",
		catalog: entrezCatalog,
	});
	searchTool.register(server as unknown as { tool: (...args: unknown[]) => void });

	// Register the execute tool (V8 isolate via DynamicWorkerExecutor)
	const executeTool = createExecuteTool({
		prefix: "entrez_api",
		catalog: entrezCatalog,
		apiFetch,
		doNamespace: env.ENTREZ_DATA_DO,
		loader: env.CODE_MODE_LOADER,
	});
	executeTool.register(server as unknown as { tool: (...args: unknown[]) => void });
}
