/**
 * Entrez MCP Server - TypeScript Type Definitions
 */

export interface SearchOptions {
	retmax?: number;
	retstart?: number;
	sort?: string;
	field?: string;
	intendedUse?: "search" | "analysis" | "citation" | "staging";
}

export interface SummaryOptions {
	retmax?: number;
	compactMode?: boolean;
	detailLevel?: "brief" | "auto" | "full";
	maxTokens?: number;
}

export interface FetchOptions {
	rettype?: string;
	intendedUse?: "search" | "analysis" | "citation" | "staging";
	detailLevel?: "brief" | "auto" | "full";
}

export interface LinkOptions {
	dbfrom?: string;
	linkname?: string;
}

export interface PostOptions {
	usehistory?: "y" | "n";
}

export interface FetchAndStageOptions {
	rettype?: string;
	forceDirect?: boolean;
	includeRaw?: boolean;
}

export interface QueryOptions {
	intendedUse?: "search" | "analysis" | "citation" | "full";
	maxTokens?: number;
	responseStyle?: "text" | "json";
}

export interface StructureSearchOptions {
	threshold?: number;
	maxRecords?: number;
}

export interface PmcIdConvertOptions {
	versions?: "yes" | "no";
}

export interface CapabilitiesOptions {
	format?: "summary" | "detailed" | "json";
	tool?: string;
	includeMetadata?: boolean;
}

export interface SearchResult {
	success: boolean;
	message: string;
	database: string;
	query: string;
	idlist: string[];
	total_results: number;
	returned_results: number;
	suggestions: string[];
	context_notes: string[];
	next_steps: string[];
}

export interface StagingResult {
	success: boolean;
	message: string;
	data_access_id: string;
	database: string;
	requested_ids: string[];
	staged_record_count: number;
	staged_table_count: number;
	tables_created: string[];
	schema_guidance: SchemaGuidance;
	diagnostics: ParsingDiagnostics;
	quality_metrics: QualityMetrics;
}

export interface SchemaGuidance {
	recommended_queries: RecommendedQuery[];
	common_joins: CommonJoin[];
	column_descriptions: ColumnDescription[];
	example_usage: string[];
}

export interface RecommendedQuery {
	description: string;
	sql: string;
	use_case: string;
}

export interface CommonJoin {
	description: string;
	tables: string[];
	join_condition: string;
	example_sql: string;
}

export interface ColumnDescription {
	table: string;
	column: string;
	type: string;
	description: string;
	example_values: string[];
	common_aliases: string[];
}

export interface ParsingDiagnostics {
	method_used: string;
	terms_found: number;
	failed_extractions: string[];
	warnings: string[];
	indexing_status: string;
	mesh_availability: "full" | "partial" | "none";
}

export interface QualityMetrics {
	articles_processed: number;
	mesh_success_rate: number;
	parsing_warnings: string[];
	missing_relationships: string[];
	articles_with_mesh: number;
	articles_without_mesh: number;
}

export interface SchemaResult {
	success: boolean;
	message: string;
	data_access_id: string;
	schema: DatabaseSchema;
	table_names: string[];
	quick_start: QuickStart;
	schema_guidance: SchemaGuidance;
}

export interface DatabaseSchema {
	basic_schema: TableDefinition[];
	enhanced_schemas: Record<string, EnhancedSchema>;
	schema_guidance: SchemaGuidance;
}

export interface TableDefinition {
	name: string;
	sql: string;
}

export interface EnhancedSchema {
	table_name: string;
	columns: Record<string, ColumnMetadata>;
	relationships: string[];
	example_queries: RecommendedQuery[];
}

export interface ColumnMetadata {
	type: string;
	description: string;
	example_values: string[];
	common_aliases: string[];
}

export interface QuickStart {
	sample_queries: string[];
	important_notes: string[];
}

export interface QueryResult {
	success: boolean;
	message: string;
	data_access_id: string;
	query: string;
	row_count: number;
	results: any[];
	query_executed: string;
	suggestions: string[];
	response_style: string;
}

export class DataStaging {
	constructor(
		sdk: EntrezSDK,
		dataAccessId: string,
		stagingResult: StagingResult,
	);

	readonly sdk: EntrezSDK;
	readonly dataAccessId: string;
	readonly stagingResult: StagingResult;

	query(sql: string, options?: QueryOptions): Promise<QueryResult>;
	getSmartSummary(options?: QueryOptions): Promise<any>;
	getSchema(): Promise<SchemaResult>;
	getMetadata(): StagingResult;
}

export class EntrezSDK {
	constructor(baseUrl?: string);

	readonly baseUrl: string;
	sessionId: string | null;

	// Internal methods
	private _call(toolName: string, params: any): Promise<any>;

	// System tools
	getApiKeyStatus(): Promise<any>;
	getCapabilities(options?: CapabilitiesOptions): Promise<any>;
	getToolInfo(toolName: string, format?: "summary" | "json"): Promise<any>;

	// Entrez Query tools
	search(
		database: string,
		term: string,
		options?: SearchOptions,
	): Promise<SearchResult>;
	summary(
		database: string,
		ids: string | string[],
		options?: SummaryOptions,
	): Promise<any>;
	fetch(
		database: string,
		ids: string | string[],
		options?: FetchOptions,
	): Promise<any>;
	info(database: string): Promise<any>;
	link(
		database: string,
		ids: string | string[],
		options?: LinkOptions,
	): Promise<any>;
	post(
		database: string,
		ids: string | string[],
		options?: PostOptions,
	): Promise<any>;
	globalQuery(term: string): Promise<any>;
	spell(term: string, database?: string): Promise<any>;

	// Data staging tools
	fetchAndStage(
		database: string,
		ids: string | string[],
		options?: FetchAndStageOptions,
	): Promise<DataStaging>;
	queryStagedData(
		dataAccessId: string,
		sql: string,
		options?: QueryOptions,
	): Promise<QueryResult>;
	getSmartSummary(dataAccessId: string, options?: QueryOptions): Promise<any>;
	getSchema(dataAccessId: string): Promise<SchemaResult>;
	listDatasets(): Promise<any>;

	// External API tools
	getCompound(
		identifier: string,
		identifierType?: string,
		outputFormat?: string,
	): Promise<any>;
	getSubstance(
		identifier: string,
		identifierType?: string,
		outputFormat?: string,
	): Promise<any>;
	getBioassay(
		identifier: string,
		identifierType?: string,
		outputFormat?: string,
	): Promise<any>;
	structureSearch(
		structure: string,
		structureType: string,
		searchType: string,
		options?: StructureSearchOptions,
	): Promise<any>;
	convertPmcIds(
		ids: string | string[],
		options?: PmcIdConvertOptions,
	): Promise<any>;
	getPmcArticle(id: string, outputFormat?: string): Promise<any>;
	exportCitations(
		ids: string | string[],
		citationFormat?: "ris" | "nbib" | "medline" | "bibtex",
	): Promise<any>;
}
