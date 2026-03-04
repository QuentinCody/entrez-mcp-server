/**
 * Hidden __api_proxy tool — routes V8 isolate api.get/api.post calls
 * through the server's HTTP fetch function.
 *
 * This tool is only callable from V8 isolates (hidden=true).
 * It validates paths, delegates to the server's ApiFetchFn, and
 * auto-stages large responses via stageToDoAndRespond().
 */

import { z } from "zod";
import type { ToolEntry } from "../registry/types";
import type { ApiFetchFn } from "../codemode/catalog";
import { shouldStage, stageToDoAndRespond } from "../staging/utils";

/** Path traversal patterns to reject */
const DANGEROUS_PATTERNS = [
	/\.\.\//,      // Directory traversal
	/\/\.\./,      // Reverse traversal
	/%2e%2e/i,     // URL-encoded traversal
	/\/\//,        // Double slash
];

function validatePath(path: string): void {
	if (!path.startsWith("/")) {
		throw new Error(`Path must start with /: ${path}`);
	}
	for (const pattern of DANGEROUS_PATTERNS) {
		if (pattern.test(path)) {
			throw new Error(`Dangerous path pattern detected: ${path}`);
		}
	}
}

/**
 * Interpolate path parameters: /lookup/id/{id} with {id: "ENSG..."} => /lookup/id/ENSG...
 * Returns the interpolated path and remaining (non-path) params.
 */
function interpolatePath(
	path: string,
	params: Record<string, unknown>,
): { path: string; queryParams: Record<string, unknown> } {
	const queryParams = { ...params };
	const interpolated = path.replace(/\{(\w+)\}/g, (_match, key) => {
		const value = queryParams[key];
		if (value === undefined || value === null) {
			throw new Error(`Missing required path parameter: ${key}`);
		}
		delete queryParams[key];
		return encodeURIComponent(String(value));
	});
	return { path: interpolated, queryParams };
}

export interface ApiProxyToolOptions {
	apiFetch: ApiFetchFn;
	/** DO namespace for auto-staging large responses */
	doNamespace?: unknown;
	/** Prefix for data access IDs (e.g., "gtex") */
	stagingPrefix?: string;
	/** Byte threshold for auto-staging (default 100KB) */
	stagingThreshold?: number;
}

/**
 * Create the hidden __api_proxy tool entry.
 */
export function createApiProxyTool(options: ApiProxyToolOptions): ToolEntry {
	const { apiFetch, doNamespace, stagingPrefix, stagingThreshold } = options;

	return {
		name: "__api_proxy",
		description: "Route API calls from V8 isolate through server HTTP layer. Internal only.",
		hidden: true,
		schema: {
			method: z.enum(["GET", "POST", "PUT", "DELETE"]),
			path: z.string(),
			params: z.record(z.string(), z.unknown()).optional(),
			body: z.unknown().optional(),
		},
		handler: async (input) => {
			const method = String(input.method || "GET");
			const rawPath = String(input.path || "/");
			const rawParams = (input.params as Record<string, unknown>) ?? {};
			const body = input.body;

			try {
				validatePath(rawPath);

				// Interpolate path params and extract remaining as query params
				const { path, queryParams } = interpolatePath(rawPath, rawParams);

				const result = await apiFetch({
					method,
					path,
					params: Object.keys(queryParams).length > 0 ? queryParams : undefined,
					body,
				});

				// Check if response should be auto-staged
				const responseBytes = JSON.stringify(result.data).length;
				if (
					doNamespace &&
					stagingPrefix &&
					shouldStage(responseBytes, stagingThreshold)
				) {
					const staged = await stageToDoAndRespond(
						result.data,
						doNamespace as Parameters<typeof stageToDoAndRespond>[1],
						stagingPrefix,
						undefined,
						undefined,
						stagingPrefix,
					);
					return {
						__staged: true,
						data_access_id: staged.dataAccessId,
						schema: staged.schema,
						tables_created: staged.tablesCreated,
						total_rows: staged.totalRows,
						_staging: staged._staging,
						message: `Response auto-staged (${(responseBytes / 1024).toFixed(1)}KB). Use query() or the query_data tool with data_access_id="${staged.dataAccessId}" to explore the data.`,
					};
				}

				return result.data;
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				const status = (err as { status?: number }).status || 500;
				return {
					__api_error: true,
					status,
					message,
					data: (err as { data?: unknown }).data,
				};
			}
		},
	};
}
