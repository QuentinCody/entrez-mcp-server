import { z } from "zod";
import { BaseTool } from "./base.js";
import { getParserFor } from "../lib/parsers.js";

export class EFetchAndStageTool extends BaseTool {
	register(): void {
		this.context.server.tool(
			"efetch_and_stage",
			"Fetches and PARSES data from Entrez databases, then stages it into a relational SQLite database with proper entity extraction.",
			{
				db: z.string().default("pubmed").describe("Database name (e.g., 'pubmed', 'protein', 'nuccore')"),
				id: z.string().describe("Comma-separated list of UIDs"),
				rettype: z.string().optional().default("xml").describe("Data format (e.g., 'xml', 'fasta', 'gb'). Determines which parser to use.")
			},
			async ({ db, id, rettype }) => {
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

					const dbName = db || "pubmed";
					const format = rettype || "xml";

					// Set appropriate retmode for text-based parsing
					const retmode = "text";

					const params = new URLSearchParams({
						db: dbName,
						id: cleanIds.join(','),
						tool: this.context.defaultTool,
						email: this.context.defaultEmail,
						retmode: retmode,
						rettype: format
					});

					const url = this.buildUrl("efetch.fcgi", params);
					const response = await fetch(url);
					
					if (!response.ok) {
						throw new Error(`API Error: ${response.status} ${await response.text()}`);
					}

					const rawContent = await response.text();

					// --- THE NEW PARSER LAYER ---
					// Select the correct parser based on the database and format
					const parser = getParserFor(dbName, format);
					// Parse the raw text content into structured JSON with UIDs and diagnostics
					const parseResult = parser.parse(rawContent);
					const processedData = parseResult.entities;

					// --- INTELLIGENT BYPASS AND STAGING LOGIC ---
					const payloadSize = JSON.stringify(processedData).length;
					const entityCount = processedData.length;
					
					// Analyze data to determine if staging is beneficial
					const shouldBypass = this.context.shouldBypassStaging(processedData, parseResult.diagnostics, payloadSize);
					
					if (shouldBypass.bypass) {
						return {
							content: [{ type: "text", text: JSON.stringify({
								status: "success_direct",
								message: shouldBypass.reason,
								entity_count: entityCount,
								size_bytes: payloadSize,
								data: processedData,
								diagnostics: parseResult.diagnostics,
								note: "Data returned directly. For complex relational queries on larger datasets, staging provides SQL capabilities."
							}, null, 2) }]
						};
					}

					// --- HAND-OFF TO DURABLE OBJECT FOR STAGING (sending full parse result with diagnostics) ---
					const env = this.getEnvironment();
					if (!env?.JSON_TO_SQL_DO) {
						throw new Error("JSON_TO_SQL_DO binding not available");
					}
					const doId = env.JSON_TO_SQL_DO.newUniqueId();
					const stub = env.JSON_TO_SQL_DO.get(doId);
					const stagingResponse = await stub.fetch("http://do/process", {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify(parseResult)
					});
					const stagingResult = await stagingResponse.json() as any;

					// Check if we should return direct data even after staging for very simple results
					const stagingDetails = stagingResult.processing_details || {};
					if (stagingDetails.total_rows <= 15 && stagingDetails.table_count <= 2) {
						return {
							content: [{ type: "text", text: JSON.stringify({
								status: "success_simple_staged",
								message: "Simple dataset staged but returned directly for efficiency",
								entity_count: entityCount,
								data: processedData,
								staging_summary: `${stagingDetails.total_rows} rows in ${stagingDetails.table_count} tables`,
								data_access_id: stagingResult.data_access_id,
								note: "Data is also available via SQL using the data_access_id if needed"
							}, null, 2) }]
						};
					}

					// Return a highly readable, token-efficient summary
					const details = stagingDetails;
					const summary = `✅ **Data Successfully Staged in SQL Database**

🗃️  **Data Access ID**: \`${stagingResult.data_access_id}\`
📊  **Records Staged**: ${details.total_rows || 0} rows across ${details.table_count || 0} tables
📈  **Data Quality**: ${Math.round((details.data_quality?.completeness_score || 0) * 100)}% complete
📋  **Tables Created**: ${details.tables_created?.join(', ') || 'none'}

## 🚀 Quick Start Queries:
${details.schema_guidance?.recommended_queries?.slice(0, 3).map((q: any, i: number) => 
	`${i + 1}. \`${q.sql}\` - ${q.description}`
).join('\n') || '1. `SELECT * FROM article LIMIT 5` - View sample articles\n2. `SELECT * FROM author LIMIT 10` - View sample authors\n3. `SELECT * FROM meshterm LIMIT 10` - View sample MeSH terms'}

## 📋 Next Steps:
• Use **\`query_staged_data\`** with the data_access_id above to run any SQL query
• Use **\`get_staged_schema\`** to see full table structures and advanced query examples
• All data supports standard SQL: SELECT, JOIN, WHERE, GROUP BY, ORDER BY, etc.

💡 **Pro tip**: Start with \`SELECT * FROM article LIMIT 5\` to explore your data structure!`;

					return { content: [{ type: "text", text: summary }] };
				} catch (error) {
					return {
						content: [
							{
								type: "text",
								text: `Error in EFetch: ${error instanceof Error ? error.message : String(error)}`
							}
						]
					};
				}
			}
		);
	}
}

