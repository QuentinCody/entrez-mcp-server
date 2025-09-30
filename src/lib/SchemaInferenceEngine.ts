// src/lib/SchemaInferenceEngine.ts

import {
	type EnhancedSchema,
	type ColumnDescription,
	type RecommendedQuery,
	CommonJoin,
} from "./types.js";

export class SchemaInferenceEngine {
	public entitySchemas: Record<string, any> = {};

	inferFromJSON(entities: { type: string; data: any }[]): Record<string, any> {
		const schemas: Record<string, any> = {};
		const typeGroups: Record<string, any[]> = {};

		// Group entities by type
		entities.forEach((entity) => {
			if (!typeGroups[entity.type]) {
				typeGroups[entity.type] = [];
			}
			typeGroups[entity.type].push(entity.data);
		});

		// Create schemas for each type
		Object.entries(typeGroups).forEach(([type, items]) => {
			schemas[type] = this.createSchemaFromItems(type, items);
		});

		// Create relationship tables for many-to-many relationships
		this.createRelationshipTables(schemas, typeGroups);

		this.entitySchemas = schemas;
		return schemas;
	}

	getEnhancedSchemas(): Record<string, EnhancedSchema> {
		const enhancedSchemas: Record<string, EnhancedSchema> = {};

		Object.entries(this.entitySchemas).forEach(([tableName, schema]) => {
			enhancedSchemas[tableName] = this.createEnhancedSchema(tableName, schema);
		});

		return enhancedSchemas;
	}

	private createEnhancedSchema(tableName: string, schema: any): EnhancedSchema {
		const columnDescriptions = this.getColumnDescriptions(tableName);
		const relationships = this.getTableRelationships(tableName);
		const exampleQueries = this.getRecommendedQueries(tableName);

		const enhancedColumns: Record<
			string,
			{
				type: string;
				description: string;
				example_values: string[];
				common_aliases: string[];
			}
		> = {};

		Object.entries(schema.columns).forEach(([columnName, sqlType]) => {
			const desc = columnDescriptions.find((cd) => cd.column === columnName);
			enhancedColumns[columnName] = {
				type: sqlType as string,
				description:
					desc?.description || `${columnName} field in ${tableName} table`,
				example_values: desc?.example_values || [],
				common_aliases: desc?.common_aliases || [],
			};
		});

		return {
			table_name: tableName,
			columns: enhancedColumns,
			relationships,
			example_queries: exampleQueries,
		};
	}

	private getColumnDescriptions(tableName: string): ColumnDescription[] {
		const descriptions: Record<string, ColumnDescription[]> = {
			article: [
				{
					table: "article",
					column: "uid",
					type: "TEXT",
					description: "Unique identifier for the article, same as PMID",
					example_values: ["40552132", "39952686", "40023593"],
					common_aliases: ["article_id", "id", "pmid"],
				},
				{
					table: "article",
					column: "pmid",
					type: "TEXT",
					description:
						"PubMed ID - unique identifier for articles in PubMed database",
					example_values: ["40552132", "39952686", "40023593"],
					common_aliases: ["pubmed_id", "article_id", "uid"],
				},
				{
					table: "article",
					column: "title",
					type: "TEXT",
					description: "Full title of the research article",
					example_values: [
						"Pharmacogenomics of cancer therapy",
						"Novel biomarkers in oncology",
					],
					common_aliases: ["article_title", "publication_title"],
				},
				{
					table: "article",
					column: "journal",
					type: "TEXT",
					description: "Name of the journal where article was published",
					example_values: ["Nature", "Science", "Cell", "NEJM"],
					common_aliases: ["journal_name", "publication"],
				},
				{
					table: "article",
					column: "year",
					type: "INTEGER",
					description: "Publication year (4-digit year)",
					example_values: ["2024", "2023", "2022"],
					common_aliases: ["publication_year", "pub_year", "publication_date"],
				},
				{
					table: "article",
					column: "abstract",
					type: "TEXT",
					description: "Full text abstract of the article",
					example_values: [
						"Background: This study...",
						"Objectives: To investigate...",
					],
					common_aliases: ["summary", "abstract_text"],
				},
			],
			meshterm: [
				{
					table: "meshterm",
					column: "uid",
					type: "TEXT",
					description: "Unique identifier for this MeSH term instance",
					example_values: ["40552132_mesh_0", "40552132_mesh_1"],
					common_aliases: ["mesh_id", "term_id"],
				},
				{
					table: "meshterm",
					column: "descriptorname",
					type: "TEXT",
					description:
						"MeSH descriptor name - standardized medical subject heading",
					example_values: ["Neoplasms", "Pharmacogenetics", "Drug Therapy"],
					common_aliases: ["mesh_term", "descriptor", "term", "mesh_heading"],
				},
			],
			author: [
				{
					table: "author",
					column: "uid",
					type: "TEXT",
					description: "Unique identifier for this author instance",
					example_values: ["40552132_auth_0", "40552132_auth_1"],
					common_aliases: ["author_id", "auth_id"],
				},
				{
					table: "author",
					column: "lastname",
					type: "TEXT",
					description: "Author's last name or surname",
					example_values: ["Smith", "Johnson", "Chen"],
					common_aliases: ["surname", "family_name", "last_name"],
				},
				{
					table: "author",
					column: "forename",
					type: "TEXT",
					description: "Author's first name and middle initials",
					example_values: ["John A", "Mary", "David M"],
					common_aliases: ["firstname", "given_name", "first_name"],
				},
				{
					table: "author",
					column: "affiliation",
					type: "TEXT",
					description: "Author's institutional affiliation",
					example_values: ["Harvard Medical School", "Stanford University"],
					common_aliases: ["institution", "organization"],
				},
			],
		};

		return descriptions[tableName] || [];
	}

