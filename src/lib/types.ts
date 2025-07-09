// src/lib/types.ts

export interface TableSchema {
    columns: Record<string, string>;
    sample_data: any[];
}

export interface ProcessingResult {
    success: boolean;
    message?: string;
    data_access_id?: string;
    processing_details?: ProcessingDetails;
    schemas?: Record<string, any>;
    table_count?: number;
    total_rows?: number;
}

export interface ProcessingDetails {
    table_count: number;
    total_rows: number;
    tables_created: string[];
} 