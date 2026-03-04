/**
 * REST Staging Durable Object base class.
 *
 * Generalizes the clinicaltrialsgov JsonToSqlDO pattern.
 * Subclasses override `getSchemaHints()` to customize inference.
 *
 * New hooks for the consolidated staging engine:
 *   - `getDomainConfig()` — return a DomainConfig for Tier 2 normalization
 *   - `getStagingContext()` — return request metadata for config cascade
 *   - `useConsolidatedEngine()` — opt-in to the new StagingEngine
 */

import { DurableObject } from "cloudflare:workers";
import { ChunkingEngine } from "./chunking";
import {
	detectArrays,
	inferSchema,
	materializeSchema,
	type SchemaHints,
} from "./schema-inference";
import { stageData } from "./staging-engine";
import type { DomainConfig, StagingContext, StagingHints } from "./types";

export class RestStagingDO extends DurableObject {
	protected chunking = new ChunkingEngine();

	/** Override in subclass to provide domain-specific schema hints (Tier 1) */
	protected getSchemaHints(_data: unknown): SchemaHints | undefined {
		return undefined;
	}

	/**
	 * Override in subclass to return a DomainConfig for Tier 2 normalization.
	 * When this returns non-undefined and useConsolidatedEngine() returns true,
	 * the consolidated StagingEngine is used instead of the Tier 1 pipeline.
	 */
	protected getDomainConfig(): DomainConfig | undefined {
		return undefined;
	}

	/**
	 * Override in subclass to provide request metadata for config cascade.
	 */
	protected getStagingContext(_request: Request): StagingContext | undefined {
		return undefined;
	}

	/**
	 * Override in subclass to return staging hints for the consolidated engine.
	 */
	protected getStagingHints(_data: unknown): StagingHints | undefined {
		return undefined;
	}

	/**
	 * Override to return true to opt-in to the consolidated staging engine.
	 * Default is false for backward compatibility.
	 */
	protected useConsolidatedEngine(): boolean {
		return false;
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

	/**
	 * Store provenance metadata about how/when data was staged.
	 */
	private storeProvenance(context?: {
		toolName?: string;
		serverName?: string;
		args?: Record<string, unknown>;
		apiUrl?: string;
	}): void {
		this.ctx.storage.sql.exec(
			`CREATE TABLE IF NOT EXISTS _staging_metadata (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				tool_name TEXT,
				server_name TEXT,
				args_json TEXT,
				api_url TEXT,
				staged_at TEXT DEFAULT CURRENT_TIMESTAMP,
				input_rows INTEGER,
				stored_rows INTEGER,
				failed_rows INTEGER,
				warnings_json TEXT
			)`,
		);

		if (context) {
			this.ctx.storage.sql.exec(
				`INSERT INTO _staging_metadata (tool_name, server_name, args_json, api_url) VALUES (?, ?, ?, ?)`,
				context.toolName ?? null,
				context.serverName ?? null,
				context.args ? JSON.stringify(context.args) : null,
				context.apiUrl ?? null,
			);
		}
	}

	/**
	 * Update provenance with row counts after materialization.
	 */
	private updateProvenanceRowCounts(
		inputRows: number,
		storedRows: number,
		failedRows: number,
		warnings: unknown[],
	): void {
		try {
			this.ctx.storage.sql.exec(
				`UPDATE _staging_metadata SET input_rows = ?, stored_rows = ?, failed_rows = ?, warnings_json = ? WHERE id = (SELECT MAX(id) FROM _staging_metadata)`,
				inputRows,
				storedRows,
				failedRows,
				warnings.length > 0 ? JSON.stringify(warnings) : null,
			);
		} catch {
			// Don't fail staging if metadata update fails
		}
	}

	private async handleProcess(request: Request): Promise<Response> {
		const json = (await request.json()) as unknown;
		const container = (json as Record<string, unknown>) || {};
		const data = (container as { data?: unknown }).data ?? json;

		// Extract provenance context from request body
		const stagingContext = (container as { context?: Record<string, unknown> }).context;
		this.storeProvenance(stagingContext as {
			toolName?: string;
			serverName?: string;
			args?: Record<string, unknown>;
			apiUrl?: string;
		});

		// Use consolidated staging engine if opted in
		if (this.useConsolidatedEngine()) {
			const domainConfig = this.getDomainConfig();
			const context = this.getStagingContext(request);
			const stagingHints = this.getStagingHints(data);

			const result = stageData(
				data,
				this.ctx.storage.sql,
				context,
				stagingHints,
				domainConfig,
			);

			return this.jsonResponse({
				success: result.success,
				tier: result.tier,
				table_count: result.tablesCreated.length,
				total_rows: result.totalRows,
				tables_created: result.tablesCreated,
				...(result.error ? { error: result.error } : {}),
			});
		}

		// Legacy Tier 1 pipeline
		const hints = this.getSchemaHints(data);
		const arrays = detectArrays(data);

		if (arrays.length > 0 && arrays.some((a) => a.rows.length > 0)) {
			const schema = inferSchema(arrays, hints);
			const rowsMap = new Map<string, unknown[]>();
			for (const arr of arrays) {
				const tableName = hints?.tableName ?? arr.key.replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase();
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

			// Track row counts in provenance
			this.updateProvenanceRowCounts(
				result.inputRows,
				result.totalRows,
				result.failedRows,
				result.warnings,
			);

			// Build staging warnings if data was lost
			const stagingWarnings: Record<string, unknown> = {};
			if (result.failedRows > 0) {
				stagingWarnings.rows_skipped = result.failedRows;
				stagingWarnings.sample_errors = result.warnings.slice(0, 5).map((w) => ({
					row: w.rowIndex,
					table: w.table,
					error: w.error,
				}));
			}
			const lossPercent = result.inputRows > 0
				? (result.failedRows / result.inputRows) * 100
				: 0;
			if (lossPercent > 5) {
				stagingWarnings.data_loss_warning =
					`${result.failedRows} of ${result.inputRows} rows (${lossPercent.toFixed(1)}%) failed to stage. ` +
					`This exceeds the 5% threshold. Review sample_errors for details.`;
			}

			return this.jsonResponse({
				success: true,
				table_count: result.tablesCreated.length,
				total_rows: result.totalRows,
				input_rows: result.inputRows,
				tables_created: result.tablesCreated,
				...(Object.keys(stagingWarnings).length > 0 ? { staging_warnings: stagingWarnings } : {}),
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
				`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != '_staging_metadata'`,
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

		// Include provenance metadata if available
		let provenance: Record<string, unknown> | undefined;
		try {
			const metaResults = this.ctx.storage.sql
				.exec(`SELECT name FROM sqlite_master WHERE type='table' AND name = '_staging_metadata'`)
				.toArray();
			if (metaResults.length > 0) {
				const metaRow = this.ctx.storage.sql
					.exec(`SELECT tool_name, server_name, api_url, staged_at, input_rows, stored_rows, failed_rows FROM _staging_metadata ORDER BY id DESC LIMIT 1`)
					.toArray();
				if (metaRow.length > 0) {
					provenance = metaRow[0] as Record<string, unknown>;
				}
			}
		} catch {
			// Ignore — provenance is optional
		}

		return this.jsonResponse({
			success: true,
			schema: {
				table_count: Object.keys(tables).length,
				total_rows: totalRows,
				tables,
				metadata: {
					timestamp: new Date().toISOString(),
					...(provenance ? { provenance } : {}),
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
