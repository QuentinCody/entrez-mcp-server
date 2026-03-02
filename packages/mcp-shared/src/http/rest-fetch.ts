/**
 * REST HTTP fetch utility with retry, timeout, and query string construction.
 */

export interface RestFetchOptions {
	method?: string;
	headers?: Record<string, string>;
	body?: string | object;
	timeout?: number;
	retries?: number;
	retryOn?: number[];
	userAgent?: string;
}

const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_RETRIES = 3;
const DEFAULT_RETRY_ON = [429, 500, 502, 503, 504];

/**
 * Build a query string from a params object. Handles arrays, undefined values.
 */
export function buildQueryString(params: Record<string, unknown>): string {
	const parts: string[] = [];
	for (const [key, value] of Object.entries(params)) {
		if (value === undefined || value === null) continue;
		if (Array.isArray(value)) {
			for (const item of value) {
				parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(item))}`);
			}
		} else {
			parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
		}
	}
	return parts.join("&");
}

/**
 * Fetch a REST API with retries, timeout, and query string construction.
 */
export async function restFetch(
	baseUrl: string,
	path: string,
	params?: Record<string, unknown>,
	opts?: RestFetchOptions,
): Promise<Response> {
	const {
		method = "GET",
		headers = {},
		body,
		timeout = DEFAULT_TIMEOUT,
		retries = DEFAULT_RETRIES,
		retryOn = DEFAULT_RETRY_ON,
		userAgent = "bio-mcp-server/1.0",
	} = opts ?? {};

	let url = `${baseUrl.replace(/\/$/, "")}${path}`;
	if (params && Object.keys(params).length > 0) {
		const qs = buildQueryString(params);
		url += `?${qs}`;
	}

	const fetchHeaders: Record<string, string> = {
		Accept: "application/json",
		"User-Agent": userAgent,
		...headers,
	};

	const fetchInit: RequestInit = {
		method,
		headers: fetchHeaders,
		signal: AbortSignal.timeout(timeout),
	};

	if (body) {
		if (typeof body === "string") {
			fetchInit.body = body;
		} else {
			fetchInit.body = JSON.stringify(body);
			if (!fetchHeaders["Content-Type"]) {
				fetchHeaders["Content-Type"] = "application/json";
			}
		}
	}

	let lastError: Error | undefined;

	for (let attempt = 0; attempt <= retries; attempt++) {
		try {
			const response = await fetch(url, fetchInit);

			if (retryOn.includes(response.status) && attempt < retries) {
				// Exponential backoff
				const delay = Math.min(1000 * 2 ** attempt, 10_000);
				// Parse Retry-After header if present
				const retryAfter = response.headers.get("Retry-After");
				const waitMs = retryAfter
					? Math.min(Number(retryAfter) * 1000 || delay, 30_000)
					: delay;
				await new Promise((r) => setTimeout(r, waitMs));
				continue;
			}

			return response;
		} catch (err) {
			lastError = err instanceof Error ? err : new Error(String(err));
			if (attempt < retries) {
				const delay = Math.min(1000 * 2 ** attempt, 10_000);
				await new Promise((r) => setTimeout(r, delay));
			}
		}
	}

	throw lastError ?? new Error(`restFetch failed after ${retries + 1} attempts`);
}
