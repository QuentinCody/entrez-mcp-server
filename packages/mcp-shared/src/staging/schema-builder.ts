/**
 * Schema Builder — generates CREATE TABLE DDL from discovered entities.
 *
 * Takes the output of entity-discovery (entities map + relationships map)
 * and produces a Record<tableName, TableSchema> with:
 *   - Entity tables (columns inferred from sampling all instances)
 *   - Junction tables (for many-to-many relationships)
 *   - Proper FK type matching (TEXT vs INTEGER based on referenced PK)
 */

import type { DomainConfig, TableSchema } from "./types";
import { isEntity } from "./entity-discovery";
import {
	sanitizeColumnName,
	getSQLiteType,
	resolveColumnTypes,
	ensureIdColumn,
	hasScalarFields,
} from "./normalizer";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build table schemas from discovered entities and their relationships.
 */
export function buildSchemas(
	entities: Map<string, unknown[]>,
	relationships: Map<string, Set<string>>,
	config?: DomainConfig,
): Record<string, TableSchema> {
	const schemas: Record<string, TableSchema> = {};

	if (entities.size === 0) return schemas;

	// Phase 1: Create entity tables
	for (const [entityType, instances] of entities.entries()) {
		if (instances.length === 0) continue;

		const columnTypes: Record<string, Set<string>> = {};
		const sampleData: unknown[] = [];

		for (let i = 0; i < instances.length; i++) {
			const rowData = extractEntityFields(
				instances[i],
				columnTypes,
				config,
			);
			if (i < 3) {
				sampleData.push(rowData);
			}
		}

		const columns = resolveColumnTypes(columnTypes);
		ensureIdColumn(columns);

		schemas[entityType] = {
			columns,
			sample_data: sampleData,
		};
	}

	// Phase 2: Create junction tables for many-to-many relationships
	createJunctionTableSchemas(schemas, relationships);

	return schemas;
}

/**
 * Build a fallback schema for simple / non-entity data.
 */
export function buildFallbackSchema(data: unknown): Record<string, TableSchema> {
	const schemas: Record<string, TableSchema> = {};

	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		const tableName = Array.isArray(data) ? "array_data" : "scalar_data";
		schemas[tableName] = createSchemaFromPrimitiveOrArray(data, tableName);
	} else {
		schemas.root_object = createSchemaFromObject(data);
	}

	return schemas;
}

// ---------------------------------------------------------------------------
// Entity field extraction
// ---------------------------------------------------------------------------

function extractEntityFields(
	obj: unknown,
	columnTypes: Record<string, Set<string>>,
	config?: DomainConfig,
): Record<string, unknown> {
	const rowData: Record<string, unknown> = {};

	if (!obj || typeof obj !== "object") {
		addColumnType(columnTypes, "value", getSQLiteType(obj));
		return { value: obj };
	}

	const record = obj as Record<string, unknown>;

	for (const [key, value] of Object.entries(record)) {
		const columnName = sanitizeColumnName(key, config);

		if (Array.isArray(value)) {
			if (value.length > 0 && isEntity(value[0], config)) {
				// Handled as relationship via junction table — skip
				continue;
			} else {
				// Store as JSON
				addColumnType(columnTypes, columnName + "_json", "TEXT");
				rowData[columnName + "_json"] = JSON.stringify(value);
			}
		} else if (value && typeof value === "object") {
			if (isEntity(value, config)) {
				// Related entity → foreign key column
				const foreignKeyColumn = columnName + "_id";
				addColumnType(columnTypes, foreignKeyColumn, "INTEGER");
				rowData[foreignKeyColumn] =
					(value as Record<string, unknown>).id ?? null;
			} else {
				// Complex non-entity object
				if (hasScalarFields(value)) {
					// Flatten scalar sub-fields with prefixed names
					for (const [subKey, subValue] of Object.entries(
						value as Record<string, unknown>,
					)) {
						if (
							!Array.isArray(subValue) &&
							typeof subValue !== "object"
						) {
							const prefixedColumn =
								columnName +
								"_" +
								sanitizeColumnName(subKey, config);
							addColumnType(
								columnTypes,
								prefixedColumn,
								getSQLiteType(subValue),
							);
							rowData[prefixedColumn] =
								typeof subValue === "boolean"
									? subValue
										? 1
										: 0
									: subValue;
						}
					}
				} else {
					// Store complex object as JSON
					addColumnType(columnTypes, columnName + "_json", "TEXT");
					rowData[columnName + "_json"] = JSON.stringify(value);
				}
			}
		} else {
			// Scalar value
			addColumnType(columnTypes, columnName, getSQLiteType(value));
			rowData[columnName] =
				typeof value === "boolean" ? (value ? 1 : 0) : value;
		}
	}

	return rowData;
}

