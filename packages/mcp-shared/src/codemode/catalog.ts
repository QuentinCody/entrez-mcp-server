/**
 * API Catalog types — describe a REST API's endpoints for Code Mode discovery.
 *
 * Each MCP server defines an ApiCatalog that maps the underlying REST API.
 * The LLM discovers endpoints via `search`, then writes JavaScript that
 * runs in a sandboxed V8 isolate with authenticated API access via `execute`.
 */

export interface ParamDef {
	name: string;
	type: "string" | "number" | "boolean" | "array";
	required: boolean;
	description: string;
	default?: unknown;
	enum?: unknown[];
}

export interface ApiEndpoint {
	method: "GET" | "POST" | "PUT" | "DELETE";
	path: string;
	summary: string;
	description?: string;
	category: string;
	pathParams?: ParamDef[];
	queryParams?: ParamDef[];
	body?: { contentType: string; description?: string };
	response?: { description?: string; example?: unknown };
	/** Links to an existing hand-built MCP tool that covers this endpoint */
	coveredByTool?: string;
}

export interface ApiCatalog {
	name: string;
	baseUrl: string;
	version?: string;
	endpointCount: number;
	auth?: string;
	/** Important notes about response formats, quirks, or conventions for this API */
	notes?: string;
	endpoints: ApiEndpoint[];
}

/**
 * Function signature for the server's HTTP fetch adapter.
 * Routes isolate api.get/api.post calls through the server's HTTP layer.
 */
export type ApiFetchFn = (request: {
	method: string;
	path: string;
	params?: Record<string, unknown>;
	body?: unknown;
}) => Promise<{ status: number; data: unknown }>;
