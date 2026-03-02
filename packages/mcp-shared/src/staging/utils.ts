/**
 * Staging utilities — decision logic, DO interaction, data access ID generation.
 */

import {
	createCodeModeResponse,
	createCodeModeError,
} from "../codemode/response";
import type { SchemaHints } from "./schema-inference";

const DEFAULT_STAGING_THRESHOLD = 50 * 1024; // 50KB

/** Decide whether a response should be staged based on byte size. */
export function shouldStage(responseBytes: number, threshold?: number): boolean {
	return responseBytes > (threshold ?? DEFAULT_STAGING_THRESHOLD);
}

/** Generate a unique data access ID. */
export function generateDataAccessId(prefix: string): string {
	const ts = Date.now();
	const rand = Math.random().toString(36).substring(2, 15);
	return `${prefix}_${ts}_${rand}`;
}

interface DurableObjectStub {
	fetch(req: Request): Promise<Response>;
}

interface DurableObjectNamespace {
	idFromName(name: string): unknown;
	get(id: unknown): DurableObjectStub;
}

/**
 * Stage data to a Durable Object and return a structuredContent response
 * with the data_access_id for subsequent SQL queries.
 */
export async function stageToDoAndRespond(
	data: unknown,
	doNamespace: DurableObjectNamespace,
	prefix: string,
	_schemaHints?: SchemaHints,
) {
	const dataAccessId = generateDataAccessId(prefix);
	const doId = doNamespace.idFromName(dataAccessId);
	const doInstance = doNamespace.get(doId);

	const processReq = new Request("http://localhost/process", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ data }),
	});

	const processResp = await doInstance.fetch(processReq);
	const processResult = (await processResp.json()) as {
		success?: boolean;
		tables_created?: string[];
		total_rows?: number;
	};

	if (!processResult.success) {
		throw new Error("Failed to stage data in Durable Object");
	}

	// Fetch schema
	const schemaResp = await doInstance.fetch(
		new Request("http://localhost/schema"),
	);
	const schemaResult = (await schemaResp.json()) as {
		success?: boolean;
		schema?: unknown;
	};

	return {
		dataAccessId,
		schema: schemaResult.success ? schemaResult.schema : null,
		tablesCreated: processResult.tables_created,
		totalRows: processResult.total_rows,
	};
}

/**
 * Query staged data from a Durable Object with SQL safety checks.
 */
export async function queryDataFromDo(
	doNamespace: DurableObjectNamespace,
	dataAccessId: string,
	sql: string,
	limit = 100,
) {
	// SQL safety validation
	const sanitizedSql = sql.replace(/--.*$/gm, "").trim();

	if (/\/\*/.test(sanitizedSql)) {
		throw new Error("C-style /* */ comments are not allowed");
	}
	if (sanitizedSql.split(";").filter(Boolean).length > 1) {
		throw new Error("Only single SQL statements are allowed");
	}

	const dangerousKeywords = [
		"DROP", "DELETE", "INSERT", "UPDATE", "ALTER", "CREATE",
		"TRUNCATE", "REPLACE", "EXEC", "EXECUTE", "PRAGMA",
		"ATTACH", "DETACH", "REINDEX", "VACUUM", "ANALYZE",
	];
	const upperSql = sanitizedSql.toUpperCase();
	for (const keyword of dangerousKeywords) {
		if (upperSql.includes(keyword)) {
			throw new Error(
				`SQL command '${keyword}' is not allowed. Only SELECT queries are permitted.`,
			);
		}
	}

	if (!/^\s*(SELECT|WITH)\b/i.test(sanitizedSql)) {
		throw new Error("Only SELECT/WITH queries are allowed");
	}

	let finalSql = sanitizedSql;
	if (!sanitizedSql.toLowerCase().includes("limit")) {
		finalSql += ` LIMIT ${limit}`;
	}

	const doId = doNamespace.idFromName(dataAccessId);
	const doInstance = doNamespace.get(doId);

	const response = await doInstance.fetch(
		new Request("http://localhost/query", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ sql: finalSql }),
		}),
	);

	const result = (await response.json()) as {
		success?: boolean;
		results?: unknown[];
		row_count?: number;
		error?: string;
	};

	if (!result.success) {
		throw new Error(`Query failed: ${result.error || "Unknown error"}`);
	}

	return {
		rows: result.results ?? [],
		row_count: result.row_count ?? (result.results?.length ?? 0),
		sql: finalSql,
		data_access_id: dataAccessId,
		executed_at: new Date().toISOString(),
	};
}