// ---------------------------------------------------------------------------
// Junction table creation
// ---------------------------------------------------------------------------

function createJunctionTableSchemas(
	schemas: Record<string, TableSchema>,
	relationships: Map<string, Set<string>>,
): void {
	const junctionTables = new Set<string>();

	for (const [fromTable, relatedTables] of relationships.entries()) {
		for (const toTable of relatedTables) {
			const [sortedA, sortedB] = [fromTable, toTable].sort();
			const junctionName = `${sortedA}_${sortedB}`;

			if (junctionTables.has(junctionName)) continue;
			junctionTables.add(junctionName);

			// Match FK type to the referenced entity's PK type
			const aIdType = getEntityIdType(sortedA, schemas);
			const bIdType = getEntityIdType(sortedB, schemas);

			schemas[junctionName] = {
				columns: {
					id: "INTEGER PRIMARY KEY AUTOINCREMENT",
					[`${sortedA}_id`]: aIdType,
					[`${sortedB}_id`]: bIdType,
				},
				sample_data: [],
			};
		}
	}
}

/**
 * Determine the SQLite type for a junction FK column based on the
 * referenced entity's PK type.
 */
function getEntityIdType(
	entityType: string,
	schemas: Record<string, TableSchema>,
): string {
	const schema = schemas[entityType];
	if (!schema) return "INTEGER";
	const idCol = schema.columns.id;
	if (idCol && (idCol === "TEXT" || idCol === "TEXT PRIMARY KEY")) {
		return "TEXT";
	}
	return "INTEGER";
}

// ---------------------------------------------------------------------------
// Fallback schemas (simple / primitive data)
// ---------------------------------------------------------------------------

function createSchemaFromPrimitiveOrArray(
	data: unknown,
	tableName: string,
): TableSchema {
	const columnTypes: Record<string, Set<string>> = {};
	const sampleData: Record<string, unknown>[] = [];

	if (Array.isArray(data)) {
		for (let i = 0; i < data.length; i++) {
			const row = extractSimpleFields(data[i], columnTypes);
			if (i < 3) sampleData.push(row);
		}
	} else {
		sampleData.push(extractSimpleFields(data, columnTypes));
	}

	const columns = resolveColumnTypes(columnTypes);

	// If only one non-id column, rename to "value" for consistency
	if (!columns.id && !columns.value) {
		const colNames = Object.keys(columns);
		if (colNames.length === 1 && colNames[0] !== "value") {
			columns.value = columns[colNames[0]];
			delete columns[colNames[0]];
			for (const s of sampleData) {
				s.value = s[colNames[0]];
				delete s[colNames[0]];
			}
		}
	}

	if (Object.keys(columns).length === 0 && data === null) {
		columns.value = "TEXT";
	}

	return { columns, sample_data: sampleData };
}

function createSchemaFromObject(obj: unknown): TableSchema {
	const columnTypes: Record<string, Set<string>> = {};
	const rowData = extractSimpleFields(obj, columnTypes);
	const columns = resolveColumnTypes(columnTypes);
	return { columns, sample_data: [rowData] };
}

function extractSimpleFields(
	obj: unknown,
	columnTypes: Record<string, Set<string>>,
): Record<string, unknown> {
	const rowData: Record<string, unknown> = {};

	if (obj === null || typeof obj !== "object") {
		addColumnType(columnTypes, "value", getSQLiteType(obj));
		return { value: obj };
	}

	if (Array.isArray(obj)) {
		addColumnType(columnTypes, "array_data_json", "TEXT");
		return { array_data_json: JSON.stringify(obj) };
	}

	for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
		const columnName = sanitizeColumnName(key);
		if (value === null || typeof value !== "object") {
			addColumnType(columnTypes, columnName, getSQLiteType(value));
			rowData[columnName] =
				typeof value === "boolean" ? (value ? 1 : 0) : value;
		} else {
			addColumnType(columnTypes, columnName + "_json", "TEXT");
			rowData[columnName + "_json"] = JSON.stringify(value);
		}
	}

	return rowData;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function addColumnType(
	columnTypes: Record<string, Set<string>>,
	column: string,
	type: string,
): void {
	if (!columnTypes[column]) columnTypes[column] = new Set();
	columnTypes[column].add(type);
}
