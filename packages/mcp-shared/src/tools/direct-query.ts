/**
 * Direct SQL query tool for V8 isolates.
 *
 * Provides a fast read-only SQL path (`__query`, `__query_batch`) that
 * bypasses full tool dispatch overhead. Hidden from MCP clients —
 * only callable from coordination scripts via the codemode proxy.
 *
 * Security layers:
 *   1. Read-only enforcement (SELECT/WITH only, no write keywords, no semicolons)
 *   2. Table deny list (system tables, sensitive tables)
 *   3. Sensitive column redaction
 *   4. Row count and result size limits
 */

import { z } from "zod";
import type { ToolEntry } from "../registry/types";
import { executeSql } from "./sql-helpers";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const MAX_ROWS = 500;
const MAX_RESULT_BYTES = 1_000_000; // 1 MB
const MAX_BATCH_QUERIES = 20;

/**
 * Tables that should never be accessible via direct query.
 * Extend this set for tables containing secrets or PII.
 */
export const DENIED_TABLES = new Set([
	// SQLite system tables
	"sqlite_master",
	"sqlite_schema",
	"sqlite_sequence",
	"sqlite_stat1",
	"sqlite_stat4",
]);

/**
 * Column names whose values are replaced with "[REDACTED]" in results.
 * Applied globally across all tables (SQLite JOINs return flat column names).
 */
export const REDACTED_COLUMNS = new Set([
	"credential_hash",
	"session_token",
	"identity_email",
]);

// ---------------------------------------------------------------------------
// Security validation
// ---------------------------------------------------------------------------

const BLOCKED_KEYWORDS = [
	/\b(INSERT|UPDATE|DELETE|REPLACE|UPSERT)\b/i,
	/\b(CREATE|DROP|ALTER|RENAME)\b/i,
	/\b(ATTACH|DETACH)\b/i,
	/\b(PRAGMA)\b/i,
	/\b(VACUUM|REINDEX)\b/i,
	/\b(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i,
];

/**
 * Strip all SQL comments (single-line `--` and block comments).
 * Applied before keyword checks to prevent bypass via comment injection.
 */
export function stripComments(sql: string): string {
	return sql
		.replace(/--[^\n]*/g, "")
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.trim();
}

/**
 * Strict read-only validation for direct queries.
 * More restrictive than `isReadOnly()` in sql-helpers — blocks PRAGMA and EXPLAIN,
 * enforces SELECT/WITH prefix, and scans for all write keywords.
 */
export function isStrictReadOnly(sql: string): { valid: boolean; error?: string } {
	const stripped = stripComments(sql);

	if (!stripped) {
		return { valid: false, error: "Empty query" };
	}

	// Reject multi-statement queries
	if (stripped.includes(";")) {
		return { valid: false, error: "Multi-statement queries are not allowed" };
	}

	// Must start with SELECT or WITH (for CTEs)
	if (!/^(SELECT|WITH)\b/i.test(stripped)) {
		return { valid: false, error: "Query must start with SELECT or WITH" };
	}

	for (const pattern of BLOCKED_KEYWORDS) {
		if (pattern.test(stripped)) {
			return { valid: false, error: "Query contains blocked keyword" };
		}
	}

	return { valid: true };
}

/**
 * Extract all table names referenced in a SQL query.
 * Matches tables after FROM and JOIN keywords — since every table reference
 * in a SELECT (including subqueries, CTEs, EXISTS) must use FROM or JOIN,
 * this catches all cases.
 *
 * Handles schema-qualified names (e.g. main.sqlite_master, main."sqlite_master")
 * by extracting both the schema and table portions. This prevents bypass of the
 * deny list via schema qualification.
 */
export function extractTableNames(sql: string): Set<string> {
	const stripped = stripComments(sql);
	const tables = new Set<string>();
	// Match FROM/JOIN followed by an optional schema-qualified identifier.
	// Groups: 1=quoted first ident, 2=unquoted first ident,
	//         3=quoted second ident (after dot), 4=unquoted second ident (after dot)
	const pattern = /\b(?:FROM|JOIN)\s+(?:"([^"]+)"|(\w+))(?:\.(?:"([^"]+)"|(\w+)))?/gi;
	for (const match of stripped.matchAll(pattern)) {
		const first = (match[1] || match[2]).toLowerCase();
		const second = (match[3] || match[4] || "").toLowerCase();
		if (second) {
			// Schema-qualified: add both schema and table name
			tables.add(first);
			tables.add(second);
		} else {
			tables.add(first);
		}
	}
	return tables;
}

/**
 * Validate that all referenced tables are allowed.
 */
export function validateTableAccess(tables: Set<string>, deniedTables: Set<string> = DENIED_TABLES): { valid: boolean; error?: string } {
	for (const table of tables) {
		if (deniedTables.has(table)) {
			return { valid: false, error: `Access denied to table: ${table}` };
		}
	}
	return { valid: true };
}

/**
 * Replace sensitive column values with "[REDACTED]".
 */
