import { z } from "zod";
import { BaseTool } from "./base.js";

export class EInfoTool extends BaseTool {
	register(): void {
		this.context.server.tool(
			"einfo",
			"Get comprehensive metadata about NCBI Entrez databases including field statistics, last update dates, and available links to other databases. Covers all 38+ Entrez databases from PubMed to protein sequences.",
			{
				db: z.string().optional().describe("Database name (optional). If not provided, returns list of all databases"),
				version: z.string().optional().describe("Version 2.0 for enhanced XML output"),
				retmode: z.enum(["xml", "json"]).optional().default("xml").describe("Output format"),
			},
			async ({ db, version, retmode }) => {
				try {
					// Validate database if provided
					if (db && !this.isValidDatabase(db)) {
						throw new Error(`Invalid database name: ${db}`);
					}

					const params = new URLSearchParams({
						tool: this.context.defaultTool,
						email: this.context.defaultEmail,
						retmode: retmode || "xml"
					});

					if (db) params.append("db", db);
					if (version) params.append("version", version);

					const url = this.buildUrl("einfo.fcgi", params);
					const response = await fetch(url);
					const data = await this.parseResponse(response, "EInfo", retmode);

					return {
						content: [
							{
								type: "text",
								text: `EInfo Results:\n\n${this.formatResponseData(data)}`
							}
						]
					};
				} catch (error) {
					return {
						content: [
							{
								type: "text",
								text: `Error in EInfo: ${error instanceof Error ? error.message : String(error)}`
							}
						]
					};
				}
			}
		);
	}
}
