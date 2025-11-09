import { z } from "zod";
import { BaseTool } from "./base.js";
import {
	SmartQueryGenerator,
	type QueryContext,
	type SchemaSummary,
	type QueryRows,
} from "../lib/smart-query-generator.js";
import type { IContentParser } from "../lib/parsers.js";

const DataManagerParamsShape = {
	operation: z
		.enum(["fetch_and_stage", "query", "schema", "list_datasets"])
		.describe("Data operation to perform"),

	// Fetch and stage parameters
	database: z
		.string()
		.optional()
		.describe("Source database (for fetch_and_stage)"),
	ids: z
		.string()
		.optional()
		.describe("Comma-separated UIDs to fetch and stage"),
	rettype: z
		.string()
		.optional()
		.default("xml")
		.describe("Data format to retrieve"),

	// Query parameters
	data_access_id: z
		.string()
		.optional()
		.describe("Dataset ID from previous staging operation"),
	sql: z.string().optional().describe("SQL query to execute on staged data"),

	// Advanced options
	force_direct: z
		.boolean()
		.optional()
		.describe("Force direct return instead of staging"),
	include_raw: z
		.boolean()
		.optional()
		.describe("Include raw data in staging response"),

	// Smart query options
	intended_use: z
		.enum(["search", "analysis", "citation", "full"])
		.optional()
		.describe("Context for intelligent query generation"),
	max_tokens: z
		.number()
		.optional()
		.describe("Maximum tokens for query results"),
	smart_summary: z
		.boolean()
		.optional()
		.describe("Generate intelligent summary instead of raw SQL results"),
	response_style: z
		.enum(["text", "json"])
		.optional()
		.default("text")
		.describe("Preferred output style for query results"),
};

const DataManagerParamsSchema = z.object(DataManagerParamsShape);
type DataManagerParams = z.infer<typeof DataManagerParamsSchema>;

type ParsedStagingResult = ReturnType<IContentParser["parse"]>;

