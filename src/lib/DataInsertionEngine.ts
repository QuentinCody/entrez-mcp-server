// src/lib/DataInsertionEngine.ts

import type { DataQualityMetrics } from "./types.js";

export class DataInsertionEngine {
	async insertData(
		entities: { type: string; data: any }[],
		schemas: Record<string, any>,
		sql: any,
	): Promise<DataQualityMetrics> {
		const quality: DataQualityMetrics = {
			articles_processed: 0,
			mesh_success_rate: 0,
			parsing_warnings: [],
			missing_relationships: [],
			articles_with_mesh: 0,
			articles_without_mesh: 0,
		};

		// Group entities by type
		const typeGroups: Record<string, any[]> = {};
		entities.forEach((entity) => {
			if (!typeGroups[entity.type]) {
				typeGroups[entity.type] = [];
			}
			typeGroups[entity.type].push(entity.data);
		});

		// Insert data for each entity type
		for (const [entityType, items] of Object.entries(typeGroups)) {
			if (!schemas[entityType] || items.length === 0) continue;

			const tableName = entityType;
			const columns = Object.keys(schemas[entityType].columns);

			if (columns.length === 0) continue;

			// Insert each item using exec() instead of prepared statements
			for (const item of items) {
				try {
					const values = columns.map((col) => {
						const value = item[col];
						if (
							Array.isArray(value) ||
							(typeof value === "object" && value !== null)
						) {
							return JSON.stringify(value);
						}
						return value;
					});

					// Build parameterized query for Cloudflare Workers
					const placeholders = columns.map(() => "?").join(", ");
					const query = `INSERT OR REPLACE INTO ${tableName} (${columns.join(", ")}) VALUES (${placeholders})`;

					// Use exec with parameters for Cloudflare Workers
					sql.exec(query, ...values);
				} catch (error) {
					quality.parsing_warnings.push(
						`Failed to insert ${entityType}: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			}

			// Track article-specific metrics
			if (entityType === "article") {
				quality.articles_processed = items.length;

				// Check which articles have MeSH terms
				items.forEach((article) => {
					if (
						article.meshTerms &&
						Array.isArray(article.meshTerms) &&
						article.meshTerms.length > 0
					) {
						quality.articles_with_mesh++;
					} else {
						quality.articles_without_mesh++;
					}
				});
			}
		}

		// Create relationship tables
		await this.insertRelationships(typeGroups, schemas, sql, quality);

		// Calculate success rates
		if (quality.articles_processed > 0) {
			quality.mesh_success_rate =
				(quality.articles_with_mesh / quality.articles_processed) * 100;
		}

		return quality;
	}

	private async insertRelationships(
		typeGroups: Record<string, any[]>,
		schemas: Record<string, any>,
		sql: any,
		quality: DataQualityMetrics,
	): Promise<void> {
		// Handle article-meshterm relationships
		if (typeGroups.article && typeGroups.meshterm && schemas.article_meshterm) {
			try {
				typeGroups.article.forEach((article) => {
					if (article.meshTerms && Array.isArray(article.meshTerms)) {
						article.meshTerms.forEach((meshTerm: any) => {
							if (meshTerm.uid) {
								try {
									sql.exec(
										"INSERT OR REPLACE INTO article_meshterm (article_uid, meshterm_uid) VALUES (?, ?)",
										article.uid,
										meshTerm.uid,
									);
								} catch (error) {
									quality.parsing_warnings.push(
										`Failed to insert article-meshterm relationship: ${error instanceof Error ? error.message : String(error)}`,
									);
								}
							}
						});
					} else {
						quality.missing_relationships.push(
							`Article ${article.uid} has no MeSH term relationships`,
						);
					}
				});
			} catch (error) {
				quality.parsing_warnings.push(
					`Failed to create article-meshterm relationships: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}

		// Handle article-author relationships
		if (typeGroups.article && typeGroups.author && schemas.article_author) {
			try {
				typeGroups.article.forEach((article) => {
					if (article.authors && Array.isArray(article.authors)) {
						article.authors.forEach((author: any) => {
							if (author.uid) {
								try {
									sql.exec(
										"INSERT OR REPLACE INTO article_author (article_uid, author_uid) VALUES (?, ?)",
										article.uid,
										author.uid,
									);
								} catch (error) {
									quality.parsing_warnings.push(
										`Failed to insert article-author relationship: ${error instanceof Error ? error.message : String(error)}`,
									);
								}
							}
						});
					} else {
						quality.missing_relationships.push(
							`Article ${article.uid} has no author relationships`,
						);
					}
				});
			} catch (error) {
				quality.parsing_warnings.push(
					`Failed to create article-author relationships: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
	}

	private sanitizeColumnName(name: string): string {
		return name.replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase();
	}

	private prepareValue(value: any): any {
		if (value === null || value === undefined) {
			return null;
		}
		if (Array.isArray(value) || (typeof value === "object" && value !== null)) {
			return JSON.stringify(value);
		}
		return value;
	}
}
