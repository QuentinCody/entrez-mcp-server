// src/do.ts

import { DurableObject } from "cloudflare:workers";
import { SchemaInferenceEngine } from "./lib/SchemaInferenceEngine.js";
import { DataInsertionEngine } from "./lib/DataInsertionEngine.js";
import { ChunkingEngine } from "./lib/ChunkingEngine.js";
import { ProcessingResult } from "./lib/types.js";

export class JsonToSqlDO extends DurableObject {
	private chunkingEngine = new ChunkingEngine();

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		switch(url.pathname) {
			case '/process': {
				const json = await request.json();
				const result = await this.processAndStore(json);
				return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
			}
			case '/query-enhanced': {
				const { sql } = await request.json() as { sql: string };
				const queryResult = await this.executeEnhancedSql(sql);
				return new Response(JSON.stringify(queryResult), { headers: { 'Content-Type': 'application/json' } });
			}
			case '/schema': {
				const schema = await this.getSchema();
				return new Response(JSON.stringify(schema), { headers: { 'Content-Type': 'application/json' } });
			}
			default:
				return new Response('Not Found', { status: 404 });
		}
	}

	private async processAndStore(jsonData: any): Promise<ProcessingResult> {
		try {
			const schemaEngine = new SchemaInferenceEngine();
			const schemas = schemaEngine.inferFromJSON(jsonData);

			for (const [name, schema] of Object.entries(schemas)) {
				const cols = Object.entries(schema.columns).map(([n, t]) => `${n} ${t}`).join(',');
				this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS ${name} (${cols})`);
			}

			const dataEngine = new DataInsertionEngine();
			await dataEngine.insertData(jsonData, schemas, this.ctx.storage.sql);

            // --- FIXED ROW COUNTING LOGIC ---
            let totalRows = 0;
            const tableNames = Object.keys(schemas);
            for (const tableName of tableNames) {
                const countResult = this.ctx.storage.sql.exec(`SELECT COUNT(*) as count FROM "${tableName}"`).one();
                if (countResult && typeof countResult.count === 'number') {
                    totalRows += countResult.count;
                }
            }

			return {
				success: true,
				message: "Data parsed and staged successfully into a relational database.",
				data_access_id: this.ctx.id.toString(),
				processing_details: {
                    tables_created: tableNames,
                    table_count: tableNames.length,
                    total_rows: totalRows // No more -1
                }
			};
		} catch (error) {
			return { success: false, message: error instanceof Error ? error.message : "Processing failed" };
		}
	}

	private async executeEnhancedSql(sql: string): Promise<any> {
		try {
			const result = this.ctx.storage.sql.exec(sql);
			const rows = result.toArray();
			const resolvedRows = [];
			for (const row of rows) {
				const resolvedRow: any = {};
				for (const [key, value] of Object.entries(row)) {
					if (this.chunkingEngine.isContentReference(value)) {
						const contentId = this.chunkingEngine.extractContentId(value as string);
						const content = await this.chunkingEngine.retrieveChunkedContent(contentId, this.ctx.storage.sql);
						try {
                            resolvedRow[key] = JSON.parse(content || 'null');
                        } catch {
                            resolvedRow[key] = content;
                        }
					} else {
						resolvedRow[key] = value;
					}
				}
				resolvedRows.push(resolvedRow);
			}
			return { success: true, results: resolvedRows };
		} catch (error) {
			return { success: false, error: error instanceof Error ? error.message : "SQL execution failed" };
		}
	}

    private async getSchema(): Promise<any> {
        return this.ctx.storage.sql.exec(`SELECT name, sql FROM sqlite_master WHERE type='table'`).toArray();
    }
} 