/**
 * Normalization Engine — Tier 2 public facade.
 *
 * Composes entity-discovery + schema-builder + data-inserter into a single
 * call that takes raw JSON data and produces normalized SQLite tables.
 *
 * Usage:
 *   const engine = new NormalizationEngine(DGIDB_CONFIG);
 *   const result = engine.process(data, sql);
 */

import type { DomainConfig, SqlExec, StagingResult, TableSchema } from "./types";
import { discoverEntities } from "./entity-discovery";
import { buildSchemas, buildFallbackSchema } from "./schema-builder";
import { insertData } from "./data-inserter";

export class NormalizationEngine {
	constructor(private readonly config?: DomainConfig) {}

	/**
	 * Process JSON data into normalized SQLite tables.
	 *
	 * 1. Discover entities and relationships
	 * 2. Build table schemas (entity + junction)
	 * 3. Create tables
	 * 4. Insert data (children-first, then junctions)
	 */
	process(data: unknown, sql: SqlExec): StagingResult {
		// Phase 1: Discover entities
		const discovery = discoverEntities(data, this.config);

		// Phase 2: Build schemas
		let schemas: Record<string, TableSchema>;

		if (discovery.entities.size > 0) {
			schemas = buildSchemas(
				discovery.entities,
				discovery.relationships,
				this.config,
			);
		} else {
			schemas = buildFallbackSchema(data);
		}

		// Phase 3: Create tables
		const tablesCreated: string[] = [];
		for (const [tableName, schema] of Object.entries(schemas)) {
			createTable(tableName, schema, sql);
			tablesCreated.push(tableName);
		}

		// Phase 4: Insert data
		const insertResult = insertData(data, schemas, sql, this.config);

		return {
			success: insertResult.errors.length === 0,
			tier: 2 as const,
			tablesCreated,
			totalRows: insertResult.totalRows,
			error:
				insertResult.errors.length > 0
					? `${insertResult.errors.length} insert error(s): ${insertResult.errors[0]}`
					: undefined,
		};
	}
}

// ---------------------------------------------------------------------------
// DDL helpers
// ---------------------------------------------------------------------------

function createTable(
	tableName: string,
	schema: TableSchema,
	sql: SqlExec,
): void {
	const colDefs = Object.entries(schema.columns)
		.map(([name, type]) => `${name} ${type}`)
		.join(", ");

	sql.exec(`CREATE TABLE IF NOT EXISTS ${tableName} (${colDefs})`);

	// Create indexes on FK columns
	for (const colName of Object.keys(schema.columns)) {
		if (
			colName.endsWith("_id") &&
			colName !== "id" &&
			!schema.columns[colName].includes("PRIMARY KEY")
		) {
			try {
				sql.exec(
					`CREATE INDEX IF NOT EXISTS idx_${tableName}_${colName} ON ${tableName}(${colName})`,
				);
			} catch {
				// Index creation failure is non-fatal
			}
		}
	}
}
