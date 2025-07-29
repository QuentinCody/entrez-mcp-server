import { z } from "zod";
import { BaseTool } from "./base.js";
import { SmartQueryGenerator, QueryContext } from "../lib/smart-query-generator.js";

export class DataManagerTool extends BaseTool {
	register(): void {
		this.context.server.tool(
			"data_manager",
			"Unified data operations for staging, querying, and schema management. Combines fetch-and-stage, SQL querying, and schema inspection in one optimized interface.",
			{
				operation: z.enum([
					"fetch_and_stage", "query", "schema", "list_datasets"
				]).describe("Data operation to perform"),
				
				// Fetch and stage parameters
				database: z.string().optional().describe("Source database (for fetch_and_stage)"),
				ids: z.string().optional().describe("Comma-separated UIDs to fetch and stage"),
				rettype: z.string().optional().default("xml").describe("Data format to retrieve"),
				
				// Query parameters
				data_access_id: z.string().optional().describe("Dataset ID from previous staging operation"),
				sql: z.string().optional().describe("SQL query to execute on staged data"),
				
				// Advanced options
				force_direct: z.boolean().optional().describe("Force direct return instead of staging"),
				include_raw: z.boolean().optional().describe("Include raw data in staging response"),
				
				// Smart query options
				intended_use: z.enum(["search", "analysis", "citation", "full"]).optional().describe("Context for intelligent query generation"),
				max_tokens: z.number().optional().describe("Maximum tokens for query results"),
				smart_summary: z.boolean().optional().describe("Generate intelligent summary instead of raw SQL results")
			},
			async (params) => {
				try {
					const { operation } = params;
					
					// Validate required parameters based on operation
					switch (operation) {
						case "fetch_and_stage":
							if (!params.database || !params.ids) {
								throw new Error("fetch_and_stage requires 'database' and 'ids' parameters");
							}
							break;
						case "query":
							if (!params.data_access_id || !params.sql) {
								throw new Error("query requires 'data_access_id' and 'sql' parameters");
							}
							break;
						case "schema":
							if (!params.data_access_id) {
								throw new Error("schema requires 'data_access_id' parameter");
							}
							break;
						// list_datasets has no required params
					}
					
					// Route to appropriate handler
					switch (operation) {
						case "fetch_and_stage":
							return await this.handleFetchAndStage(params);
						case "query":
							return await this.handleQuery(params);
						case "schema":
							return await this.handleSchema(params);
						case "list_datasets":
							return await this.handleListDatasets(params);
						default:
							throw new Error(`Unknown operation: ${operation}`);
					}
				} catch (error) {
					return {
						content: [{
							type: "text",
							text: `Error in Data Manager (${params.operation}): ${error instanceof Error ? error.message : String(error)}`
						}]
					};
				}
			}
		);
	}

	private async handleFetchAndStage(params: any) {
		const { database, ids, rettype, force_direct, include_raw } = params;
		
		// Build fetch parameters
		const fetchParams = new URLSearchParams({
			db: database,
			id: ids,
			tool: this.context.defaultTool,
			email: this.context.defaultEmail,
			retmode: "xml" // Force XML for better parsing
		});

		if (rettype) fetchParams.append("rettype", rettype);

		const url = this.buildUrl("efetch.fcgi", fetchParams);
		const response = await fetch(url);
		const rawData = await this.parseResponse(response, "EFetch", "xml");

		// Get parser and process data
		const { getParserFor } = await import("../lib/parsers.js");
		const parser = getParserFor("EFetch", rawData);
		const parseResult = parser.parse(rawData);

		// Calculate staging metrics
		const payloadSize = typeof rawData === 'string' ? rawData.length : JSON.stringify(rawData).length;
		const bypassDecision = this.context.shouldBypassStaging(parseResult.entities, parseResult.diagnostics, payloadSize);

		// Check if we should bypass staging
		if (bypassDecision.bypass && !force_direct === false) {
			return {
				content: [{
					type: "text",
					text: `📄 **Data Retrieved Directly** (${bypassDecision.reason})\n\n${include_raw ? this.formatResponseData(rawData) : this.formatStagingBypass(parseResult, payloadSize)}`
				}]
			};
		}

		// Proceed with staging
		return this.performStaging(parseResult, rawData, database, ids, include_raw);
	}

