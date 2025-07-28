import { z } from "zod";
import { BaseTool } from "./base.js";
import { getParserForTool } from "../lib/parsers.js";

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

					// Check if we should stage this response
					const stagingDecision = this.context.shouldStageResponse(data, "ESummary");
					
					if (stagingDecision.shouldStage) {
						// Parse and stage the response
						const parser = getParserForTool("ESummary", data);
						const parseResult = parser.parse(data);
						
						// Stage the data using the DO
						const env = this.getEnvironment();
						if (!env?.JSON_TO_SQL_DO) {
							return {
								content: [{
									type: "text",
									text: `ESummary Results (optimized, ${stagingDecision.estimatedTokens} tokens):\n\n${this.formatResponseData(data)}`
								}]
							};
						}

						const doId = env.JSON_TO_SQL_DO.newUniqueId();
						const stub = env.JSON_TO_SQL_DO.get(doId);
						const stagingResponse = await stub.fetch("http://do/process", {
							method: 'POST',
							headers: { 'Content-Type': 'application/json' },
							body: JSON.stringify(parseResult)
						});
						const stagingResult = await stagingResponse.json() as any;

						return {
							content: [{
								type: "text",
								text: `✅ **ESummary Data Successfully Staged in SQL Database**\n\n🗃️  **Data Access ID**: \`${stagingResult.data_access_id}\`\n📊  **Records Staged**: ${stagingResult.processing_details?.total_rows || 0} rows across ${stagingResult.processing_details?.table_count || 0} tables\n📋  **Tables Created**: ${(stagingResult.processing_details?.tables_created || []).join(', ')}\n\n## 🚀 Quick Start Queries:\n1. \`SELECT pmid, title, journal FROM document_summary ORDER BY pub_date DESC\` - Get recent publications\n2. \`SELECT pmid, title FROM document_summary WHERE doi IS NOT NULL\` - Find articles with DOIs\n3. \`SELECT journal, COUNT(*) as count FROM document_summary GROUP BY journal\` - Count by journal\n\n## 📋 Next Steps:\n• Use **\`query_staged_data\`** with the data_access_id above to run any SQL query\n• Use **\`get_staged_schema\`** to see full table structures and advanced query examples\n\n💡 **Pro tip**: Use SQL to filter and sort large result sets efficiently!`
							}]
						};
					}

					return {
						content: [
							{
								type: "text",
								text: `ESummary Results (${stagingDecision.estimatedTokens} estimated tokens):\n\n${this.formatResponseData(data)}`
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