export class QueryStagedDataTool extends BaseTool {
	register(): void {
		this.context.server.tool(
			"query_staged_data",
			"Execute SQL queries against previously staged Entrez datasets. Query the relational database created by efetch_and_stage with full SQL support including JOINs, aggregations, and complex filtering across parsed biomedical data.",
			{
				data_access_id: z.string().describe("The data_access_id from a tool call that staged data."),
				sql: z.string().describe("The SQL SELECT query to run."),
			},
			async ({ data_access_id, sql }) => {
				try {
					const env = this.getEnvironment();
					if (!env?.JSON_TO_SQL_DO) {
						throw new Error("JSON_TO_SQL_DO binding not available");
					}
					const doId = env.JSON_TO_SQL_DO.idFromString(data_access_id);
					const stub = env.JSON_TO_SQL_DO.get(doId);
					const response = await stub.fetch("http://do/query-enhanced", {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ sql })
					});
					const result = await response.json();
					return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
				} catch (e) {
					return { content: [{ type: "text", text: "Error: Invalid data_access_id. Please provide a valid ID from a staging tool." }] };
				}
			}
		);
	}
}

export class GetStagedSchemaTool extends BaseTool {
	register(): void {
		this.context.server.tool(
			"get_staged_schema",
			"Get comprehensive schema information for staged datasets including table structures, column descriptions, common aliases, example values, and recommended query patterns. Essential for understanding your staged data.",
			{
				data_access_id: z.string().describe("The data_access_id from a tool call that staged data."),
			},
			async ({ data_access_id }) => {
				try {
					const env = this.getEnvironment();
					if (!env?.JSON_TO_SQL_DO) {
						throw new Error("JSON_TO_SQL_DO binding not available");
					}
					const doId = env.JSON_TO_SQL_DO.idFromString(data_access_id);
					const stub = env.JSON_TO_SQL_DO.get(doId);
					const response = await stub.fetch("http://do/schema");
					const schemaInfo = await response.json() as any;
					
					// Format the enhanced schema information for LLM consumption
					let output = `# Enhanced Database Schema and Query Guidance\n\n`;
					
					// Basic schema
					if (schemaInfo.basic_schema) {
						output += `## Database Tables:\n`;
						schemaInfo.basic_schema.forEach((table: any) => {
							output += `### ${table.name}\n\`\`\`sql\n${table.sql}\n\`\`\`\n\n`;
						});
					}
					
					// Enhanced column information
					if (schemaInfo.enhanced_schemas) {
						output += `## Column Descriptions:\n`;
						Object.values(schemaInfo.enhanced_schemas).forEach((schema: any) => {
							output += `### ${schema.table_name} Table:\n`;
							Object.entries(schema.columns).forEach(([colName, colInfo]: [string, any]) => {
								output += `- **${colName}** (${colInfo.type}): ${colInfo.description}\n`;
								if (colInfo.common_aliases.length > 0) {
									output += `  - Common aliases: ${colInfo.common_aliases.join(', ')}\n`;
								}
								if (colInfo.example_values.length > 0) {
									output += `  - Example values: ${colInfo.example_values.slice(0, 3).join(', ')}\n`;
								}
							});
							output += '\n';
						});
					}
					
					// Quick start queries
					if (schemaInfo.quick_start) {
						output += `## Quick Start Queries:\n`;
						schemaInfo.quick_start.sample_queries.forEach((query: string) => {
							output += `\`\`\`sql\n${query}\n\`\`\`\n`;
						});
						output += '\n';
						
						output += `## Important Notes:\n`;
						schemaInfo.quick_start.important_notes.forEach((note: string) => {
							output += `- ${note}\n`;
						});
						output += '\n';
					}
					
					// Common joins
					if (schemaInfo.schema_guidance?.common_joins) {
						output += `## Common Join Patterns:\n`;
						schemaInfo.schema_guidance.common_joins.forEach((join: any) => {
							output += `### ${join.description}\n`;
							output += `**Tables:** ${join.tables.join(', ')}\n`;
							output += `**Example:**\n\`\`\`sql\n${join.example_sql}\n\`\`\`\n\n`;
						});
					}
					
					// Recommended queries
					if (schemaInfo.schema_guidance?.recommended_queries) {
						output += `## Recommended Query Patterns:\n`;
						schemaInfo.schema_guidance.recommended_queries.forEach((rq: any) => {
							output += `### ${rq.description}\n`;
							output += `**Use case:** ${rq.use_case}\n`;
							output += `\`\`\`sql\n${rq.sql}\n\`\`\`\n\n`;
						});
					}

					return { content: [{ type: "text", text: output }] };
				} catch (e) {
					return { content: [{ type: "text", text: "Error: Invalid data_access_id. Please provide a valid ID from a staging tool." }] };
				}
			}
		);
	}
}