	private async handleQuery(params: any) {
		const { data_access_id, sql, intended_use, max_tokens, smart_summary } = params;
		
		try {
			// Get Durable Object instance
			const env = this.getEnvironment();
			if (!env?.JSON_TO_SQL_DO) {
				throw new Error("Staging service not available");
			}

			const doId = env.JSON_TO_SQL_DO.idFromName(data_access_id);
			const doStub = env.JSON_TO_SQL_DO.get(doId);
			
			// If no SQL provided and smart_summary is enabled, generate intelligent queries
			if (!sql && smart_summary) {
				return await this.generateSmartSummary(doStub, params);
			}
			
			// Execute user-provided SQL query
			const queryResponse = await doStub.fetch(new Request("https://do/query-enhanced", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ sql })
			}));

			if (!queryResponse.ok) {
				const error = await queryResponse.text();
				throw new Error(`SQL query failed: ${error}`);
			}

			const result = await queryResponse.json();
			
			// Format result based on context
			if (smart_summary && intended_use) {
				const formatted = SmartQueryGenerator['formatQueryResult'](result, {
					operation: 'query',
					database: 'staged_data',
					intendedUse: intended_use,
					maxTokens: max_tokens
				});
				
				const tokenEstimate = SmartQueryGenerator['estimateTokens'](formatted);
				
				return {
					content: [{
						type: "text" as const,
						text: `📊 **SQL Query Results** (${tokenEstimate} tokens)\n\n${formatted}`
					}]
				};
			}
			
			// Default JSON response for backward compatibility
			return {
				content: [{
					type: "text" as const,
					text: `📊 **SQL Query Results**\n\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\``
				}]
			};
		} catch (error) {
			throw new Error(`Database query failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private async handleSchema(params: any) {
		const { data_access_id } = params;
		
		try {
			// Get Durable Object instance
			const env = this.getEnvironment();
			if (!env?.JSON_TO_SQL_DO) {
				throw new Error("Staging service not available");
			}

			const doId = env.JSON_TO_SQL_DO.idFromName(data_access_id);
			const doStub = env.JSON_TO_SQL_DO.get(doId);
			
			// Get schema information
			const schemaResponse = await doStub.fetch(new Request("https://do/schema", {
				method: "GET"
			}));

			if (!schemaResponse.ok) {
				const error = await schemaResponse.text();
				throw new Error(`Schema retrieval failed: ${error}`);
			}

			const schema = await schemaResponse.text();
			
			return {
				content: [{
					type: "text",
					text: `📋 **Database Schema**\n\n${schema}`
				}]
			};
		} catch (error) {
			throw new Error(`Schema retrieval failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private async handleListDatasets(params: any) {
		// This would ideally list all available datasets, but requires additional infrastructure
		return {
			content: [{
				type: "text",
				text: `📚 **Dataset Management**\n\nTo list datasets, you need to track data_access_ids from previous staging operations.\n\n💡 **Tip**: Each successful \`fetch_and_stage\` operation returns a unique data_access_id for future queries.`
			}]
		};
	}

	private async performStaging(parseResult: any, rawData: any, database: string, ids: string, includeRaw: boolean) {
		try {
			// Get Durable Object instance
			const env = this.getEnvironment();
			if (!env?.JSON_TO_SQL_DO) {
				throw new Error("Staging service not available");
			}

			// Create unique access ID
			const dataAccessId = await this.generateDataAccessId(rawData);
			const doId = env.JSON_TO_SQL_DO.idFromName(dataAccessId);
			const doStub = env.JSON_TO_SQL_DO.get(doId);

			// Stage the data
			const stagingResponse = await doStub.fetch(new Request("https://do/process", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					entities: parseResult.entities,
					diagnostics: parseResult.diagnostics
				})
			}));

			if (!stagingResponse.ok) {
				const error = await stagingResponse.text();
				throw new Error(`Staging failed: ${error}`);
			}

			const stagingInfo = await stagingResponse.json();
			const idCount = ids.split(',').length;

			let responseText = `✅ **Data Successfully Staged**\n\n`;
			responseText += `🗃️  **Data Access ID**: \`${dataAccessId}\`\n`;
			responseText += `📊  **Records Staged**: ${stagingInfo.totalRows} rows across ${stagingInfo.tableCount} tables\n`;
			responseText += `📋  **Tables Created**: ${stagingInfo.tables.join(', ')}\n\n`;
			responseText += `## 🚀 Next Steps:\n`;
			responseText += `• Use \`data_manager\` with operation='query' and this data_access_id to run SQL queries\n`;
			responseText += `• Use \`data_manager\` with operation='schema' to see table structures\n\n`;
			responseText += `💡 **Pro tip**: Start with basic SELECT queries to explore your ${idCount} staged records!`;

			if (includeRaw) {
				responseText += `\n\n## 📄 Raw Data:\n\`\`\`\n${typeof rawData === 'string' ? rawData.substring(0, 1000) : JSON.stringify(rawData).substring(0, 1000)}...\n\`\`\``;
			}

			return {
				content: [{
					type: "text",
					text: responseText
				}]
			};
		} catch (error) {
			throw new Error(`Data staging failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private formatStagingBypass(parseResult: any, payloadSize: number): string {
		let response = `📊 **Dataset Summary**:\n`;
		response += `• **Entities Found**: ${parseResult.entities.length}\n`;
		response += `• **Size**: ${(payloadSize / 1024).toFixed(1)} KB\n`;
		response += `• **Quality**: ${parseResult.diagnostics.mesh_availability || 'Unknown'}\n\n`;
		
		if (parseResult.entities.length > 0) {
			response += `📋 **Sample Data**:\n`;
			const sample = parseResult.entities.slice(0, 3);
			sample.forEach((entity: any, i: number) => {
				response += `${i + 1}. ${entity.type}: ${JSON.stringify(entity.data).substring(0, 100)}...\n`;
			});
		}

		return response;
	}

	private async generateSmartSummary(doStub: any, params: any) {
		const { intended_use = 'analysis', max_tokens = 500, data_access_id } = params;
		
		try {
			// Get schema first
			const schemaResponse = await doStub.fetch(new Request("https://do/schema", {
				method: "GET"
			}));
			
			if (!schemaResponse.ok) {
				throw new Error("Unable to retrieve schema for smart query generation");
			}
			
			const schemaData = await schemaResponse.json();
			
			// Generate context-aware queries
			const queryContext: QueryContext = {
				operation: 'smart_summary',
				database: 'staged_data',
				intendedUse: intended_use,
				maxTokens: max_tokens
			};
			
			const queries = SmartQueryGenerator.generateContextualQueries(schemaData, queryContext);
			
			// Execute queries and format results
			const queryExecutor = async (sql: string) => {
				const response = await doStub.fetch(new Request("https://do/query-enhanced", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ sql })
				}));
				
				if (!response.ok) {
					throw new Error(`Query failed: ${sql}`);
				}
				
				return await response.json();
			};
			
			const smartResult = await SmartQueryGenerator.executeAndFormat(
				queries, 
				queryExecutor, 
				queryContext
			);
			
			let responseText = `${smartResult.summary} (${smartResult.tokenEstimate} tokens)\n\n`;
			responseText += `## 🔍 **Key Insights**:\n`;
			smartResult.keyFindings.forEach((finding, i) => {
				responseText += `${i + 1}. ${finding}\n`;
			});
			
			responseText += `\n## 📊 **Analysis Results**:\n${smartResult.summary}\n\n`;
			
			responseText += `## 💡 **Available Operations**:\n`;
			smartResult.suggestedQueries.forEach(suggestion => {
				responseText += `• ${suggestion}\n`;
			});
			
			responseText += `\n**Dataset ID**: \`${data_access_id}\``;
			
			return {
				content: [{
					type: "text" as const,
					text: responseText
				}]
			};
			
		} catch (error) {
			return {
				content: [{
					type: "text" as const,
					text: `❌ **Smart Summary Generation Failed**: ${error instanceof Error ? error.message : String(error)}\n\nFallback: Use manual SQL queries with the 'sql' parameter.`
				}]
			};
		}
	}

	private async generateDataAccessId(data: any): Promise<string> {
		const content = typeof data === 'string' ? data : JSON.stringify(data);
		const encoder = new TextEncoder();
		const dataBuffer = encoder.encode(content + Date.now());
		const hashBuffer = await crypto.subtle.digest('SHA-256', dataBuffer);
		const hashArray = Array.from(new Uint8Array(hashBuffer));
		return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
	}
}