// src/lib/types.ts

export interface ParsedData {
    uid: string;
    data: any;
}

export interface ProcessingResult {
    success: boolean;
    message: string;
    data_access_id?: string;
    processing_details?: {
        tables_created: string[];
        table_count: number;
        total_rows: number;
        data_quality?: DataQualityMetrics;
        parsing_diagnostics?: ParsingDiagnostics;
        schema_guidance?: SchemaGuidance;
    };
}

export interface DataQualityMetrics {
    articles_processed: number;
    mesh_success_rate: number;
    parsing_warnings: string[];
    missing_relationships: string[];
    articles_with_mesh: number;
    articles_without_mesh: number;
}

export interface ParsingDiagnostics {
    method_used: string;
    terms_found: number;
    failed_extractions: string[];
    warnings: string[];
    indexing_status: 'complete' | 'in_progress' | 'not_indexed' | 'unknown';
    mesh_availability: 'full' | 'partial' | 'none';
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

export interface EnhancedSchema {
    table_name: string;
    columns: Record<string, {
        type: string;
        description: string;
        example_values: string[];
        common_aliases: string[];
    }>;
    relationships: string[];
    example_queries: RecommendedQuery[];
} 