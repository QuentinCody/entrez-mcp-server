import { z } from "zod";
import { BaseTool } from "./base.js";

export class ESearchTool extends BaseTool {
	register(): void {
		this.context.server.tool(
			"esearch",
			"Search Entrez databases with text queries to find matching UIDs. Core Entrez function that converts queries into UID lists for use with other E-utilities. Supports Boolean operators (AND, OR, NOT) and field-specific searches.",
			{
				db: z.string().default("pubmed").describe("Database to search"),
				term: z.string().describe("Entrez text query"),
				retstart: z.number().optional().describe("Starting position (0-based)"),
				retmax: z.number().optional().default(20).describe("Maximum number of UIDs to retrieve"),
				sort: z.string().optional().describe("Sort method (e.g., 'relevance', 'pub_date')"),
				field: z.string().optional().describe("Search field limitation"),
				usehistory: z.enum(["y", "n"]).optional().describe("Use Entrez History server"),
				datetype: z.string().optional().describe("Date type for date filtering"),
				reldate: z.number().optional().describe("Relative date (last n days)"),
				mindate: z.string().optional().describe("Minimum date (YYYY/MM/DD)"),
				maxdate: z.string().optional().describe("Maximum date (YYYY/MM/DD)"),
				retmode: z.enum(["xml", "json"]).optional().default("xml").describe("Output format"),
			},
			async ({ db, term, retstart, retmax, sort, field, usehistory, datetype, reldate, mindate, maxdate, retmode }) => {
				try {
					// Validate inputs
					if (!term || term.trim() === '') {
						throw new Error("Search term cannot be empty");
					}
					if (db && !this.isValidDatabase(db)) {
						throw new Error(`Invalid database name: ${db}`);
					}
					if (retmax !== undefined && (retmax < 0 || retmax > 100000)) {
						throw new Error("retmax must be between 0 and 100000");
					}
					if (retstart !== undefined && retstart < 0) {
						throw new Error("retstart must be non-negative");
					}

					const params = new URLSearchParams({
						db: db || "pubmed",
						term: term.trim(),
						tool: this.context.defaultTool,
						email: this.context.defaultEmail,
						retmode: retmode || "xml"
					});

					if (retstart !== undefined) params.append("retstart", retstart.toString());
					if (retmax !== undefined) params.append("retmax", retmax.toString());
					if (sort) params.append("sort", sort);
					if (field) params.append("field", field);
					if (usehistory) params.append("usehistory", usehistory);
					if (datetype) params.append("datetype", datetype);
					if (reldate !== undefined) params.append("reldate", reldate.toString());
					if (mindate) params.append("mindate", mindate);
					if (maxdate) params.append("maxdate", maxdate);

					const url = this.buildUrl("esearch.fcgi", params);
					const response = await fetch(url);
					const data = await this.parseResponse(response, "ESearch", retmode);

					return {
						content: [
							{
								type: "text",
								text: `ESearch Results:\n\n${this.formatResponseData(data)}`
							}
						]
					};
				} catch (error) {
					return {
						content: [
							{
								type: "text",
								text: `Error in ESearch: ${error instanceof Error ? error.message : String(error)}`
							}
						]
					};
				}
			}
		);
	}
}
