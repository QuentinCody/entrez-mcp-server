import { z } from "zod";
import { BaseTool } from "./base.js";

export class ESummaryTool extends BaseTool {
	register(): void {
		this.context.server.tool(
			"esummary",
			"Retrieve concise document summaries (DocSums) for UIDs from any Entrez database. Essential for getting key metadata like titles, authors, dates before deciding whether to fetch full records. Core Entrez engine function.",
			{
				db: z.string().default("pubmed").describe("Database name"),
				id: z.string().describe("Comma-separated list of UIDs"),
				retstart: z.number().optional().describe("Starting position"),
				retmax: z.number().optional().describe("Maximum number of summaries"),
				version: z.string().optional().describe("Version 2.0 for enhanced XML"),
				retmode: z.enum(["xml", "json"]).optional().default("xml").describe("Output format"),
			},
			async ({ db, id, retstart, retmax, version, retmode }) => {
				try {
					// Validate inputs
					if (!id || id.trim() === '') {
						throw new Error("ID parameter cannot be empty");
					}
					if (db && !this.isValidDatabase(db)) {
						throw new Error(`Invalid database name: ${db}`);
					}

					// Clean and validate IDs
					const cleanIds = id.split(',').map(i => i.trim()).filter(i => i !== '');
					if (cleanIds.length === 0) {
						throw new Error("No valid IDs provided");
					}
					if (cleanIds.length > 200) {
						throw new Error("Too many IDs provided (maximum 200)");
					}

					const params = new URLSearchParams({
						db: db || "pubmed",
						id: cleanIds.join(','),
						tool: this.context.defaultTool,
						email: this.context.defaultEmail,
						retmode: retmode || "xml"
					});

					if (retstart !== undefined) params.append("retstart", retstart.toString());
					if (retmax !== undefined) params.append("retmax", retmax.toString());
					if (version) params.append("version", version);

					const url = this.buildUrl("esummary.fcgi", params);
					const response = await fetch(url);
					const data = await this.parseResponse(response, "ESummary", retmode);

					return {
						content: [
							{
								type: "text",
								text: `ESummary Results:\n\n${this.formatResponseData(data)}`
							}
						]
					};
				} catch (error) {
					return {
						content: [
							{
								type: "text",
								text: `Error in ESummary: ${error instanceof Error ? error.message : String(error)}`
							}
						]
					};
				}
			}
		);
	}
}
