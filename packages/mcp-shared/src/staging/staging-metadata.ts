/**
 * Canonical staging metadata — a machine-readable signal in every staged response.
 *
 * Every tool that stages data (specific tools, Code Mode auto-staging, etc.)
 * includes `_staging: StagingMetadata` in structuredContent so clients and
 * models can reliably detect and use staged data without regex parsing.
 */

export interface StagingMetadata {
	/** Always true — discriminant for detection */
	staged: true;
	/** Unique ID to pass to query_data / get_schema tools */
	data_access_id: string;
	/** Tables created in SQLite */
	tables: string[];
	/** Primary table (usually the first / most important) */
	primary_table?: string;
	/** Total rows inserted across all tables */
	total_rows?: number;
	/** Approximate payload size in bytes before staging */
	payload_size_bytes?: number;
	/** Tool name for querying staged data (e.g. "ctgov_query_data") */
	query_tool: string;
	/** Tool name for inspecting schema (e.g. "ctgov_get_schema") */
	schema_tool: string;
}

/**
 * Build a StagingMetadata object from staging results.
 */
export function buildStagingMetadata(opts: {
	dataAccessId: string;
	tables: string[];
	primaryTable?: string;
	totalRows?: number;
	payloadSizeBytes?: number;
	toolPrefix: string;
}): StagingMetadata {
	return {
		staged: true,
		data_access_id: opts.dataAccessId,
		tables: opts.tables,
		primary_table: opts.primaryTable ?? opts.tables[0],
		total_rows: opts.totalRows,
		payload_size_bytes: opts.payloadSizeBytes,
		query_tool: `${opts.toolPrefix}_query_data`,
		schema_tool: `${opts.toolPrefix}_get_schema`,
	};
}