/**
 * Get schema metadata from a Durable Object.
 */
export async function getSchemaFromDo(
	doNamespace: DurableObjectNamespace,
	dataAccessId: string,
) {
	const doId = doNamespace.idFromName(dataAccessId);
	const doInstance = doNamespace.get(doId);

	const response = await doInstance.fetch(
		new Request("http://localhost/schema"),
	);
	const result = (await response.json()) as {
		success?: boolean;
		schema?: unknown;
		error?: string;
	};

	if (!result.success) {
		throw new Error(`Schema retrieval failed: ${result.error}`);
	}

	if (
		!result.schema ||
		typeof result.schema !== "object" ||
		!(result.schema as Record<string, unknown>).tables ||
		Object.keys((result.schema as Record<string, unknown>).tables as object).length === 0
	) {
		throw new Error(
			`Data access ID "${dataAccessId}" not found or contains no data.`,
		);
	}

	return {
		data_access_id: dataAccessId,
		schema: result.schema,
		retrieved_at: new Date().toISOString(),
	};
}

/**
 * Standard query_data tool handler. Use in registerTool callback.
 */
export function createQueryDataHandler(
	doBindingName: string,
	toolPrefix: string,
) {
	return async (
		args: Record<string, unknown>,
		env: Record<string, unknown>,
	) => {
		const doNamespace = env[doBindingName] as DurableObjectNamespace | undefined;
		if (!doNamespace) {
			return createCodeModeError(
				"DATA_ACCESS_ERROR",
				`${doBindingName} environment not available`,
			);
		}

		try {
			const dataAccessId = String(args.data_access_id || "");
			const sql = String(args.sql || "");
			const limit = Number(args.limit) || 100;

			if (!dataAccessId) throw new Error("data_access_id is required");
			if (!sql) throw new Error("sql is required");

			const result = await queryDataFromDo(doNamespace, dataAccessId, sql, limit);
			return createCodeModeResponse(result, {
				meta: {
					data_access_id: result.data_access_id,
					row_count: result.row_count,
					executed_at: result.executed_at,
				},
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			let code = "SQL_EXECUTION_ERROR";
			if (msg.includes("not allowed")) code = "INVALID_SQL";
			if (msg.includes("not found") || msg.includes("not available"))
				code = "DATA_ACCESS_ERROR";
			return createCodeModeError(code, `${toolPrefix}_query_data failed: ${msg}`);
		}
	};
}

/**
 * Standard get_schema tool handler. Use in registerTool callback.
 */
export function createGetSchemaHandler(
	doBindingName: string,
	toolPrefix: string,
) {
	return async (
		args: Record<string, unknown>,
		env: Record<string, unknown>,
	) => {
		const doNamespace = env[doBindingName] as DurableObjectNamespace | undefined;
		if (!doNamespace) {
			return createCodeModeError(
				"DATA_ACCESS_ERROR",
				`${doBindingName} environment not available`,
			);
		}

		try {
			const dataAccessId = String(args.data_access_id || "");
			if (!dataAccessId) throw new Error("data_access_id is required");

			const result = await getSchemaFromDo(doNamespace, dataAccessId);
			return createCodeModeResponse(result, {
				textSummary: JSON.stringify(result),
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return createCodeModeError(
				"DATA_ACCESS_ERROR",
				`${toolPrefix}_get_schema failed: ${msg}`,
			);
		}
	};
}
