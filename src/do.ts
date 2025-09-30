// src/do.ts

import { DurableObject } from "cloudflare:workers";
import { SchemaInferenceEngine } from "./lib/SchemaInferenceEngine.js";
import { DataInsertionEngine } from "./lib/DataInsertionEngine.js";
import { ChunkingEngine } from "./lib/ChunkingEngine.js";
import {
	type ProcessingResult,
	DataQualityMetrics,
	ParsingDiagnostics,
	type SchemaGuidance,
	type RecommendedQuery,
	type CommonJoin,
} from "./lib/types.js";

export class JsonToSqlDO extends DurableObject {
	private chunkingEngine = new ChunkingEngine();
	private schemaEngine = new SchemaInferenceEngine();
	private dataEngine = new DataInsertionEngine();

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		switch (url.pathname) {
			case "/process": {
				const json = (await request.json()) as any;
				const result = await this.processAndStore(json);
				return new Response(JSON.stringify(result), {
					headers: { "Content-Type": "application/json" },
				});
			}
			case "/query-enhanced": {
				const { sql } = (await request.json()) as { sql: string };
				const queryResult = await this.executeEnhancedSql(sql);
				return new Response(JSON.stringify(queryResult), {
					headers: { "Content-Type": "application/json" },
				});
			}
			case "/schema": {
				const schema = await this.getEnhancedSchema();
				return new Response(JSON.stringify(schema), {
					headers: { "Content-Type": "application/json" },
				});
			}
			default:
				return new Response("Not Found", { status: 404 });
		}
	}

	private async processAndStore(parseResult: any): Promise<ProcessingResult> {
		try {
			// Handle both old format (direct entities array) and new format (with diagnostics)
			const entities = parseResult.entities || parseResult;
			const diagnostics = parseResult.diagnostics || {
				method_used: "legacy_parser",
				terms_found: 0,
				failed_extractions: [],
				warnings: ["Using legacy parser format"],
				indexing_status: "unknown" as const,
				mesh_availability: "unknown" as "full" | "partial" | "none",
			};

			const schemas = this.schemaEngine.inferFromJSON(entities);

			for (const [name, schema] of Object.entries(schemas)) {
				const cols = Object.entries(schema.columns)
					.map(([n, t]) => `${n} ${t}`)
					.join(",");
				this.ctx.storage.sql.exec(
					`CREATE TABLE IF NOT EXISTS ${name} (${cols})`,
				);
			}

			const dataQuality = await this.dataEngine.insertData(
				entities,
				schemas,
				this.ctx.storage.sql,
			);

			// Generate enhanced schema guidance
			const schemaGuidance = this.generateSchemaGuidance(schemas);

			// Count total rows across all tables
			let totalRows = 0;
			const tableNames = Object.keys(schemas);
			for (const tableName of tableNames) {
				const countResult = this.ctx.storage.sql
					.exec(`SELECT COUNT(*) as count FROM "${tableName}"`)
					.one();
				if (countResult && typeof countResult.count === "number") {
					totalRows += countResult.count;
				}
			}

			return {
				success: true,
				message:
					"Data parsed and staged successfully into a relational database with enhanced schema guidance.",
				data_access_id: this.ctx.id.toString(),
				processing_details: {
					tables_created: tableNames,
					table_count: tableNames.length,
					total_rows: totalRows,
					data_quality: dataQuality,
					parsing_diagnostics: diagnostics,
					schema_guidance: schemaGuidance,
				},
			};
		} catch (error) {
			return {
				success: false,
				message: error instanceof Error ? error.message : "Processing failed",
				processing_details: {
					tables_created: [],
					table_count: 0,
					total_rows: 0,
					parsing_diagnostics: {
						method_used: "error",
						terms_found: 0,
						failed_extractions: [
							error instanceof Error ? error.message : String(error),
						],
						warnings: ["Processing failed completely"],
						indexing_status: "unknown" as const,
						mesh_availability: "none" as const,
					},
				},
			};
		}
	}

	private generateSchemaGuidance(schemas: Record<string, any>): SchemaGuidance {
		const enhancedSchemas = this.schemaEngine.getEnhancedSchemas();

		const recommendedQueries: RecommendedQuery[] = [];
		const commonJoins: CommonJoin[] = [];
		const exampleUsage: string[] = [];

		// Add table-specific queries
		Object.values(enhancedSchemas).forEach((schema) => {
			recommendedQueries.push(...schema.example_queries);
		});

		// Add common join patterns
		if (schemas.article && schemas.meshterm) {
			commonJoins.push({
				description: "Find articles and their MeSH terms",
				tables: ["article", "meshterm", "article_meshterm"],
				join_condition:
					"article.uid = article_meshterm.article_uid AND article_meshterm.meshterm_uid = meshterm.uid",
				example_sql:
					"SELECT a.pmid, a.title, m.descriptorname FROM article a JOIN article_meshterm am ON a.uid = am.article_uid JOIN meshterm m ON am.meshterm_uid = m.uid ORDER BY a.year DESC",
			});
		}

		if (schemas.article && schemas.author) {
			commonJoins.push({
				description: "Find articles and their authors",
				tables: ["article", "author", "article_author"],
				join_condition:
					"article.uid = article_author.article_uid AND article_author.author_uid = author.uid",
				example_sql:
					"SELECT a.pmid, a.title, au.lastname, au.forename FROM article a JOIN article_author aa ON a.uid = aa.article_uid JOIN author au ON aa.author_uid = au.uid",
			});
		}

		// Add example usage patterns
		exampleUsage.push(
			"// Get articles by year: SELECT * FROM article WHERE year = 2024",
			"// Find specific MeSH terms: SELECT * FROM meshterm WHERE descriptorname LIKE '%cancer%'",
			"// Count articles per year: SELECT year, COUNT(*) FROM article GROUP BY year ORDER BY year DESC",
		);

		if (schemas.article && schemas.meshterm) {
			exampleUsage.push(
				"// Articles with specific MeSH terms: SELECT a.* FROM article a JOIN article_meshterm am ON a.uid = am.article_uid JOIN meshterm m ON am.meshterm_uid = m.uid WHERE m.descriptorname = 'Neoplasms'",
			);
		}

		// Extract all column descriptions
		const columnDescriptions = Object.values(enhancedSchemas).flatMap(
			(schema) =>
				Object.entries(schema.columns).map(([columnName, details]) => ({
					table: schema.table_name,
					column: columnName,
					type: details.type,
					description: details.description,
					example_values: details.example_values,
					common_aliases: details.common_aliases,
				})),
		);

		return {
			recommended_queries: recommendedQueries,
			common_joins: commonJoins,
			column_descriptions: columnDescriptions,
			example_usage: exampleUsage,
		};
	}

	private async executeEnhancedSql(sql: string): Promise<any> {
		try {
			// Enhanced error handling with suggestions
			if (!sql.trim().toLowerCase().startsWith("select")) {
				return {
					success: false,
					error: "Only SELECT queries are allowed for security reasons",
					suggestions: [
						"Try: SELECT * FROM article LIMIT 10",
						"Try: SELECT pmid, title FROM article WHERE year = 2024",
						"Use the recommended queries from the schema guidance",
					],
				};
			}

			const result = this.ctx.storage.sql.exec(sql);
			const rows = result.toArray();
			const resolvedRows = [];
			for (const row of rows) {
				const resolvedRow: any = {};
				for (const [key, value] of Object.entries(row)) {
					if (this.chunkingEngine.isContentReference(value)) {
						const contentId = this.chunkingEngine.extractContentId(
							value as string,
						);
						const content = await this.chunkingEngine.retrieveChunkedContent(
							contentId,
							this.ctx.storage.sql,
						);
						try {
							resolvedRow[key] = JSON.parse(content || "null");
						} catch {
							resolvedRow[key] = content;
						}
					} else {
						resolvedRow[key] = value;
					}
				}
				resolvedRows.push(resolvedRow);
			}
			return {
				success: true,
				results: resolvedRows,
				row_count: resolvedRows.length,
				query_executed: sql,
			};
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : "SQL execution failed";
			const suggestions = this.generateErrorSuggestions(errorMessage, sql);

			return {
				success: false,
				error: errorMessage,
				suggestions: suggestions,
				query_attempted: sql,
			};
		}
	}

	private generateErrorSuggestions(
		errorMessage: string,
		sql: string,
	): string[] {
		const suggestions: string[] = [];

		if (errorMessage.includes("no such table")) {
			suggestions.push(
				"Check available tables with: SELECT name FROM sqlite_master WHERE type='table'",
			);
			suggestions.push(
				"Common tables: article, meshterm, author, article_meshterm, article_author",
			);
		} else if (errorMessage.includes("no such column")) {
			suggestions.push(
				"Check column names - remember they are lowercase (e.g., 'descriptorname', not 'DescriptorName')",
			);
			suggestions.push(
				"Use 'year' not 'publication_date', 'pmid' not 'pubmed_id'",
			);
			suggestions.push("View table schema with: PRAGMA table_info(table_name)");
		} else if (errorMessage.includes("syntax error")) {
			suggestions.push("Check your SQL syntax");
			suggestions.push("Ensure proper JOIN syntax for relationships");
			suggestions.push("Use single quotes for string values");
		}

		// Add context-specific suggestions based on the query
		if (sql.toLowerCase().includes("mesh")) {
			suggestions.push(
				"For MeSH terms: JOIN article_meshterm am ON a.uid = am.article_uid JOIN meshterm m ON am.meshterm_uid = m.uid",
			);
		}
		if (sql.toLowerCase().includes("author")) {
			suggestions.push(
				"For authors: JOIN article_author aa ON a.uid = aa.article_uid JOIN author au ON aa.author_uid = au.uid",
			);
		}

		return suggestions;
	}

	private async getEnhancedSchema(): Promise<any> {
		const basicSchema = this.ctx.storage.sql
			.exec(`SELECT name, sql FROM sqlite_master WHERE type='table'`)
			.toArray();
		const enhancedSchemas = this.schemaEngine.getEnhancedSchemas();

		return {
			basic_schema: basicSchema,
			enhanced_schemas: enhancedSchemas,
			schema_guidance: this.generateSchemaGuidance(
				this.schemaEngine.entitySchemas || {},
			),
			quick_start: {
				sample_queries: [
					"SELECT COUNT(*) as total_articles FROM article",
					"SELECT DISTINCT year FROM article ORDER BY year DESC",
					"SELECT descriptorname, COUNT(*) as usage_count FROM meshterm GROUP BY descriptorname ORDER BY usage_count DESC LIMIT 10",
				],
				important_notes: [
					"Column names are lowercase (e.g., 'descriptorname', not 'DescriptorName')",
					"Use 'year' for publication year, not 'publication_date'",
					"MeSH terms require JOINs through article_meshterm table",
					"Authors require JOINs through article_author table",
				],
			},
		};
	}
}
