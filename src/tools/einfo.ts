import { z } from "zod";
import { BaseTool } from "./base.js";
import { getParserForTool } from "../lib/parsers.js";

export class EInfoTool extends BaseTool {
	register(): void {
		this.context.server.tool(
			"einfo",
			"Get comprehensive metadata about NCBI Entrez databases including field statistics, last update dates, and available links to other databases. Covers all 38+ Entrez databases from PubMed to protein sequences.\n\n📚 **Major Databases**: pubmed (literature), protein (sequences), nuccore (nucleotides), gene (gene records), structure (3D structures)\n🔗 **Use Cases**: \n• Discover searchable fields for precise queries\n• Find cross-database links for related data\n• Check database size and update status\n• Plan search strategies with field information",
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

					// Check if we should stage this response
					const stagingDecision = this.context.shouldStageResponse(data, "EInfo");
					
					if (stagingDecision.shouldStage) {
						// Parse and stage the response
						const parser = getParserForTool("EInfo", data);
						const parseResult = parser.parse(data);
						
						// Stage the data using the DO
						const env = this.getEnvironment();
						if (!env?.JSON_TO_SQL_DO) {
							return {
								content: [{
									type: "text",
									text: `EInfo Results (optimized, ${stagingDecision.estimatedTokens} tokens):\n\n${this.formatResponseData(data)}`
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
								text: `✅ **EInfo Data Successfully Staged in SQL Database**\n\n🗃️  **Data Access ID**: \`${stagingResult.data_access_id}\`\n📊  **Records Staged**: ${stagingResult.processing_details?.total_rows || 0} rows across ${stagingResult.processing_details?.table_count || 0} tables\n📋  **Tables Created**: ${(stagingResult.processing_details?.tables_created || []).join(', ')}\n\n## 🚀 Quick Start Queries:\n1. \`SELECT name, full_name FROM searchable_field WHERE is_date = 1\` - Get date fields\n2. \`SELECT name, target_db FROM link_info ORDER BY target_db\` - Get available database links\n3. \`SELECT * FROM database_info\` - Get database metadata\n\n## 📋 Next Steps:\n• Use **\`query_staged_data\`** with the data_access_id above to run any SQL query\n• Use **\`get_staged_schema\`** to see full table structures and advanced query examples\n\n💡 **Pro tip**: Query field information to build better search strategies for this database!`
							}]
						};
					}

					return {
						content: [
							{
								type: "text",
								text: `EInfo Results (${stagingDecision.estimatedTokens} estimated tokens):\n\n${this.formatResponseData(data)}`
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
