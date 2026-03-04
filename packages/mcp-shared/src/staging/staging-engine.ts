/**
 * Staging Engine — top-level orchestrator that picks the right tier
 * and runs the pipeline.
 *
 * Config cascade priority:
 *   1. Explicit StagingHints (hints.tier)
 *   2. Tool name / server name → DomainConfig lookup
 *   3. Auto-detection from response JSON structure
 *
 * Tier selection:
 *   Tier 2 (Full Normalization) — data contains nested entities with
 *     ID-bearing objects that themselves contain arrays of other entities.
 *   Tier 1 (Virtual Columns / flat inference) — everything else (flat arrays
 *     of objects, REST API responses, simple data).
 */

import type {
	DomainConfig,
	SqlExec,
	StagingContext,
	StagingHints,
	StagingResult,
} from "./types";
import { getDomainConfigByName } from "./domain-config";
import { NormalizationEngine } from "./normalization-engine";
import {
	detectArrays,
	inferSchema,
	materializeSchema,
} from "./schema-inference";
import { isEntity } from "./entity-discovery";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Stage JSON data into SQLite tables, auto-detecting the appropriate tier.
 *
 * @param data      — The JSON response to stage
 * @param sql       — Cloudflare DO SQLite handle
 * @param context   — Optional request metadata (toolName, serverName)
 * @param hints     — Optional overrides for tier selection and schema
 * @param config    — Optional explicit DomainConfig (overrides context-based lookup)
 */
export function stageData(
	data: unknown,
	sql: SqlExec,
	context?: StagingContext,
	hints?: StagingHints,
	config?: DomainConfig,
): StagingResult {
	// Resolve config: explicit > context-based lookup > default
	const resolvedConfig =
		config ??
		(context?.serverName
			? getDomainConfigByName(context.serverName)
			: undefined);

	// Determine tier
	const tier = hints?.tier ?? detectTier(data, resolvedConfig);

	if (tier === 2) {
		return runTier2(data, sql, resolvedConfig);
	}

	return runTier1(data, sql, hints);
}

// ---------------------------------------------------------------------------
// Tier detection
// ---------------------------------------------------------------------------

/**
 * Auto-detect whether data should use Tier 1 (flat) or Tier 2 (normalized).
 *
 * Tier 2 triggers when:
 *   - Data contains objects with ID fields that also have array properties
 *     containing other objects with ID fields (nested entity relationships).
 *
 * This is a conservative heuristic — it samples the first few items to avoid
 * scanning the entire response.
 */
function detectTier(data: unknown, config?: DomainConfig): 1 | 2 {
	if (!data || typeof data !== "object") return 1;

	// Unwrap top-level arrays and wrapper objects
	const items = unwrapToArray(data);
	if (!items || items.length === 0) return 1;

	// Sample first 5 items
	const sampleSize = Math.min(items.length, 5);
	for (let i = 0; i < sampleSize; i++) {
		if (hasNestedEntities(items[i], config)) {
			return 2;
		}
	}

	return 1;
}

/**
 * Check whether an object has nested entity relationships
 * (objects with IDs containing arrays of other ID-bearing objects).
 */
function hasNestedEntities(obj: unknown, config?: DomainConfig): boolean {
	if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;

	if (!isEntity(obj, config)) return false;

	const record = obj as Record<string, unknown>;

	for (const value of Object.values(record)) {
		// Check direct arrays
		if (Array.isArray(value) && value.length > 0) {
			if (isEntity(value[0], config)) return true;
		}

		// Check wrapper objects: {nodes: [...]}, {edges: [{node:}]}, {rows: [...]}
		if (value && typeof value === "object" && !Array.isArray(value)) {
			const wrapper = value as Record<string, unknown>;
			if (wrapper.nodes && Array.isArray(wrapper.nodes) && wrapper.nodes.length > 0) {
				if (isEntity(wrapper.nodes[0], config)) return true;
			}
			if (wrapper.edges && Array.isArray(wrapper.edges) && wrapper.edges.length > 0) {
				const firstNode = (wrapper.edges as Array<Record<string, unknown>>)[0]?.node;
				if (firstNode && isEntity(firstNode, config)) return true;
			}
			if (wrapper.rows && Array.isArray(wrapper.rows) && wrapper.rows.length > 0) {
				if (isEntity(wrapper.rows[0], config)) return true;
			}

			// Check if it's a nested entity itself (1:1 relationship) that has its own nested entities
			if (isEntity(value, config) && hasNestedEntities(value, config)) {
				return true;
			}
		}
	}

	return false;
}

/**
 * Unwrap common API response wrappers to get to the main data array.
 */
function unwrapToArray(data: unknown): unknown[] | null {
	if (Array.isArray(data)) return data;

	if (typeof data !== "object" || data === null) return null;

	const record = data as Record<string, unknown>;

	// GraphQL patterns
	if (record.edges && Array.isArray(record.edges)) {
		return (record.edges as Array<Record<string, unknown>>)
			.map((e) => e.node)
			.filter(Boolean);
	}
	if (record.nodes && Array.isArray(record.nodes)) return record.nodes as unknown[];
	if (record.rows && Array.isArray(record.rows)) return record.rows as unknown[];

	// REST API patterns
	const knownKeys = ["data", "results", "items", "records", "hits", "entries"];
	for (const key of knownKeys) {
		if (Array.isArray(record[key])) return record[key] as unknown[];
	}

	// Fall back to any top-level array
	for (const value of Object.values(record)) {
		if (Array.isArray(value) && value.length > 0) return value;
	}

	// Single object — wrap in array for detection
	return [data];
}

// ---------------------------------------------------------------------------
// Tier runners
// ---------------------------------------------------------------------------

function runTier2(
	data: unknown,
	sql: SqlExec,
	config?: DomainConfig,
): StagingResult {
	const engine = new NormalizationEngine(config);
	return engine.process(data, sql);
}

function runTier1(
	data: unknown,
	sql: SqlExec,
	hints?: StagingHints,
): StagingResult {
	const arrays = detectArrays(data);

	if (arrays.length === 0 || arrays.every((a) => a.rows.length === 0)) {
		// No arrays found — store as raw JSON payload
		return storeFallbackPayload(data, sql);
	}

	const schemaHints = hints
		? {
				tableName: hints.tableName,
				columnTypes: hints.columnTypes,
				indexes: hints.indexes,
				flatten: hints.flatten,
				exclude: hints.exclude,
			}
		: undefined;

	const schema = inferSchema(arrays, schemaHints);
	const rowsMap = new Map<string, unknown[]>();

	for (const arr of arrays) {
		const tableName =
			schemaHints?.tableName ??
			arr.key.replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase();
		const actualName =
			schema.tables.length === 1
				? schema.tables[0].name
				: (schema.tables.find((t) => t.name === tableName)?.name ??
					tableName);
		rowsMap.set(actualName, arr.rows);
	}

	const result = materializeSchema(schema, rowsMap, sql);

	return {
		success: true,
		tier: 1,
		tablesCreated: result.tablesCreated,
		totalRows: result.totalRows,
	};
}

function storeFallbackPayload(
	data: unknown,
	sql: SqlExec,
): StagingResult {
	sql.exec(
		`CREATE TABLE IF NOT EXISTS payloads (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			root_json TEXT,
			created_at TEXT DEFAULT CURRENT_TIMESTAMP
		)`,
	);
	sql.exec(
		`INSERT INTO payloads (root_json) VALUES (?)`,
		JSON.stringify(data),
	);

	return {
		success: true,
		tier: 1,
		tablesCreated: ["payloads"],
		totalRows: 1,
	};
}
