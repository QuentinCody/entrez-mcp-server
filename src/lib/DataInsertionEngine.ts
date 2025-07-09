// src/lib/DataInsertionEngine.ts

import { TableSchema } from "./types.js";
import { ChunkingEngine } from "./ChunkingEngine.js";

export class DataInsertionEngine {
	private chunkingEngine = new ChunkingEngine();
    private sanitize = (name: string): string => name.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase();

	public async insertData(parsedData: { type: string, data: any }[], schemas: Record<string, TableSchema>, sql: any): Promise<void> {
        // Group entities by type
        const entitiesByType: Record<string, any[]> = {};
        for (const item of parsedData) {
            if (!entitiesByType[item.type]) entitiesByType[item.type] = [];
            entitiesByType[item.type].push(item.data);
        }

		// Insert primary entity records
		for (const [type, entities] of Object.entries(entitiesByType)) {
            const schema = schemas[type];
            if (!schema) continue;
			for (const entity of entities) {
				await this.insertEntity(entity, type, schema, sql);
			}
		}

        // --- Corrected Relationship Insertion Logic ---
        // Specifically handle article relationships after all entities are inserted
        const articles = entitiesByType['article'] || [];
        for (const article of articles) {
            // Populate article_author junction table
            if (article.authors && Array.isArray(article.authors)) {
                for (const author of article.authors) {
                    sql.exec(
                        `INSERT INTO article_author (article_uid, author_uid) VALUES (?, ?)`,
                        article.uid, author.uid
                    );
                }
            }
            // Populate article_meshterm junction table
            if (article.meshTerms && Array.isArray(article.meshTerms)) {
                for (const meshTerm of article.meshTerms) {
                    sql.exec(
                        `INSERT INTO article_meshterm (article_uid, meshterm_uid) VALUES (?, ?)`,
                        article.uid, meshTerm.uid
                    );
                }
            }
        }
	}

	private async insertEntity(entity: any, tableName: string, schema: TableSchema, sql: any): Promise<void> {
		const row: any = {};
		for (const col of Object.keys(schema.columns)) {
			if (entity.hasOwnProperty(col)) {
				const value = entity[col];
				// Use chunking engine for potentially large fields like 'abstract'
				if (typeof value === 'string' && this.chunkingEngine.shouldChunk(value)) {
                    const metadata = await this.chunkingEngine.storeChunkedContent(value, sql);
                    row[col] = this.chunkingEngine.createContentReference(metadata);
                } else if (typeof value !== 'object' || value === null) {
					row[col] = value;
				}
			}
		}
		const cols = Object.keys(row);
		if (cols.length === 0) return;
		const placeholders = cols.map(() => '?').join(',');
		sql.exec(`INSERT OR IGNORE INTO ${tableName} (${cols.join(',')}) VALUES (${placeholders})`, ...Object.values(row));
	}
} 