export class DataManagerTool extends BaseTool {
	register(): void {
		this.registerTool(
			"entrez_data",
			"Stage Entrez payloads and explore them with SQL or smart summaries.",
			DataManagerParamsShape,
			async (params: DataManagerParams) => {
				try {
					const { operation } = params;

					// Enhanced validation based on operation
					switch (operation) {
						case "fetch_and_stage": {
							if (!params.database) {
								throw new Error(
									"fetch_and_stage requires 'database' parameter. Specify a database like 'pubmed', 'protein', or 'nuccore'.",
								);
							}
							if (!params.ids) {
								throw new Error(
									"fetch_and_stage requires 'ids' parameter. Provide comma-separated UIDs (e.g., \"12345,67890\").",
								);
							}
							// Validate database name
							const validDatabases = [
								"pubmed",
								"protein",
								"nuccore",
								"nucleotide",
								"gene",
								"genome",
								"pmc",
							];
							if (!validDatabases.includes(params.database.toLowerCase())) {
								throw new Error(
									`Invalid database "${params.database}". Valid options: ${validDatabases.join(", ")}`,
								);
							}
							break;
						}
						case "query":
							if (!params.data_access_id) {
								throw new Error(
									"query requires 'data_access_id' parameter. Use the ID returned from fetch_and_stage operation.",
								);
							}
							if (!params.sql && !params.smart_summary) {
								throw new Error(
									"query requires either 'sql' parameter (for custom queries) or 'smart_summary=true' (for auto-generated insights).",
								);
							}
							break;
						case "schema":
							if (!params.data_access_id) {
								throw new Error(
									"schema requires 'data_access_id' parameter. Use the ID returned from fetch_and_stage operation.",
								);
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
					const errorMessage =
						error instanceof Error ? error.message : String(error);

					// Enhanced error reporting with operation-specific guidance
					let enhancedError = `❌ **Error in ${params.operation || "entrez_data"}**: ${errorMessage}`;

					// Add operation-specific help
					if (params.operation) {
						switch (params.operation) {
							case "fetch_and_stage":
								enhancedError +=
									"\n\n🗃️ **Staging Help**: Use UIDs from successful search results and specify a valid database";
								break;
							case "query":
								enhancedError +=
									"\n\n🔍 **Query Help**: Use the data_access_id from fetch_and_stage, then provide SQL or use smart_summary=true";
								break;
							case "schema":
								enhancedError +=
									"\n\n📋 **Schema Help**: Use the data_access_id from a successful fetch_and_stage operation";
								break;
						}
					}

					// Add general guidance
					enhancedError +=
						"\n\n💡 **General Tips**:\n• Always use data_access_id from successful staging operations\n• Try fetch_and_stage first before querying data";

					return this.textResult(enhancedError);
				}
			},
			{ aliases: ["entrez-data"] },
		);
	}

	override getCapabilities() {
		return {
			tool: "entrez_data",
			summary:
				"Manage staged datasets, perform SQL queries, and inspect schemas.",
			operations: [
				{
					name: "fetch_and_stage",
					summary:
						"Fetch records via EFetch and persist into Durable Object staging.",
					required: [
						{
							name: "database",
							type: "string",
							description: "Source Entrez database",
						},
						{
							name: "ids",
							type: "string",
							description: "Comma-separated UID list",
						},
					],
					optional: [
						{
							name: "rettype",
							type: "string",
							description: "Entrez rettype (xml, fasta, gb)",
							defaultValue: "xml",
						},
						{
							name: "force_direct",
							type: "boolean",
							description: "Bypass staging and return formatted text",
						},
						{
							name: "include_raw",
							type: "boolean",
							description: "Embed raw payload preview in response",
						},
					],
					remarks: ["Returns data_access_id for follow-up queries"],
				},
				{
					name: "query",
					summary:
						"Execute SQL against staged dataset or ask for smart summaries.",
					required: [
						{
							name: "data_access_id",
							type: "string",
							description: "Identifier returned from staging",
						},
					],
					optional: [
						{
							name: "sql",
							type: "string",
							description: "SQL query to execute",
						},
						{
							name: "smart_summary",
							type: "boolean",
							description: "Let the tool craft summaries when SQL omitted",
						},
						{
							name: "intended_use",
							type: "string",
							description: "Formatter hint (analysis, citation, search, full)",
						},
						{
							name: "max_tokens",
							type: "number",
							description: "Cap on formatted token usage",
						},
						{
							name: "response_style",
							type: "string",
							description: "Return mode (text or json)",
						},
					],
					remarks: [
						"Set smart_summary=true with no SQL to auto-generate insights",
					],
				},
				{
					name: "schema",
					summary: "Inspect inferred schema for a staged dataset.",
					required: [
						{
							name: "data_access_id",
							type: "string",
							description: "Identifier returned from staging",
						},
					],
					optional: [],
					remarks: [
						"Includes column descriptions, sample counts, and primary keys",
					],
				},
				{
					name: "list_datasets",
					summary:
						"Enumerate active staged datasets within the Durable Object.",
					required: [],
					optional: [],
					remarks: ["Use to clean up or re-discover identifiers"],
				},
			],
			contexts: ["data_staging", "analysis", "sql_generation"],
			stageable: true,
			requiresApiKey: false,
			tokenProfile: { typical: 280, upper: 6000 },
			metadata: {
				requiresDurableObject: true,
				aliases: ["entrez-data"],
			},
		};
	}

	// biome-ignore lint/suspicious/noExplicitAny: dynamic payload validated via zod schema
	private async handleFetchAndStage(params: DataManagerParams) {
		const { database, ids, rettype, force_direct, include_raw } = params;

		if (!database || !ids) {
			throw new Error(
				"fetch_and_stage requires 'database' and 'ids' parameters",
			);
		}

		// Build fetch parameters
		const db = database!;
		const idList = ids!;
		const fetchParams = new URLSearchParams({
			db,
			id: idList,
			tool: this.context.defaultTool,
			email: this.context.defaultEmail,
			retmode: "xml", // Force XML for better parsing
		});

		if (rettype) fetchParams.append("rettype", rettype);

		const url = this.buildUrl("efetch.fcgi", fetchParams);
		const response = await fetch(url);
		const rawData = await this.parseResponse(response, "EFetch", "xml");

		// Get parser and process data
		const { getParserFor } = await import("../lib/parsers.js");
		const parser = getParserFor(database!, rettype);
		const parseResult = parser.parse(rawData);

		// Calculate staging metrics
		const payloadSize =
			typeof rawData === "string"
				? rawData.length
				: JSON.stringify(rawData).length;
		const bypassDecision = this.context.shouldBypassStaging(
			parseResult.entities,
			parseResult.diagnostics,
			payloadSize,
		);

		// Check if we should bypass staging
		const allowDirectReturn = force_direct !== false;
		if (bypassDecision.bypass && allowDirectReturn) {
			const body = `📄 **Data Retrieved Directly** (${bypassDecision.reason})\n\n${include_raw ? this.formatResponseData(rawData) : this.formatStagingBypass(parseResult, payloadSize)}`;
			return this.textResult(body);
		}

		// Proceed with staging
		return this.performStaging(
			parseResult,
			rawData,
			db,
			idList,
			include_raw ?? false,
		);
	}

	// biome-ignore lint/suspicious/noExplicitAny: dynamic payload validated via zod schema
	private async handleQuery(params: DataManagerParams) {
		const {
			data_access_id,
			sql,
			intended_use,
			max_tokens,
			smart_summary,
			response_style,
		} = params;

		try {
			// Get Durable Object instance
			const env = this.getEnvironment();
			if (!env?.JSON_TO_SQL_DO) {
				throw new Error("Staging service not available");
			}

			const doId = env.JSON_TO_SQL_DO.idFromName(data_access_id!);
			const doStub = env.JSON_TO_SQL_DO.get(doId);

			// If no SQL provided and smart_summary is enabled, generate intelligent queries
			if (!sql && smart_summary) {
				return await this.generateSmartSummary(doStub, params);
			}

			// Execute user-provided SQL query
			const queryResponse = await doStub.fetch(
				new Request("https://do/query-enhanced", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ sql }),
				}),
			);

			if (!queryResponse.ok) {
				const error = await queryResponse.text();
				throw new Error(`SQL query failed: ${error}`);
			}

			const result = (await queryResponse.json()) as unknown;
			const rows = Array.isArray(result)
				? (result as Record<string, unknown>[])
				: [];
			const rawJson = JSON.stringify(result, null, 2);

			// Format result based on context
			if (smart_summary && intended_use) {
				const normalizedUse =
					intended_use === "full" ? "analysis" : intended_use;
				const formatted = SmartQueryGenerator.formatQueryResult(rows, {
					operation: "query",
					database: "staged_data",
					intendedUse: normalizedUse as
						| "search"
						| "analysis"
						| "citation"
						| undefined,
					maxTokens: max_tokens,
				});

				const tokenEstimate = SmartQueryGenerator.estimateTokens(formatted);
				const summaryMessage = `📊 **SQL Query Results** (${tokenEstimate} tokens)\n\n${formatted}`;
				if (response_style === "json") {
					return this.result([
						this.textContent(summaryMessage),
						this.textContent(`\nRaw rows:\n\n\`\`\`json\n${rawJson}\n\`\`\``),
					]);
				}
				return this.textResult(summaryMessage);
			}

			if (response_style === "json") {
				return this.textResult(`\`\`\`json\n${rawJson}\n\`\`\``);
			}

			return this.textResult(
				`📊 **SQL Query Results**\n\n\`\`\`json\n${rawJson}\n\`\`\``,
			);
		} catch (error) {
			throw new Error(
				`Database query failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	// biome-ignore lint/suspicious/noExplicitAny: dynamic payload validated via zod schema
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
			const schemaResponse = await doStub.fetch(
				new Request("https://do/schema", {
					method: "GET",
				}),
			);

			if (!schemaResponse.ok) {
				const error = await schemaResponse.text();
				throw new Error(`Schema retrieval failed: ${error}`);
			}

			const schema = await schemaResponse.text();
			return this.textResult(`📋 **Database Schema**\n\n${schema}`);
		} catch (error) {
			throw new Error(
				`Schema retrieval failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	// biome-ignore lint/suspicious/noExplicitAny: dynamic payload validated via zod schema
	private async handleListDatasets(_params: DataManagerParams) {
		// This would ideally list all available datasets, but requires additional infrastructure
		return this.textResult(
			`📚 **Dataset Management**\n\nTo list datasets, you need to track data_access_ids from previous staging operations.\n\n💡 **Tip**: Each successful \`fetch_and_stage\` operation returns a unique data_access_id for future queries.`,
		);
	}

	// biome-ignore lint/suspicious/noExplicitAny: staging parser returns heterogeneous entity structures
	private async performStaging(
		parseResult: ParsedStagingResult,
		rawData: unknown,
		database: string,
		ids: string,
		includeRaw: boolean,
	) {
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
			const stagingResponse = await doStub.fetch(
				new Request("https://do/process", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						entities: parseResult.entities,
						diagnostics: parseResult.diagnostics,
					}),
				}),
			);

