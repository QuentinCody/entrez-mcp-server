/**
 * Virtual Columns Engine (Tier 1)
 *
 * For flat REST API arrays: store raw JSON in a single column and create
 * GENERATED ALWAYS AS (json_extract(...)) columns for direct SQL queries.
 *
 * This is simpler and faster than full normalization, and works well for
 * data that doesn't have nested entity relationships.
 *
 * The existing schema-inference.ts handles most Tier 1 logic already.
 * This module adds the generated-column variant as an alternative storage
 * mode that preserves the original JSON while still allowing SQL queries.
 */

import type { SqlExec } from "./types";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface VirtualColumnResult {
	tableName: string;
	rowCount: number;
	columnCount: number;
	errors: string[];
}

/**
 * Store an array of flat objects using raw JSON + generated columns.
 *
 * Each row stores the full JSON object in `_raw_json`, with generated columns
 * created for each top-level scalar field via json_extract().
 */
export function storeWithVirtualColumns(
	rows: unknown[],
	tableName: string,
	sql: SqlExec,
): VirtualColumnResult {
	const errors: string[] = [];

	if (rows.length === 0) {
		return { tableName, rowCount: 0, columnCount: 0, errors };
	}

	// Sample up to 100 rows to discover columns
	const sampleSize = Math.min(rows.length, 100);
	const columnDefs = discoverColumns(rows.slice(0, sampleSize));

	if (columnDefs.length === 0) {
		// No extractable columns — store as plain JSON
		sql.exec(
			`CREATE TABLE IF NOT EXISTS "${tableName}" (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				_raw_json TEXT NOT NULL
			)`,
		);

		for (const row of rows) {
			try {
				sql.exec(
					`INSERT INTO "${tableName}" (_raw_json) VALUES (?)`,
					JSON.stringify(row),
				);
			} catch (err) {
				errors.push(
					`INSERT into ${tableName} failed: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}

		return { tableName, rowCount: rows.length, columnCount: 0, errors };
	}

	// Build CREATE TABLE with raw JSON + generated columns
	const generatedCols = columnDefs
		.map(
			(col) =>
				`"${col.name}" ${col.sqliteType} GENERATED ALWAYS AS (json_extract(_raw_json, '$.${col.jsonPath}')) STORED`,
		)
		.join(",\n\t\t");

	sql.exec(
		`CREATE TABLE IF NOT EXISTS "${tableName}" (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			_raw_json TEXT NOT NULL,
			${generatedCols}
		)`,
	);

	// Create indexes on ID-like columns
	for (const col of columnDefs) {
		if (col.name === "id" || col.name.endsWith("_id")) {
			try {
				sql.exec(
					`CREATE INDEX IF NOT EXISTS "idx_${tableName}_${col.name}" ON "${tableName}"("${col.name}")`,
				);
			} catch {
				// Index creation failure is non-fatal
			}
		}
	}

	// Insert rows
	let insertCount = 0;
	for (const row of rows) {
		try {
			sql.exec(
				`INSERT INTO "${tableName}" (_raw_json) VALUES (?)`,
				JSON.stringify(row),
			);
			insertCount++;
		} catch (err) {
			errors.push(
				`INSERT into ${tableName} failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	return {
		tableName,
		rowCount: insertCount,
		columnCount: columnDefs.length,
		errors,
	};
}

// ---------------------------------------------------------------------------
// Column discovery
// ---------------------------------------------------------------------------

interface VirtualColumnDef {
	name: string;
	jsonPath: string;
	sqliteType: string;
}

function discoverColumns(samples: unknown[]): VirtualColumnDef[] {
	const columnValues = new Map<string, Set<string>>();

	for (const row of samples) {
		if (!row || typeof row !== "object" || Array.isArray(row)) continue;

		for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
			// Only extract scalar values as generated columns
			if (value === null || value === undefined) continue;
			if (typeof value === "object") continue; // Skip nested objects/arrays

			if (!columnValues.has(key)) columnValues.set(key, new Set());

			if (typeof value === "number") {
				columnValues.get(key)!.add(Number.isInteger(value) ? "INTEGER" : "REAL");
			} else if (typeof value === "boolean") {
				columnValues.get(key)!.add("INTEGER");
			} else {
				columnValues.get(key)!.add("TEXT");
			}
		}
	}

	const defs: VirtualColumnDef[] = [];

	for (const [key, types] of columnValues) {
		// Sanitize column name for SQL
		const safeName = key
			.replace(/([A-Z])/g, "_$1")
			.toLowerCase()
			.replace(/[^a-z0-9_]/g, "_")
			.replace(/_{2,}/g, "_")
			.replace(/^_|_$/g, "");

		if (!safeName) continue;

		// Resolve type: TEXT wins over REAL wins over INTEGER
		let sqliteType = "TEXT";
		if (types.size === 1) {
			sqliteType = [...types][0];
		} else if (types.has("TEXT")) {
			sqliteType = "TEXT";
		} else if (types.has("REAL")) {
			sqliteType = "REAL";
		}

		defs.push({
			name: safeName,
			jsonPath: key,
			sqliteType,
		});
	}

	return defs;
}
