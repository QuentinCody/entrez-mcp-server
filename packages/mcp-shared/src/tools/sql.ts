import { z } from "zod";
import type { ToolEntry } from "../registry/types";
import { isReadOnly, isBlocked, executeSql } from "./sql-helpers";

const sqlParam = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const sqlTools: ToolEntry[] = [
	{
		name: "sql_query",
		description: "Execute SELECT queries against SQLite. Returns rows as JSON.",
		schema: {
			query: z.string().describe("SQL SELECT query to execute. Only SELECT, PRAGMA, and EXPLAIN statements are allowed."),
			params: z.array(sqlParam).optional().describe("Optional query parameters for parameterized queries"),
		},
		handler: async (input, ctx) => {
			const { query, params } = input as { query: string; params?: (string | number | boolean | null)[] };
			if (!isReadOnly(query)) {
				throw new Error("sql_query only allows SELECT, PRAGMA, and EXPLAIN statements. Use sql_exec for DDL/DML.");
			}
			return executeSql(ctx.sql, query, params);
		},
	},
	{
		name: "sql_exec",
		description: "Execute DDL/DML statements (CREATE TABLE, INSERT, UPDATE, DELETE).",
		schema: {
			query: z.string().describe("SQL DDL/DML statement to execute (CREATE TABLE, INSERT, UPDATE, DELETE, etc). ATTACH, DETACH, and LOAD_EXTENSION are blocked."),
			params: z.array(sqlParam).optional().describe("Optional query parameters for parameterized queries"),
		},
		handler: async (input, ctx) => {
			const { query, params } = input as { query: string; params?: (string | number | boolean | null)[] };
			if (isBlocked(query)) {
				throw new Error("ATTACH, DETACH, and LOAD_EXTENSION statements are not allowed.");
			}
			const result = executeSql(ctx.sql, query, params);
			return { success: true, result };
		},
	},
	{
		name: "sql_exec_batch",
		description: "Execute multiple DDL/DML statements in a single call. Much faster than calling sql_exec in a loop.",
		schema: {
			statements: z.array(z.object({
				query: z.string().describe("SQL DDL/DML statement"),
				params: z.array(sqlParam).optional().describe("Optional query parameters"),
			})).describe("Array of statements to execute sequentially in a single round-trip."),
		},
		handler: async (input, ctx) => {
			const { statements } = input as { statements: { query: string; params?: (string | number | boolean | null)[] }[] };
			const results: { index: number; success: boolean; result?: unknown; error?: string }[] = [];
			for (let i = 0; i < statements.length; i++) {
				const { query, params } = statements[i];
				if (isBlocked(query)) {
					results.push({ index: i, success: false, error: "ATTACH, DETACH, and LOAD_EXTENSION statements are not allowed." });
					continue;
				}
				try {
					const result = executeSql(ctx.sql, query, params);
					results.push({ index: i, success: true, result });
				} catch (e: unknown) {
					const error = e instanceof Error ? e.message : String(e);
					results.push({ index: i, success: false, error });
				}
			}
			const failed = results.filter((r) => !r.success).length;
			return { total: statements.length, succeeded: statements.length - failed, failed, results };
		},
	},
];
