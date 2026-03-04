/**
 * Core types for the consolidated JSON-to-SQL staging engine.
 *
 * Two tiers:
 *   Tier 1 (Virtual Columns) — flat REST arrays stored as raw JSON with generated columns.
 *   Tier 2 (Full Normalization) — entity discovery, junction tables, FK resolution.
 */

// ---------------------------------------------------------------------------
// Table schema (used by both Tier 1 and Tier 2, matches per-server `TableSchema`)
// ---------------------------------------------------------------------------

export interface TableSchema {
	columns: Record<string, string>;
	sample_data: unknown[];
	relationships?: Record<string, RelationshipMeta>;
	suggested_indexes?: string[];
}

export interface RelationshipMeta {
	type: "foreign_key";
	target_table: string;
	foreign_key_column: string;
}

// ---------------------------------------------------------------------------
// Staging context — request metadata passed in from the MCP tool handler
// ---------------------------------------------------------------------------

export interface StagingContext {
	/** Tool name that produced the data, e.g. "civic_graphql_query" */
	toolName?: string;
	/** Server key, e.g. "civic" */
	serverName?: string;
	/** Original tool arguments */
	args?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Staging hints — override schema inference for a specific request
// ---------------------------------------------------------------------------

export interface StagingHints {
	/** Force a specific tier instead of auto-detecting */
	tier?: 1 | 2;
	/** Override table name (Tier 1) */
	tableName?: string;
	/** Override column types */
	columnTypes?: Record<string, string>;
	/** Additional indexes to create */
	indexes?: string[];
	/** Columns to exclude from inference */
	exclude?: string[];
	/** Flatten depth overrides per top-level key */
	flatten?: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Staging result — returned from the engine after processing
// ---------------------------------------------------------------------------

export interface StagingResult {
	success: boolean;
	tier: 1 | 2;
	tablesCreated: string[];
	totalRows: number;
	error?: string;
}

// ---------------------------------------------------------------------------
// SQL interface — minimal subset of Cloudflare DO SQLite
// ---------------------------------------------------------------------------

export interface SqlExec {
	exec(
		query: string,
		...bindings: unknown[]
	): {
		toArray(): Array<Record<string, unknown>>;
		one?(): Record<string, unknown> | undefined;
	};
}

// ---------------------------------------------------------------------------
// Domain config — per-server customization (replaces code forks)
// ---------------------------------------------------------------------------

export interface DomainConfig {
	/** Human-readable server name */
	name: string;

	/** Map sanitized column names to preferred forms, e.g. "entrezid" → "entrez_id" */
	columnNameMappings?: Record<string, string>;

	/** Extra fields that indicate an entity ID, e.g. ["ensemblId", "efoId"] */
	entityIdFields?: string[];

	/** Infer entity type from specific field combinations */
	entityTypeInference?: Array<{
		fields: string[];
		entityType: string;
	}>;

	/** Pattern-based type inference for column names (RCSB-PDB style) */
	typeInferencePatterns?: Array<{
		pattern: string;
		type: string;
	}>;

	/** Field name → semantic column name remapping (RCSB-PDB style) */
	semanticMappings?: Record<string, string>;

	/** Words that should NOT be singularized */
	singularizationExceptions?: string[];

	/** Wrapper keys to unwrap before entity discovery, e.g. ["nodes", "edges", "rows"] */
	wrapperKeys?: string[];

	/**
	 * Entity detection strictness:
	 *   "standard"  — ID or (2+ fields with entity markers)           [CIViC/DGIdb/OT]
	 *   "loose"     — ID or 2+ fields with any scalar                 [DGIdb]
	 *   "strict"    — ID required                                     [future]
	 *   "aggressive" — ID or 3+ fields with indicators, or 2+ with scalar [RCSB-PDB]
	 */
	entityDetection?: "standard" | "loose" | "strict" | "aggressive";
}