	private getTableRelationships(tableName: string): string[] {
		const relationships: Record<string, string[]> = {
			article: [
				"article.uid = article_meshterm.article_uid (many-to-many via junction table)",
				"article.uid = article_author.article_uid (many-to-many via junction table)",
			],
			meshterm: [
				"meshterm.uid = article_meshterm.meshterm_uid (many-to-many via junction table)",
			],
			author: [
				"author.uid = article_author.author_uid (many-to-many via junction table)",
			],
			article_meshterm: [
				"article_meshterm.article_uid = article.uid",
				"article_meshterm.meshterm_uid = meshterm.uid",
			],
			article_author: [
				"article_author.article_uid = article.uid",
				"article_author.author_uid = author.uid",
			],
		};

		return relationships[tableName] || [];
	}

	private getRecommendedQueries(tableName: string): RecommendedQuery[] {
		const queries: Record<string, RecommendedQuery[]> = {
			article: [
				{
					description: "Get basic article information",
					sql: "SELECT pmid, title, journal, year FROM article ORDER BY year DESC",
					use_case: "Overview of articles with publication details",
				},
				{
					description: "Find articles with abstracts",
					sql: "SELECT pmid, title, abstract FROM article WHERE abstract IS NOT NULL",
					use_case: "Articles that have full abstract text available",
				},
			],
			meshterm: [
				{
					description: "Get all unique MeSH terms",
					sql: "SELECT DISTINCT descriptorname FROM meshterm ORDER BY descriptorname",
					use_case: "List all medical subject headings in the dataset",
				},
			],
			article_meshterm: [
				{
					description: "Articles with their MeSH terms",
					sql: "SELECT a.pmid, a.title, m.descriptorname FROM article a JOIN article_meshterm am ON a.uid = am.article_uid JOIN meshterm m ON am.meshterm_uid = m.uid",
					use_case: "Connect articles to their medical subject classifications",
				},
			],
		};

		return queries[tableName] || [];
	}

	private createSchemaFromItems(type: string, items: any[]): any {
		const columns: Record<string, string> = {};
		const sample_data = items.slice(0, 3);

		if (items.length === 0) return { columns, sample_data };

		// Analyze all items to determine column types
		const columnTypes: Record<string, Set<string>> = {};

		items.forEach((item) => {
			Object.entries(item).forEach(([key, value]) => {
				if (!columnTypes[key]) columnTypes[key] = new Set();

				if (value === null || value === undefined) {
					columnTypes[key].add("NULL");
				} else if (typeof value === "number") {
					columnTypes[key].add(Number.isInteger(value) ? "INTEGER" : "REAL");
				} else if (typeof value === "boolean") {
					columnTypes[key].add("INTEGER"); // SQLite stores booleans as integers
				} else if (Array.isArray(value)) {
					columnTypes[key].add("TEXT"); // Store arrays as JSON strings
				} else if (typeof value === "object") {
					columnTypes[key].add("TEXT"); // Store objects as JSON strings
				} else {
					columnTypes[key].add("TEXT");
				}
			});
		});

		// Determine final column types
		Object.entries(columnTypes).forEach(([key, types]) => {
			types.delete("NULL"); // Remove NULL from consideration

			if (types.has("TEXT")) {
				columns[key] = "TEXT";
			} else if (types.has("REAL")) {
				columns[key] = "REAL";
			} else if (types.has("INTEGER")) {
				columns[key] = "INTEGER";
			} else {
				columns[key] = "TEXT"; // Default fallback
			}
		});

		return { columns, sample_data };
	}

	private createRelationshipTables(
		schemas: Record<string, any>,
		typeGroups: Record<string, any[]>,
	): void {
		// Create article-meshterm relationship table
		if (schemas.article && schemas.meshterm) {
			schemas.article_meshterm = {
				columns: {
					article_uid: "TEXT",
					meshterm_uid: "TEXT",
				},
				sample_data: [],
			};
		}

		// Create article-author relationship table
		if (schemas.article && schemas.author) {
			schemas.article_author = {
				columns: {
					article_uid: "TEXT",
					author_uid: "TEXT",
				},
				sample_data: [],
			};
		}
	}
}
