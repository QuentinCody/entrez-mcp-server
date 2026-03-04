/**
 * Search tool factory — creates a `<prefix>_search` tool for API discovery.
 *
 * Runs in-process (no V8 isolate needed) — just queries the static catalog.
 * Returns matching endpoints with full parameter documentation.
 */

import { z } from "zod";
import type { ApiCatalog, ApiEndpoint } from "./catalog";

export interface SearchToolOptions {
	/** Tool name prefix (e.g., "gtex" → "gtex_search") */
	prefix: string;
	/** The API catalog to search */
	catalog: ApiCatalog;
}

/**
 * Token-based search over catalog endpoints.
 */
function searchEndpoints(
	endpoints: ApiEndpoint[],
	query: string,
	maxResults: number,
): ApiEndpoint[] {
	const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return [];

	const scored = endpoints.map((ep) => {
		const text = [
			ep.path,
			ep.summary,
			ep.description || "",
			ep.category,
			ep.method,
			...(ep.pathParams || []).map((p) => `${p.name} ${p.description}`),
			...(ep.queryParams || []).map((p) => `${p.name} ${p.description}`),
		]
			.join(" ")
			.toLowerCase();

		let score = 0;
		for (const token of tokens) {
			if (text.includes(token)) score++;
		}
		return { endpoint: ep, score };
	});

	return scored
		.filter((s) => s.score > 0)
		.sort((a, b) => b.score - a.score)
		.slice(0, maxResults)
		.map((s) => s.endpoint);
}

/**
 * Format an endpoint for display.
 */
function formatEndpoint(ep: ApiEndpoint): string {
	const lines = [`${ep.method} ${ep.path} — ${ep.summary}`];
	if (ep.coveredByTool) lines.push(`  (also available via tool: ${ep.coveredByTool})`);

	if (ep.pathParams?.length) {
		for (const p of ep.pathParams) {
			lines.push(`  Path: {${p.name}} (${p.type}, ${p.required ? "required" : "optional"}) — ${p.description}`);
		}
	}

	if (ep.queryParams?.length) {
		for (const p of ep.queryParams) {
			const extras: string[] = [];
			if (p.default !== undefined) extras.push(`default: ${JSON.stringify(p.default)}`);
			if (p.enum) extras.push(`values: ${JSON.stringify(p.enum)}`);
			lines.push(`  Query: ${p.name} (${p.type}, ${p.required ? "required" : "optional"}) — ${p.description}${extras.length ? ` [${extras.join(", ")}]` : ""}`);
		}
	}

	if (ep.body) {
		lines.push(`  Body: ${ep.body.contentType}${ep.body.description ? ` — ${ep.body.description}` : ""}`);
	}

	return lines.join("\n");
}

/**
 * Create a search tool registration object.
 * Returns { name, description, schema, register } for the server to use.
 */
export function createSearchTool(options: SearchToolOptions) {
	const { prefix, catalog } = options;
	const toolName = `${prefix}_search`;

	// Collect categories for the description
	const categories = new Map<string, number>();
	for (const ep of catalog.endpoints) {
		categories.set(ep.category, (categories.get(ep.category) || 0) + 1);
	}
	const categoryList = Array.from(categories.entries())
		.map(([cat, count]) => `${cat} (${count})`)
		.join(", ");

	const notesSection = catalog.notes ? `\n\nNOTES:\n${catalog.notes}` : "";

	return {
		name: toolName,
		description:
			`Search the ${catalog.name} API catalog (${catalog.endpointCount} endpoints). ` +
			`Returns matching endpoints with full parameter docs. Use this to discover API capabilities before calling ${prefix}_execute.\n\n` +
			`Categories: ${categoryList}\n\n` +
			`USAGE IN ${prefix}_execute:\n` +
			`- api.get(path, params) for GET, api.post(path, body, params) for POST\n` +
			`- Path params like /lookup/{id} are auto-interpolated from params: api.get('/lookup/{id}', {id: 'ENSG...'})\n` +
			`- Remaining params become query string\n` +
			`- Large responses (>100KB) are auto-staged: check result.__staged, return the staging info, use ${prefix}_query_data to explore\n` +
			`- Use limit/pagination params to control response size. Large datasets auto-stage for SQL queries.` +
			notesSection,
		schema: {
			query: z.string().describe(
				"Search query — keywords matching endpoint paths, descriptions, parameters, or categories. Examples: 'gene expression', 'variant annotation', 'tissue'",
			),
			category: z.string().optional().describe(
				"Filter to a specific category. Use query='*' with a category to list all endpoints in that category.",
			),
			max_results: z.number().optional().describe(
				"Maximum results to return (default 10, max 25)",
			),
		},

		/**
		 * Register this tool with the MCP server.
		 */
		register(server: { tool: (...args: unknown[]) => void }) {
			server.tool(
				toolName,
				this.description,
				this.schema,
				async (input: { query: string; category?: string; max_results?: number }) => {
					const maxResults = Math.min(input.max_results || 10, 25);
					const query = input.query?.trim() || "";

					let endpoints = catalog.endpoints;

					// Filter by category if specified
					if (input.category) {
						endpoints = endpoints.filter(
							(ep) => ep.category.toLowerCase() === input.category!.toLowerCase(),
						);
					}

					let results: ApiEndpoint[];

					if (query === "*" || query === "") {
						// List mode — return all (within category filter)
						results = endpoints.slice(0, maxResults);
					} else {
						results = searchEndpoints(endpoints, query, maxResults);
					}

					if (results.length === 0) {
						// Return available categories as a hint
						const categories = new Map<string, number>();
						for (const ep of catalog.endpoints) {
							categories.set(ep.category, (categories.get(ep.category) || 0) + 1);
						}
						const catList = Array.from(categories.entries())
							.map(([cat, count]) => `  ${cat} (${count} endpoints)`)
							.join("\n");

						return {
							content: [{
								type: "text" as const,
								text: `No endpoints found for "${query}"${input.category ? ` in category "${input.category}"` : ""}.\n\nAvailable categories:\n${catList}\n\nTry broader search terms or browse by category.`,
							}],
						};
					}

					const formatted = results.map(formatEndpoint).join("\n\n");
					const header = `Found ${results.length} endpoint(s) in ${catalog.name} API (${catalog.endpointCount} total):`;

					return {
						content: [{ type: "text" as const, text: `${header}\n\n${formatted}` }],
						structuredContent: {
							success: true,
							data: {
								total_endpoints: catalog.endpointCount,
								results_count: results.length,
								endpoints: results,
							},
						},
					};
				},
			);
		},
	};
}
