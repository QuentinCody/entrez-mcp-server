import type { SqlTaggedTemplate } from "../registry/types";

const READ_ONLY_PREFIXES = ["SELECT", "PRAGMA", "EXPLAIN"];
const BLOCKED_STATEMENTS = ["ATTACH", "DETACH", "LOAD_EXTENSION"];

function normalizeQuery(query: string): string {
	return query.trim().replace(/\s+/g, " ");
}

/**
 * Strip leading SQL comments from a normalized (trimmed, collapsed-whitespace) query.
 * Handles both single-line (--) and block comments.
 */
function stripLeadingComments(query: string): string {
	let result = query;
	while (true) {
		if (result.startsWith("--")) {
			// Line comment: skip to end of line or end of string
			const newlineIndex = result.indexOf("\n");
			if (newlineIndex === -1) {
				return "";
			}
			result = result.substring(newlineIndex + 1).trimStart();
		} else if (result.startsWith("/*")) {
			// Block comment: skip to closing */
			const endIndex = result.indexOf("*/");
			if (endIndex === -1) {
				return "";
			}
			result = result.substring(endIndex + 2).trimStart();
		} else {
			break;
		}
	}
	return result;
}

export function isReadOnly(query: string): boolean {
	const normalized = normalizeQuery(query);
	const upper = stripLeadingComments(normalized.toUpperCase());
	// Reject multi-statement queries (semicolon anywhere prevents injection via chained statements)
	if (upper.includes(";")) {
		return false;
	}
	return READ_ONLY_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

export function isBlocked(query: string): boolean {
	const normalized = normalizeQuery(query);
	const upper = stripLeadingComments(normalized.toUpperCase());
	// Reject multi-statement queries to prevent chaining a blocked statement after an allowed one
	if (upper.includes(";")) {
		return true;
	}
	return BLOCKED_STATEMENTS.some(
		(stmt) => upper.startsWith(stmt) || upper.includes(` ${stmt} `) || upper.includes(` ${stmt}(`)
	);
}

/**
 * Execute a SQL query with optional parameters using the tagged template literal.
 * Builds a proper tagged template call to ensure parameterized execution.
 */
export function executeSql<T = Record<string, string | number | boolean | null>>(
	sql: SqlTaggedTemplate,
	query: string,
	params?: (string | number | boolean | null)[]
): T[] {
	if (!params || params.length === 0) {
		const strings = Object.assign([query], { raw: [query] }) as unknown as TemplateStringsArray;
		return sql<T>(strings);
	}

	const parts = query.split("?");
	if (parts.length !== params.length + 1) {
		throw new Error(
			`Parameter count mismatch: query has ${parts.length - 1} placeholders but ${params.length} params were provided`
		);
	}

	const strings = Object.assign(parts, { raw: parts }) as unknown as TemplateStringsArray;
	return sql<T>(strings, ...params);
}
