import { z } from "zod";
import { BaseTool } from "./base.js";

export class ESearchTool extends BaseTool {
	register(): void {
		this.context.server.tool(
			"esearch",
			'Search Entrez databases with text queries to find matching UIDs. Core Entrez function that converts queries into UID lists for use with other E-utilities. Supports Boolean operators (AND, OR, NOT) and field-specific searches.\n\n🔍 **Common PubMed Fields**: [Title], [Author], [Journal], [MeSH], [Abstract], [Date], [DOI]\n🧬 **Sequence DB Fields**: [Organism], [Gene], [Protein], [Accession]\n🔬 **Search Examples**: \n• "cancer[Title] AND therapy[Abstract]" - Title contains cancer, abstract contains therapy\n• "Smith J[Author]" - Articles by author Smith J\n• "2023[Date]" - Articles from 2023\n• "Nature[Journal]" - Articles from Nature journal',
			{
				db: z.string().default("pubmed").describe("Database to search"),
				term: z.string().describe("Entrez text query"),
				retstart: z.number().optional().describe("Starting position (0-based)"),
				retmax: z
					.number()
					.optional()
					.default(20)
					.describe("Maximum number of UIDs to retrieve"),
				sort: z
					.string()
					.optional()
					.describe("Sort method (e.g., 'relevance', 'pub_date')"),
				field: z.string().optional().describe("Search field limitation"),
				usehistory: z
					.enum(["y", "n"])
					.optional()
					.describe("Use Entrez History server"),
				datetype: z
					.string()
					.optional()
					.describe("Date type for date filtering"),
				reldate: z.number().optional().describe("Relative date (last n days)"),
				mindate: z.string().optional().describe("Minimum date (YYYY/MM/DD)"),
				maxdate: z.string().optional().describe("Maximum date (YYYY/MM/DD)"),
				retmode: z
					.enum(["xml", "json"])
					.optional()
					.describe("Output format (auto-selected if not specified)"),
				intended_use: z
					.enum(["search", "staging", "analysis", "citation"])
					.optional()
					.describe("Intended use case for optimal format selection"),
			},
			async ({
				db,
				term,
				retstart,
				retmax,
				sort,
				field,
				usehistory,
				datetype,
				reldate,
				mindate,
				maxdate,
				retmode,
				intended_use,
			}) => {
				try {
					const dbName = db || "pubmed";

					// Enhanced query validation
					const queryValidation = this.context.validateQuery(term, dbName);
					if (!queryValidation.valid) {
						const errorMsg = queryValidation.message;
						const suggestion = queryValidation.suggestion
							? `\n💡 Suggestion: ${queryValidation.suggestion}`
							: "";
						throw new Error(`${errorMsg}${suggestion}`);
					}

					// Basic parameter validation
					if (db && !this.isValidDatabase(db)) {
						throw new Error(
							`Invalid database name: ${db}. Use 'einfo' tool to see available databases.`,
						);
					}
					if (retmax !== undefined && (retmax < 0 || retmax > 100000)) {
						throw new Error("retmax must be between 0 and 100000");
					}
					if (retstart !== undefined && retstart < 0) {
						throw new Error("retstart must be non-negative");
					}

					// Smart retmode selection
					const selectedRetmode =
						retmode ||
						this.context.getOptimalRetmode("esearch", dbName, intended_use);

					const params = new URLSearchParams({
						db: dbName,
						term: term.trim(),
						tool: this.context.defaultTool,
						email: this.context.defaultEmail,
						retmode: selectedRetmode,
					});

					if (retstart !== undefined)
						params.append("retstart", retstart.toString());
					if (retmax !== undefined) params.append("retmax", retmax.toString());
					if (sort) params.append("sort", sort);
					if (field) params.append("field", field);
					if (usehistory) params.append("usehistory", usehistory);
					if (datetype) params.append("datetype", datetype);
					if (reldate !== undefined)
						params.append("reldate", reldate.toString());
					if (mindate) params.append("mindate", mindate);
					if (maxdate) params.append("maxdate", maxdate);

					const url = this.buildUrl("esearch.fcgi", params);
					const response = await fetch(url);
					const data = await this.parseResponse(
						response,
						"ESearch",
						selectedRetmode,
					);

					// Get query suggestions
					const suggestions = this.context.suggestQueryImprovements(
						term,
						dbName,
					);
					const suggestionText =
						suggestions.length > 0
							? `\n\n💡 **Query Suggestions**:\n${suggestions.map((s) => `• ${s}`).join("\n")}`
							: "";

					return {
						content: [
							{
								type: "text",
								text: `ESearch Results (format: ${selectedRetmode}${intended_use ? `, optimized for: ${intended_use}` : ""}):\n\n${this.formatResponseData(data)}${suggestionText}`,
							},
						],
					};
				} catch (error) {
					return {
						content: [
							{
								type: "text",
								text: `Error in ESearch: ${error instanceof Error ? error.message : String(error)}`,
							},
						],
					};
				}
			},
		);
	}
}