			if (!stagingResponse.ok) {
				const error = await stagingResponse.text();
				throw new Error(`Staging failed: ${error}`);
			}

			const stagingInfo = (await stagingResponse.json()) as {
				totalRows?: number;
				tableCount?: number;
				tables?: string[];
			};
			const idCount = ids.split(",").length;

			let responseText = `✅ **Data Successfully Staged**\n\n`;
			responseText += `🗃️  **Data Access ID**: \`${dataAccessId}\`\n`;

			// Add defensive checks for staging info properties
			if (
				stagingInfo.totalRows !== undefined &&
				stagingInfo.tableCount !== undefined
			) {
				responseText += `📊  **Records Staged**: ${stagingInfo.totalRows} rows across ${stagingInfo.tableCount} tables\n`;
			}
			if (stagingInfo.tables && Array.isArray(stagingInfo.tables)) {
				responseText += `📋  **Tables Created**: ${stagingInfo.tables.join(", ")}\n`;
			}
			responseText += `\n`;
			responseText += `## 🚀 Next Steps:\n`;
			responseText += `• Use \`entrez_data\` (alias \`entrez-data\`) with operation='query' and this data_access_id to run SQL queries\n`;
			responseText += `• Use \`entrez_data\` (alias \`entrez-data\`) with operation='schema' to see table structures\n\n`;
			responseText += `💡 **Pro tip**: Start with basic SELECT queries to explore your ${idCount} staged records!`;

