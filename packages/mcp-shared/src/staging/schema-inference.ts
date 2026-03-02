/**
 * Universal Schema Inference Engine — JSON → SQLite converter for REST API responses.
 *
 * Deterministic: same input always produces same schema.
 */

export interface SchemaHints {
	tableName?: string;
	columnTypes?: Record<string, string>;
	indexes?: string[];
	flatten?: Record<string, number>;
	exclude?: string[];
}

export interface InferredColumn {
	name: string;
	type: "TEXT" | "INTEGER" | "REAL" | "JSON";
}

export interface InferredTable {
	name: string;
	columns: InferredColumn[];
	indexes: string[];
}

export interface InferredSchema {
	tables: InferredTable[];
}

const KNOWN_ARRAY_KEYS = ["data", "results", "items", "records", "hits", "entries", "rows"];
const ID_PATTERN = /^(id|.*_id|.*Id)$/;
const MAX_SCAN_ROWS = 100;
const LARGE_VALUE_THRESHOLD = 4096; // 4KB

/**
 * Find the array(s) in a JSON response that should become tables.
 */
export function detectArrays(
	data: unknown,
): Array<{ key: string; rows: unknown[] }> {
	if (Array.isArray(data)) {
		return [{ key: "data", rows: data }];
	}

	if (typeof data !== "object" || data === null) return [];

	const obj = data as Record<string, unknown>;
	const found: Array<{ key: string; rows: unknown[] }> = [];

	// Check known wrapper keys first
	for (const key of KNOWN_ARRAY_KEYS) {
		if (Array.isArray(obj[key])) {
			found.push({ key, rows: obj[key] as unknown[] });
		}
	}

	if (found.length > 0) return found;

	// Fall back to any top-level array property
	for (const [key, value] of Object.entries(obj)) {
		if (Array.isArray(value) && value.length > 0) {
			found.push({ key, rows: value });
		}
	}

	return found;
}

/**
 * Flatten an object's keys with `_` separator up to a given depth.
 */
function flattenObject(
	obj: Record<string, unknown>,
	maxDepth: number,
	depthOverrides?: Record<string, number>,
	prefix = "",
	currentDepth = 0,
): Record<string, unknown> {
	const result: Record<string, unknown> = {};

	for (const [key, value] of Object.entries(obj)) {
		const fullKey = prefix ? `${prefix}_${key}` : key;
		const effectiveMaxDepth = depthOverrides?.[key] ?? maxDepth;

		if (
			value !== null &&
			typeof value === "object" &&
			!Array.isArray(value) &&
			currentDepth < effectiveMaxDepth
		) {
			Object.assign(
				result,
				flattenObject(
					value as Record<string, unknown>,
					maxDepth,
					depthOverrides,
					fullKey,
					currentDepth + 1,
				),
			);
		} else {
			result[fullKey] = value;
		}
	}

	return result;
}

/**
 * Infer the SQLite column type from sampled values.
 */
function inferColumnType(values: unknown[]): "TEXT" | "INTEGER" | "REAL" | "JSON" {
	let hasInteger = false;
	let hasReal = false;
	let hasLargeString = false;
	let hasObject = false;

	for (const v of values) {
		if (v === null || v === undefined) continue;
		if (typeof v === "number") {
			if (Number.isInteger(v)) hasInteger = true;
			else hasReal = true;
		} else if (typeof v === "boolean") {
			hasInteger = true;
		} else if (typeof v === "object") {
			hasObject = true;
		} else if (typeof v === "string" && v.length > LARGE_VALUE_THRESHOLD) {
			hasLargeString = true;
		}
	}

	if (hasObject || hasLargeString) return "JSON";
	if (hasReal) return "REAL";
	if (hasInteger && !hasReal) return "INTEGER";
	return "TEXT";
}

/**
 * Infer a complete schema from detected arrays.
 */
export function inferSchema(
	arrays: Array<{ key: string; rows: unknown[] }>,
	hints?: SchemaHints,
): InferredSchema {
	const tables: InferredTable[] = [];
	const exclude = new Set(hints?.exclude ?? []);

	for (const { key, rows } of arrays) {
		if (rows.length === 0) continue;

		const tableName = hints?.tableName ?? sanitizeTableName(key);
		const sampleRows = rows.slice(0, MAX_SCAN_ROWS);

		// Flatten all sample rows
		const flattenedRows = sampleRows.map((row) => {
			if (typeof row !== "object" || row === null) return { value: row };
			return flattenObject(row as Record<string, unknown>, 2, hints?.flatten);
		});

		// Collect all column names and their values
		const columnValues = new Map<string, unknown[]>();
		for (const row of flattenedRows) {
			for (const [col, val] of Object.entries(row)) {
				if (exclude.has(col)) continue;
				if (!columnValues.has(col)) columnValues.set(col, []);
				columnValues.get(col)!.push(val);
			}
		}

		// Build columns
		const columns: InferredColumn[] = [];
		const indexes: string[] = [...(hints?.indexes ?? [])];

		for (const [colName, values] of columnValues) {
			const overrideType = hints?.columnTypes?.[colName];
			const type = overrideType
				? (overrideType as InferredColumn["type"])
				: inferColumnType(values);
			columns.push({ name: colName, type });

			// Auto-index ID columns
			if (ID_PATTERN.test(colName) && !indexes.includes(colName)) {
				indexes.push(colName);
			}
		}

		tables.push({ name: tableName, columns, indexes });
	}

	return { tables };
}

function sanitizeTableName(key: string): string {
	return key
		.replace(/[^a-zA-Z0-9_]/g, "_")
		.replace(/^_+|_+$/g, "")
		.toLowerCase();
}

/**
 * Generate CREATE TABLE + INSERT statements and execute them.
 */
export function materializeSchema(
	schema: InferredSchema,
	rows: Map<string, unknown[]>,
	sql: {
		exec: (query: string, ...bindings: unknown[]) => unknown;
	},
): { tablesCreated: string[]; totalRows: number } {
	const tablesCreated: string[] = [];
	let totalRows = 0;

	for (const table of schema.tables) {
		const colDefs = table.columns
			.map((c) => `"${c.name}" ${c.type}`)
			.join(", ");
		sql.exec(
			`CREATE TABLE IF NOT EXISTS "${table.name}" (id INTEGER PRIMARY KEY AUTOINCREMENT, ${colDefs})`,
		);

		for (const idx of table.indexes) {
			sql.exec(
				`CREATE INDEX IF NOT EXISTS "idx_${table.name}_${idx}" ON "${table.name}"("${idx}")`,
			);
		}

		const tableRows = rows.get(table.name) ?? [];
		const colNames = table.columns.map((c) => c.name);
		const placeholders = colNames.map(() => "?").join(", ");
		const insertSql = `INSERT INTO "${table.name}" (${colNames.map((n) => `"${n}"`).join(", ")}) VALUES (${placeholders})`;

		for (const row of tableRows) {
			const flat =
				typeof row === "object" && row !== null
					? flattenObject(row as Record<string, unknown>, 2)
					: { value: row };
			const values = colNames.map((col) => {
				const v = (flat as Record<string, unknown>)[col];
				if (v === null || v === undefined) return null;
				if (typeof v === "object") return JSON.stringify(v);
				return v;
			});
			try {
				sql.exec(insertSql, ...values);
				totalRows++;
			} catch {
				// skip bad rows
			}
		}

		tablesCreated.push(table.name);
	}

	return { tablesCreated, totalRows };
}
