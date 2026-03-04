/**
 * Entrez API adapter — wraps NCBI E-utilities fetch into the ApiFetchFn
 * interface for use by the Code Mode execute tool.
 *
 * Automatically adds tool, email, and optional API key params.
 * Handles both JSON and XML responses based on content-type.
 */

import type { ApiFetchFn } from "@bio-mcp/shared/codemode/catalog";

/**
 * Create an ApiFetchFn that routes through NCBI E-utilities.
 * No auth required — NCBI API key is optional (raises rate limit).
 */
export function createEntrezApiFetch(apiKey?: string): ApiFetchFn {
	const BASE_URL = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";

	return async (request) => {
		const url = new URL(`${BASE_URL}${request.path}`);

		// Add standard Entrez params for API compliance
		url.searchParams.set("tool", "entrez-mcp-server");
		url.searchParams.set("email", "entrez-mcp-server@example.com");

		// Add API key if available (raises rate limit from 3 to 10 req/sec)
		if (apiKey) {
			url.searchParams.set("api_key", apiKey);
		}

		if (request.params) {
			for (const [key, value] of Object.entries(request.params)) {
				if (value !== undefined && value !== null) {
					url.searchParams.set(key, String(value));
				}
			}
		}

		const fetchOptions: RequestInit = { method: request.method || "GET" };
		if (request.body && request.method === "POST") {
			fetchOptions.headers = { "Content-Type": "application/x-www-form-urlencoded" };
			fetchOptions.body =
				typeof request.body === "string"
					? request.body
					: JSON.stringify(request.body);
		}

		const response = await fetch(url.toString(), fetchOptions);

		// Entrez can return XML or JSON depending on retmode param
		const contentType = response.headers.get("content-type") || "";
		let data: unknown;
		if (contentType.includes("json")) {
			data = await response.json();
		} else {
			data = await response.text();
		}

		if (!response.ok) {
			const error = new Error(
				`HTTP ${response.status}: ${response.statusText}`,
			) as Error & { status: number; data: unknown };
			error.status = response.status;
			error.data = data;
			throw error;
		}

		return { status: response.status, data };
	};
}