			if (includeRaw) {
				responseText += `\n\n## 📄 Raw Data:\n\`\`\`\n${typeof rawData === "string" ? rawData.substring(0, 1000) : JSON.stringify(rawData).substring(0, 1000)}...\n\`\`\``;
			}

			return this.textResult(responseText);
		} catch (error) {
			throw new Error(
				`Data staging failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	// biome-ignore lint/suspicious/noExplicitAny: staging parser returns heterogeneous entity structures
	private formatStagingBypass(
		parseResult: ParsedStagingResult,
		payloadSize: number,
	): string {
		let response = `📊 **Dataset Summary**:\n`;
		response += `• **Entities Found**: ${parseResult.entities.length}\n`;
		response += `• **Size**: ${(payloadSize / 1024).toFixed(1)} KB\n`;
		response += `• **Quality**: ${parseResult.diagnostics.mesh_availability || "Unknown"}\n\n`;

		if (parseResult.entities.length > 0) {
			response += `📋 **Sample Data**:\n`;
			const sample = parseResult.entities.slice(0, 3);
			// biome-ignore lint/suspicious/noExplicitAny: sample entities are heterogeneous per parser
			sample.forEach((entity, i) => {
				response += `${i + 1}. ${entity.type}: ${JSON.stringify(entity.data).substring(0, 100)}...\n`;
			});
		}

		return response;
	}

	// biome-ignore lint/suspicious/noExplicitAny: Durable Object stub API uses untyped fetch interface
	private async generateSmartSummary(doStub: any, params: any) {
		const {
			intended_use = "analysis",
			max_tokens = 500,
			data_access_id,
		} = params;

		try {
			// Get schema first
			const schemaResponse = await doStub.fetch(
				new Request("https://do/schema", {
					method: "GET",
				}),
			);

			if (!schemaResponse.ok) {
				throw new Error("Unable to retrieve schema for smart query generation");
			}

			const schemaData = (await schemaResponse.json()) as SchemaSummary;

			// Generate context-aware queries
			const queryContext: QueryContext = {
				operation: "smart_summary",
				database: "staged_data",
				intendedUse: intended_use,
				maxTokens: max_tokens,
			};

			const queries = SmartQueryGenerator.generateContextualQueries(
				schemaData,
				queryContext,
			);

			// Execute queries and format results
			const queryExecutor = async (sql: string) => {
				const response = await doStub.fetch(
					new Request("https://do/query-enhanced", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ sql }),
					}),
				);

				if (!response.ok) {
					throw new Error(`Query failed: ${sql}`);
				}

				return (await response.json()) as QueryRows;
			};

			const smartResult = await SmartQueryGenerator.executeAndFormat(
				queries,
				queryExecutor,
				queryContext,
			);

			let responseText = `${smartResult.summary} (${smartResult.tokenEstimate} tokens)\n\n`;
			responseText += `## 🔍 **Key Insights**:\n`;
			smartResult.keyFindings.forEach((finding, i) => {
				responseText += `${i + 1}. ${finding}\n`;
			});

			responseText += `\n## 📊 **Analysis Results**:\n${smartResult.summary}\n\n`;

			responseText += `## 💡 **Available Operations**:\n`;
			smartResult.suggestedQueries.forEach((suggestion) => {
				responseText += `• ${suggestion}\n`;
			});

			responseText += `\n**Dataset ID**: \`${data_access_id}\``;

			return this.textResult(responseText);
		} catch (error) {
			return this.textResult(
				`❌ **Smart Summary Generation Failed**: ${error instanceof Error ? error.message : String(error)}\n\nFallback: Use manual SQL queries with the 'sql' parameter.`,
			);
		}
	}

	// biome-ignore lint/suspicious/noExplicitAny: accepts raw data payload of unknown shape for hashing
	private async generateDataAccessId(data: any): Promise<string> {
		const content = typeof data === "string" ? data : JSON.stringify(data);
		const encoder = new TextEncoder();
		const dataBuffer = encoder.encode(content + Date.now());
		const hashBuffer = await crypto.subtle.digest("SHA-256", dataBuffer);
		const hashArray = Array.from(new Uint8Array(hashBuffer));
		return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
	}
}
