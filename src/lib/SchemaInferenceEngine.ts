// src/lib/SchemaInferenceEngine.ts

import { TableSchema } from "./types.js";

export class SchemaInferenceEngine {
	public inferFromJSON(parsedData: { type: string, data: any }[]): Record<string, TableSchema> {
		const schemas: Record<string, TableSchema> = {};
        const entitiesByType: Record<string, any[]> = {};
        const relationships: Record<string, Set<string>> = {};

        // Group entities by their explicit type from the parser
        for (const item of parsedData) {
            if (!entitiesByType[item.type]) {
                entitiesByType[item.type] = [];
            }
            entitiesByType[item.type].push(item.data);
        }

        // Create table schemas from the grouped entities
		for (const [entityType, entities] of Object.entries(entitiesByType)) {
			if (entities.length === 0) continue;
			const columnTypes: Record<string, Set<string>> = {};
			entities.forEach(entity => this.extractFields(entity, columnTypes));
			const columns = this.resolveColumnTypes(columnTypes);
			if (!columns.uid) columns.uid = 'TEXT PRIMARY KEY';
			schemas[entityType] = { columns, sample_data: entities.slice(0, 3) };

            // Infer relationships
            const mainEntity = entities[0];
            if(mainEntity.authors) relationships[entityType] = new Set([...(relationships[entityType] || []), 'author']);
            if(mainEntity.meshTerms) relationships[entityType] = new Set([...(relationships[entityType] || []), 'meshterm']);
		}

        // Create junction tables from inferred relationships
        for (const [fromTable, toTables] of Object.entries(relationships)) {
            for (const toTable of toTables) {
                const junctionName = [fromTable, toTable].sort().join('_');
                schemas[junctionName] = {
                    columns: { [`${fromTable}_uid`]: 'TEXT', [`${toTable}_uid`]: 'TEXT' },
                    sample_data: []
                };
            }
        }
		return schemas;
	}

	private extractFields(obj: any, cols: Record<string, Set<string>>): void {
		for (const [key, value] of Object.entries(obj)) {
			if (typeof value !== 'object' || value === null) {
				const name = this.sanitize(key);
				if (!cols[name]) cols[name] = new Set();
				cols[name].add(this.getSQLiteType(value));
			}
		}
	}

    private isEntity = (obj: any): boolean => obj && typeof obj === 'object' && (obj.id || obj.uid);
	private sanitize = (name: string): string => name.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase();
	private getSQLiteType = (v: any): string => typeof v === 'number' ? 'REAL' : (typeof v === 'boolean' ? 'INTEGER' : 'TEXT');
    
    private resolveColumnTypes(cols: Record<string, Set<string>>): Record<string, string> {
        return Object.fromEntries(Object.entries(cols).map(([name, types]) =>
            [name, types.has('TEXT') ? 'TEXT' : (types.has('REAL') ? 'REAL' : 'INTEGER')]
        ));
    }
} 