export function redactRow(
	row: Record<string, unknown>,
	redactedColumns: Set<string> = REDACTED_COLUMNS
): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(row)) {
		result[key] = redactedColumns.has(key) ? "[REDACTED]" : value;
	}
	return result;
}

/**
 * Append a LIMIT clause if the query doesn't already have one.
 * Uses MAX_ROWS + 1 so we can detect truncation.
 *
 * Operates on comment-stripped SQL to prevent bypass via trailing comments
 * (which would swallow the appended clause). Also detects parameterized
 * limits (`LIMIT ?`) to avoid appending a conflicting second LIMIT.
 */
export function ensureLimit(sql: string, maxRows: number = MAX_ROWS): string {
	const stripped = stripComments(sql);
	if (/\bLIMIT\s+(\d+|\?)/i.test(stripped)) {
		return stripped;
	}
	return `${stripped} LIMIT ${maxRows + 1}`;
}

// ---------------------------------------------------------------------------
// Tool entries
// ---------------------------------------------------------------------------

const sqlParam = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const directQueryTools: ToolEntry[] = [
	{
		name: "__query",
		description: "Execute a read-only SQL query against the database. Internal — only callable from V8 isolates.",
		hidden: true,
		schema: {
			sql: z.string().describe("SQL SELECT statement with ? placeholders"),
			params: z.array(sqlParam).optional().describe("Parameter values for ? placeholders"),
		},
		handler: async (input, ctx) => {
			const { sql: querySql, params } = input as {
				sql: string;
				params?: (string | number | boolean | null)[];
			};

			// 1. Validate read-only
			const readCheck = isStrictReadOnly(querySql);
			if (!readCheck.valid) {
				return { error: readCheck.error, error_code: "QUERY_BLOCKED" };
			}

			// 2. Validate table access
			const tables = extractTableNames(querySql);
			const tableCheck = validateTableAccess(tables);
			if (!tableCheck.valid) {
				return { error: tableCheck.error, error_code: "QUERY_BLOCKED" };
			}

			// 3. Ensure row limit
			const limitedSql = ensureLimit(querySql);

			// 4. Execute
			try {
				const rows = executeSql<Record<string, unknown>>(ctx.sql, limitedSql, params);

				const truncated = rows.length > MAX_ROWS;
				const resultRows = truncated ? rows.slice(0, MAX_ROWS) : rows;

				// 5. Redact sensitive columns
				const redacted = resultRows.map((row) => redactRow(row));

				// 6. Check result size
				const serialized = JSON.stringify(redacted);
				if (serialized.length > MAX_RESULT_BYTES) {
					return {
						error: "Result exceeds 1MB size limit. Add a LIMIT clause or narrow your SELECT columns.",
						error_code: "QUERY_TOO_LARGE",
					};
				}

				return { rows: redacted, count: redacted.length, truncated };
			} catch (e: unknown) {
				const error = e instanceof Error ? e.message : String(e);
				return { error, error_code: "QUERY_ERROR" };
			}
		},
	},
	{
		name: "__query_batch",
		description: "Execute multiple read-only SQL queries in a single round-trip. Internal — only callable from V8 isolates.",
		hidden: true,
		schema: {
			queries: z
				.array(
					z.object({
						sql: z.string().describe("SQL SELECT statement with ? placeholders"),
						params: z.array(sqlParam).optional().describe("Parameter values for ? placeholders"),
					})
				)
				.describe("Array of queries to execute sequentially in a single round-trip."),
		},
		handler: async (input, ctx) => {
			const { queries } = input as {
				queries: { sql: string; params?: (string | number | boolean | null)[] }[];
			};

			if (queries.length > MAX_BATCH_QUERIES) {
				return { error: `Maximum ${MAX_BATCH_QUERIES} queries per batch`, error_code: "QUERY_BLOCKED" };
			}

			const results: unknown[] = [];

			for (const q of queries) {
				// Validate read-only
				const readCheck = isStrictReadOnly(q.sql);
				if (!readCheck.valid) {
					results.push({ error: readCheck.error, error_code: "QUERY_BLOCKED" });
					continue;
				}

				// Validate table access
				const tables = extractTableNames(q.sql);
				const tableCheck = validateTableAccess(tables);
				if (!tableCheck.valid) {
					results.push({ error: tableCheck.error, error_code: "QUERY_BLOCKED" });
					continue;
				}

				const limitedSql = ensureLimit(q.sql);

				try {
					const rows = executeSql<Record<string, unknown>>(ctx.sql, limitedSql, q.params);
					const truncated = rows.length > MAX_ROWS;
					const resultRows = truncated ? rows.slice(0, MAX_ROWS) : rows;
					results.push(resultRows.map((row) => redactRow(row)));
				} catch (e: unknown) {
					const error = e instanceof Error ? e.message : String(e);
					results.push({ error, error_code: "QUERY_ERROR" });
				}
			}

			return { results };
		},
	},
];
