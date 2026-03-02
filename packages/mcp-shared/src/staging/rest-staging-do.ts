/**
 * REST Staging Durable Object base class.
 *
 * Generalizes the clinicaltrialsgov JsonToSqlDO pattern.
 * Subclasses override `getSchemaHints()` to customize inference.
 */

import { DurableObject } from "cloudflare:workers";
import { ChunkingEngine } from "./chunking";
import {
	detectArrays,
	inferSchema,
	materializeSchema,
	type SchemaHints,
} from "./schema-inference";

export class RestStagingDO extends DurableObject {
	protected chunking = new ChunkingEngine();

	/** Override in subclass to provide domain-specific schema hints */
	protected getSchemaHints(_data: unknown): SchemaHints | undefined {
		return undefined;
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		try {
			if (url.pathname === "/process" && request.method === "POST") {
				return await this.handleProcess(request);
			}
			if (url.pathname === "/query" && request.method === "POST") {
				return await this.handleQuery(request);
			}
			if (url.pathname === "/query-enhanced" && request.method === "POST") {
				return await this.handleQueryEnhanced(request);
			}
			if (url.pathname === "/schema" && request.method === "GET") {
				return await this.handleSchema();
			}
			if (url.pathname === "/delete" && request.method === "DELETE") {
				await this.ctx.storage.deleteAll();
				return this.jsonResponse({ success: true });
			}
			return new Response("Not Found", { status: 404 });
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			return this.jsonResponse({ success: false, error: message }, 500);
		}
	}

	private async handleProcess(request: Request): Promise<Response> {
		const json = (await request.json()) as unknown;
		const container = (json as Record<string, unknown>) || {};
		const data = (container as { data?: unknown }).data ?? json;

		const hints = this.getSchemaHints(data);
		const arrays = detectArrays(data);

		if (arrays.length > 0 && arrays.some((a) => a.rows.length > 0)) {
			const schema = inferSchema(arrays, hints);
			const rowsMap = new Map<string, unknown[]>();
			for (const arr of arrays) {
				const tableName = hints?.tableName ?? arr.key.replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase();
				// Use the inferred table name from schema if we have a single table
				const actualName = schema.tables.length === 1
					? schema.tables[0].name
					: schema.tables.find((t) => t.name === tableName)?.name ?? tableName;
				rowsMap.set(actualName, arr.rows);
			}

			const result = materializeSchema(
				schema,
				rowsMap,
				this.ctx.storage.sql,
			);

			return this.jsonResponse({
				success: true,
				table_count: result.tablesCreated.length,
				total_rows: result.totalRows,
				tables_created: result.tablesCreated,
			});
		}

		// Fallback: store entire payload as chunked JSON
		this.ctx.storage.sql.exec(
			`CREATE TABLE IF NOT EXISTS payloads (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				root_json TEXT,
				created_at TEXT DEFAULT CURRENT_TIMESTAMP
			)`,
		);
		const jsonStr = await this.chunking.smartJsonStringify(
			data,
			this.ctx.storage.sql,
		);
		this.ctx.storage.sql.exec(
			`INSERT INTO payloads (root_json) VALUES (?)`,
			jsonStr,
		);
		const count =
			(this.ctx.storage.sql.exec(`SELECT COUNT(*) as c FROM payloads`).one() as { c: number })
				?.c ?? 0;
		return this.jsonResponse({
			success: true,
			table_count: 1,
			total_rows: count,
			tables_created: ["payloads"],
		});
	}

	private async handleQuery(request: Request): Promise<Response> {
		const body = (await request.json()) as { sql: string };
		const res = this.ctx.storage.sql.exec(body.sql);
		const results = res.toArray();
		return this.jsonResponse({
			success: true,
			results,
			row_count: results.length,
		});
	}

	private async handleQueryEnhanced(request: Request): Promise<Response> {
		const body = (await request.json()) as { sql: string };
		const res = this.ctx.storage.sql.exec(body.sql);
		const rows = res.toArray();
		const enhanced: Record<string, unknown>[] = [];
		for (const row of rows) {
			const out: Record<string, unknown> = {};
			for (const [k, v] of Object.entries(row)) {
				if (typeof v === "string" && this.chunking.isContentReference(v)) {
					const id = this.chunking.extractContentId(v);
					const content = await this.chunking.retrieveChunkedContent(
						id,
						this.ctx.storage.sql,
					);
					try {
						out[k] = content ? JSON.parse(content) : null;
					} catch {
						out[k] = content;
					}
				} else {
					out[k] = v;
				}
			}
			enhanced.push(out);
		}
		return this.jsonResponse({
			success: true,
			results: enhanced,
			row_count: enhanced.length,
		});
	}

	private async handleSchema(): Promise<Response> {
		const tables: Record<
			string,
			{
				row_count: number;
				columns: Array<{
					name: string;
					type: string;
					not_null: boolean;
					primary_key: boolean;
				}>;
			}
		> = {};
		let totalRows = 0;

		const tableResults = this.ctx.storage.sql
			.exec(
				`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`,
			)
			.toArray();

		for (const table of tableResults) {
			const tableName = table.name as string;
			const columnResults = this.ctx.storage.sql
				.exec(`PRAGMA table_info(${tableName})`)
				.toArray();
			const countResult = this.ctx.storage.sql
				.exec(`SELECT COUNT(*) as count FROM "${tableName}"`)
				.one();
			const rowCount = Number((countResult as { count: number })?.count || 0);
			totalRows += rowCount;

			tables[tableName] = {
				row_count: rowCount,
				columns: columnResults.map((col: Record<string, unknown>) => ({
					name: col.name as string,
					type: col.type as string,
					not_null: col.notnull === 1,
					primary_key: col.pk === 1,
				})),
			};
		}

		return this.jsonResponse({
			success: true,
			schema: {
				table_count: Object.keys(tables).length,
				total_rows: totalRows,
				tables,
				metadata: {
					timestamp: new Date().toISOString(),
				},
			},
		});
	}

	private jsonResponse(data: unknown, status = 200): Response {
		return new Response(JSON.stringify(data), {
			status,
			headers: { "Content-Type": "application/json" },
		});
	}
}
