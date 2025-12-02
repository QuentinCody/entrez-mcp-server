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

const DataManagerOutputSchema = z
	.object({
		success: z.boolean().optional(),
		data_access_id: z.string().optional(),
		schema: z.record(z.unknown()).optional(),
		results: z.array(z.unknown()).optional(),
		datasets: z.array(z.unknown()).optional(),
	})
	.passthrough();

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

					// Enhanced validation based on operation - return errors instead of throwing
					switch (operation) {
						case "fetch_and_stage": {
							if (!params.database) {
								return this.errorResult(
									"fetch_and_stage requires 'database' parameter",
									[
										"Specify a database like 'pubmed', 'protein', or 'nuccore'",
										'Example: { operation: "fetch_and_stage", database: "pubmed", ids: "12345,67890" }',
									],
								);
							}
							if (!params.ids) {
								return this.errorResult(
									"fetch_and_stage requires 'ids' parameter",
									[
										"Provide comma-separated UIDs",
										'Example: { operation: "fetch_and_stage", database: "pubmed", ids: "12345,67890" }',
									],
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
								return this.errorResult(
									`Invalid database "${params.database}"`,
									[
										`Valid options: ${validDatabases.join(", ")}`,
										"Use a supported NCBI database name",
									],
								);
							}
							break;
						}
						case "query":
							if (!params.data_access_id) {
								return this.errorResult(
									"query requires 'data_access_id' parameter",
									[
										"Use the ID returned from fetch_and_stage operation",
										'Example: { operation: "query", data_access_id: "abc123", sql: "SELECT * FROM article" }',
									],
								);
							}
							if (!params.sql && !params.smart_summary) {
								return this.errorResult(
									"query requires either 'sql' parameter or 'smart_summary=true'",
									[
										"Provide SQL: { sql: \"SELECT * FROM article LIMIT 10\" }",
										"Or use smart summary: { smart_summary: true }",
									],
								);
							}
							break;
						case "schema":
							if (!params.data_access_id) {
								return this.errorResult(
									"schema requires 'data_access_id' parameter",
									[
										"Use the ID returned from fetch_and_stage operation",
										'Example: { operation: "schema", data_access_id: "abc123" }',
									],
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
							return this.errorResult(`Unknown operation: ${operation}`, [
								"Valid operations: fetch_and_stage, query, schema, list_datasets",
							]);
					}
				} catch (error) {
					// Catch unexpected runtime errors (network issues, parsing failures, etc.)
					const errorMessage =
						error instanceof Error ? error.message : String(error);

					// Build contextual help based on operation
					const contextualHelp: string[] = [];

					if (params.operation) {
						switch (params.operation) {
							case "fetch_and_stage":
								contextualHelp.push(
									"🗃️ Staging Tips: Use UIDs from successful search results and specify a valid database",
								);
								break;
							case "query":
								contextualHelp.push(
									"🔍 Query Tips: Use the data_access_id from fetch_and_stage, then provide SQL or use smart_summary=true",
								);
								break;
							case "schema":
								contextualHelp.push(
									"📋 Schema Tips: Use the data_access_id from a successful fetch_and_stage operation",
								);
								break;
						}
					}

					// Add general guidance
					contextualHelp.push(
						"💡 General Tips: Always use data_access_id from successful staging operations",
						"💡 Try fetch_and_stage first before querying data",
					);

					// Return error with context per MCP spec
					return this.errorResult(
						`Error in ${params.operation || "entrez_data"}: ${errorMessage}`,
						contextualHelp,
					);
				}
			},
			{
				title: "NCBI Data Staging & SQL Query Manager",
				outputSchema: DataManagerOutputSchema,
			},
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
			},
		};
	}

	// biome-ignore lint/suspicious/noExplicitAny: dynamic payload validated via zod schema
	private async handleFetchAndStage(params: DataManagerParams) {
		const { database, ids, rettype, force_direct, include_raw } = params;

		if (!database || !ids) {
			throw new Error(
				"fetch_and_stage requires both 'database' and 'ids' parameters",
			);
		}

		const db = database!;
		const idList = ids!;
		const fetchParams = new URLSearchParams({
			db,
			id: idList,
			tool: this.context.defaultTool,
			email: this.context.defaultEmail,
			retmode: "xml",
		});

		if (rettype) {
			fetchParams.append("rettype", rettype);
		}

		const url = this.buildUrl("efetch.fcgi", fetchParams);
		const response = await fetch(url);
		const rawData = await this.parseResponse(response, "EFetch", "xml");

		const { getParserFor } = await import("../lib/parsers.js");
		const parser = getParserFor(db, rettype);
		const parseResult = parser.parse(rawData);

		const payloadSize =
			typeof rawData === "string"
				? rawData.length
				: JSON.stringify(rawData).length;
		const bypassDecision = this.context.shouldBypassStaging(
			parseResult.entities,
			parseResult.diagnostics,
			payloadSize,
		);

		const allowDirectReturn = force_direct !== false;
		if (bypassDecision.bypass && allowDirectReturn) {
			const sampleData = parseResult.entities.slice(0, 3).map((entity) => ({
				type: entity.type,
				snippet: JSON.stringify(entity.data).slice(0, 120),
			}));

			const bypassPayload = {
				success: true,
				message: "Data retrieved directly without staging.",
				database: db,
				requested_ids: idList.split(",").map((id) => id.trim()),
				entity_count: parseResult.entities.length,
				payload_size_bytes: payloadSize,
				reason: bypassDecision.reason,
				sample_data: sampleData,
				staging_skipped: true,
				diagnostics: parseResult.diagnostics,
			};

			const bypassSummary = [
				`📄 **Data Retrieved Directly** (${bypassDecision.reason})`,
				`• Entities: ${parseResult.entities.length}`,
				`• Parsed size: ${(payloadSize / 1024).toFixed(1)} KB`,
				include_raw
					? `\n✅ Raw data preview available`
					: this.formatStagingBypass(parseResult, payloadSize),
			].join("\n");

			return this.structuredResult(bypassPayload, bypassSummary);
		}

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

			const queryResult = (await queryResponse.json()) as {
				success?: boolean;
				results?: Record<string, unknown>[];
				row_count?: number;
				query_executed?: string;
				error?: string;
				suggestions?: string[];
			};

			const payload = {
				success: queryResult.success ?? true,
				message: queryResult.success
					? "SQL query executed successfully."
					: (queryResult.error ?? "SQL query failed."),
				data_access_id,
				query: sql,
				row_count: queryResult.row_count ?? queryResult.results?.length ?? 0,
				results: queryResult.results ?? [],
				query_executed: queryResult.query_executed ?? sql,
				suggestions: queryResult.suggestions ?? [],
				intended_use,
				response_style,
			};

			const summaryLines = [
				`📊 **SQL Query Results**: ${payload.row_count} rows`,
				`🔎 Query: ${payload.query_executed}`,
				payload.suggestions && payload.suggestions.length > 0
					? `💡 Suggestions:\n• ${payload.suggestions.join("\n• ")}`
					: "",
			];

			return this.structuredResult(payload, summaryLines.join("\n"));
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
			const env = this.getEnvironment();
			if (!env?.JSON_TO_SQL_DO) {
				throw new Error("Staging service not available");
			}

			const doId = env.JSON_TO_SQL_DO.idFromName(data_access_id);
			const doStub = env.JSON_TO_SQL_DO.get(doId);

			const schemaResponse = await doStub.fetch(
				new Request("https://do/schema", {
					method: "GET",
				}),
			);

			if (!schemaResponse.ok) {
				const error = await schemaResponse.text();
				throw new Error(`Schema retrieval failed: ${error}`);
			}

			const schemaData = (await schemaResponse.json()) as any;
			const tableNames = Array.isArray(schemaData.basic_schema)
				? schemaData.basic_schema.map((table: any) => table.name)
				: [];

			const payload = {
				success: true,
				message: "Enhanced database schema retrieved successfully.",
				data_access_id,
				schema: schemaData,
				table_names: tableNames,
				quick_start: schemaData.quick_start ?? {},
				schema_guidance: schemaData.schema_guidance ?? {},
			};

			const summary = [
				`📋 **Database Schema** retrieved (${tableNames.length} tables)`,
				tableNames.length > 0
					? `• Tables: ${tableNames.join(", ")}`
					: "• Tables information unavailable",
				"Use recommended queries to explore the staged data.",
			].join("\n");

			return this.structuredResult(payload, summary);
		} catch (error) {
			throw new Error(
				`Schema retrieval failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	// biome-ignore lint/suspicious/noExplicitAny: dynamic payload validated via zod schema
	private async handleListDatasets(_params: DataManagerParams) {
		const payload = {
			success: true,
			message:
				"Dataset listing requires you to track previous data_access_id values.",
			tips: [
				"Store each returned data_access_id after staging for future reference",
				"Use `entrez_data` with `operation='schema'` to inspect each dataset",
			],
		};

		const summary = [
			"📚 **Dataset Management**",
			"Track data_access_ids from prior staging operations to query or inspect data.",
			"Use the schema operation to confirm table structures before querying.",
		].join("\n");

		return this.structuredResult(payload, summary);
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
			const env = this.getEnvironment();
			if (!env?.JSON_TO_SQL_DO) {
				throw new Error("Staging service not available");
			}

			const dataAccessId = await this.generateDataAccessId(rawData);
			const doId = env.JSON_TO_SQL_DO.idFromName(dataAccessId);
			const doStub = env.JSON_TO_SQL_DO.get(doId);

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

			const stagingResult = (await stagingResponse.json()) as {
				success?: boolean;
				message?: string;
				data_access_id?: string;
				processing_details?: {
					tables_created?: string[];
					table_count?: number;
					total_rows?: number;
					data_quality?: unknown;
					parsing_diagnostics?: unknown;
					schema_guidance?: {
						recommended_queries?: unknown[];
						common_joins?: unknown[];
						column_descriptions?: unknown[];
						example_usage?: unknown[];
					};
				};
			};
			const details = stagingResult.processing_details ?? {};
			const tables = details.tables_created ?? [];
			const joinTables =
				details.schema_guidance?.common_joins?.flatMap(
					(join: any) => join.tables ?? [],
				) ?? [];
			const suggestedTables = Array.from(new Set([...tables, ...joinTables]));
			if (suggestedTables.length === 0) {
				suggestedTables.push("article", "meshterm", "author");
			}
			const idList = ids
				.split(",")
				.map((id) => id.trim())
				.filter((id) => id.length > 0);

			const stagedRecordCount = details.total_rows ?? 0;
			const stagedTableCount = details.table_count ?? suggestedTables.length;

			const payload: Record<string, unknown> = {
				success: stagingResult.success ?? true,
				message:
					stagingResult.message ??
					"Data successfully staged into the SQL dataset.",
				data_access_id: dataAccessId,
				database,
				requested_ids: idList,
				staged_record_count: stagedRecordCount,
				staged_table_count: stagedTableCount,
				tables_created: tables,
				suggested_tables: suggestedTables,
				schema_guidance: details.schema_guidance ?? {},
				diagnostics: details.parsing_diagnostics ?? {},
				quality_metrics: details.data_quality ?? {},
			};

			if (includeRaw) {
				const rawString =
					typeof rawData === "string"
						? rawData
						: JSON.stringify(rawData, null, 2);
				payload.raw_preview = `${rawString.substring(0, 1000)}${
					rawString.length > 1000 ? "..." : ""
				}`;
			}

			const summaryLines = [
				`✅ **Data Successfully Staged**`,
				`🗃️  **Data Access ID**: \`${dataAccessId}\``,
				`📊  **Records Staged**: ${stagedRecordCount} rows across ${stagedTableCount} tables`,
				`📋  **Tables Created**: ${tables.join(", ") || "none"}`,
				`🔍  **Suggested Tables**: ${suggestedTables.join(", ")}`,
				`💡  Start with \`SELECT * FROM ${suggestedTables[0]} LIMIT 5\` to explore the data`,
			];

			return this.structuredResult(payload, summaryLines.join("\n"));
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
			const schemaResponse = await doStub.fetch(
				new Request("https://do/schema", {
					method: "GET",
				}),
			);

			if (!schemaResponse.ok) {
				throw new Error("Unable to retrieve schema for smart query generation");
			}

			const schemaData = (await schemaResponse.json()) as SchemaSummary;

			const queryContext: QueryContext = {
				operation: "smart_summary",
				database: "staged_data",
				intendedUse: intended_use,
				maxTokens: max_tokens,
				userQuery: params.user_query,
			};

			const queries = SmartQueryGenerator.generateContextualQueries(
				schemaData,
				queryContext,
			);

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

			const payload = {
				success: true,
				message: smartResult.summary,
				data_access_id,
				token_estimate: smartResult.tokenEstimate,
				key_findings: smartResult.keyFindings,
				suggested_queries: smartResult.suggestedQueries,
				intended_use,
				max_tokens,
			};

			const summaryLines = [
				`${smartResult.summary} (${smartResult.tokenEstimate} tokens)`,
				"## 🔍 Key Insights:",
				...smartResult.keyFindings.map((finding, i) => `${i + 1}. ${finding}`),
				"## 💡 Suggested Follow-up Queries:",
				...smartResult.suggestedQueries.map((suggestion) => `• ${suggestion}`),
				`Dataset ID: ${data_access_id}`,
			];

			return this.structuredResult(payload, summaryLines.join("\n"));
		} catch (error) {
			return this.structuredResult(
				{
					success: false,
					message: `Smart Summary Generation Failed: ${
						error instanceof Error ? error.message : String(error)
					}`,
				},
				`❌ Smart summary generation failed. Use manual SQL queries or retry with a different context.`,
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
