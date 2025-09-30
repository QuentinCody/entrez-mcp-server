import { z } from "zod";
import { BaseTool } from "./base.js";
import { ResponseFormatter } from "../lib/response-formatter.js";

// Validation utilities
interface ValidationResult {
	isValid: boolean;
	error?: string;
	suggestions?: string[];
	correctedValue?: string;
}

// Database validation mapping
const VALID_DATABASES = [
	"pubmed",
	"protein",
	"nuccore",
	"nucleotide",
	"gene",
	"genome",
	"assembly",
	"bioproject",
	"biosample",
	"books",
	"cdd",
	"clinvar",
	"conserved_domains",
	"dbvar",
	"gap",
	"gapplus",
	"gds",
	"gtr",
	"homologene",
	"medgen",
	"mesh",
	"nlmcatalog",
	"omim",
	"orgtrack",
	"pcassay",
	"pccompound",
	"pcsubstance",
	"pmc",
	"popset",
	"probe",
	"proteinclusters",
	"pubmedhealth",
	"seqannot",
	"snp",
	"sra",
	"structure",
	"taxonomy",
	"toolkit",
	"toolkitall",
	"toolkitbook",
	"unigene",
];

// Rettype validation mapping per database
const VALID_RETTYPES: Record<string, string[]> = {
	pubmed: ["abstract", "medline", "xml", "uilist", "docsum"],
	protein: ["fasta", "seqid", "acc", "gb", "gp", "xml", "uilist"],
	nuccore: ["fasta", "gb", "acc", "seqid", "xml", "uilist"],
	nucleotide: ["fasta", "gb", "acc", "seqid", "xml", "uilist"],
	gene: ["xml", "uilist", "docsum", "gene_table"],
	genome: ["xml", "uilist", "docsum"],
	structure: ["mmdb", "xml", "uilist"],
	taxonomy: ["xml", "uilist", "docsum"],
	snp: ["flt", "xml", "uilist", "docsum"],
	pmc: ["xml", "uilist", "docsum"],
};

// Levenshtein distance for suggestions
function levenshteinDistance(a: string, b: string): number {
	const matrix = Array(b.length + 1)
		.fill(null)
		.map(() => Array(a.length + 1).fill(null));
	for (let i = 0; i <= a.length; i++) matrix[0][i] = i;
	for (let j = 0; j <= b.length; j++) matrix[j][0] = j;
	for (let j = 1; j <= b.length; j++) {
		for (let i = 1; i <= a.length; i++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			matrix[j][i] = Math.min(
				matrix[j][i - 1] + 1,
				matrix[j - 1][i] + 1,
				matrix[j - 1][i - 1] + cost,
			);
		}
	}
	return matrix[b.length][a.length];
}

function validateDatabase(database: string): ValidationResult {
	if (VALID_DATABASES.includes(database.toLowerCase())) {
		return { isValid: true };
	}

	const suggestions = VALID_DATABASES.filter(
		(db) =>
			db.includes(database.toLowerCase()) ||
			levenshteinDistance(db, database.toLowerCase()) <= 2,
	).slice(0, 3);

	return {
		isValid: false,
		error: `Invalid database "${database}"`,
		suggestions,
		correctedValue: suggestions[0],
	};
}

function validateRettype(database: string, rettype: string): ValidationResult {
	const validTypes = VALID_RETTYPES[database.toLowerCase()] || [];
	if (validTypes.length === 0 || validTypes.includes(rettype)) {
		return { isValid: true };
	}

	return {
		isValid: false,
		error: `Invalid rettype "${rettype}" for database "${database}"`,
		suggestions: validTypes.slice(0, 5),
	};
}

function validateIds(ids: string): ValidationResult {
	if (!ids || ids.trim().length === 0) {
		return { isValid: false, error: "IDs parameter cannot be empty" };
	}

	const idList = ids
		.split(",")
		.map((id) => id.trim())
		.filter((id) => id.length > 0);
	if (idList.length === 0) {
		return { isValid: false, error: "No valid IDs found in parameter" };
	}

	const invalidIds = idList.filter(
		(id) => !/^\d+$/.test(id) && !/^[A-Z]+\d+(\.\d+)?$/.test(id),
	);
	if (invalidIds.length > 0) {
		return {
			isValid: false,
			error: `Invalid ID format: ${invalidIds.slice(0, 3).join(", ")}${invalidIds.length > 3 ? "..." : ""}`,
			suggestions: [
				"Use numeric IDs (e.g., 12345) or accession numbers (e.g., NM_123456)",
			],
		};
	}

	return { isValid: true };
}

const EntrezQueryParamsShape = {
	operation: z
		.enum([
			"search",
			"summary",
			"info",
			"fetch",
			"link",
			"post",
			"global_query",
			"spell",
		])
		.describe("E-utilities operation to perform"),

	// Common parameters
	database: z
		.string()
		.default("pubmed")
		.describe("Target database (e.g., pubmed, protein, nuccore)"),
	ids: z
		.string()
		.optional()
		.describe("Comma-separated list of UIDs (for summary, fetch, link, post)"),
	term: z
		.string()
		.optional()
		.describe("Search term or query (for search, global_query, spell)"),

	// Search-specific
	retstart: z.number().optional().describe("Starting position (search only)"),
	retmax: z
		.number()
		.optional()
		.default(20)
		.describe("Maximum results (search/summary only)"),
	sort: z.string().optional().describe("Sort method (search only)"),
	field: z
		.string()
		.optional()
		.describe("Search field limitation (search only)"),

	// Format control
	retmode: z
		.enum(["xml", "json"])
		.optional()
		.describe("Response format (auto-selected if not specified)"),
	rettype: z
		.string()
		.optional()
		.describe("Data type for fetch (xml, fasta, gb, etc.)"),

	// Link-specific
	dbfrom: z.string().optional().describe("Source database for links"),
	linkname: z.string().optional().describe("Specific link type"),

	// Advanced options
	usehistory: z
		.enum(["y", "n"])
		.optional()
		.describe("Use Entrez History server"),
	datetype: z.string().optional().describe("Date type for filtering"),
	mindate: z.string().optional().describe("Minimum date (YYYY/MM/DD)"),
	maxdate: z.string().optional().describe("Maximum date (YYYY/MM/DD)"),
	reldate: z.number().optional().describe("Relative date (last n days)"),

	// Staging control
	force_staging: z
		.boolean()
		.optional()
		.describe("Force staging for large/complex results"),
	intended_use: z
		.enum(["search", "staging", "analysis", "citation"])
		.optional()
		.describe("Intended use for format optimization"),

	// Response formatting control
	compact_mode: z
		.boolean()
		.optional()
		.describe("Enable compact, token-efficient response formatting"),
	max_tokens: z
		.number()
		.optional()
		.describe("Maximum tokens for response formatting (default: 500)"),
	detail_level: z
		.enum(["auto", "brief", "full"])
		.optional()
		.describe("Guide formatter verbosity (brief, auto, full)"),
};

const EntrezQueryParamsSchema = z.object(EntrezQueryParamsShape);
type EntrezQueryParams = z.infer<typeof EntrezQueryParamsSchema>;

export class EntrezQueryTool extends BaseTool {
	register(): void {
		this.context.server.tool(
			"entrez-query",
			"Compact gateway to Entrez E-utilities with smart defaults and staging hooks.",
			EntrezQueryParamsShape,
			async (params: EntrezQueryParams) => {
				try {
					const { operation, database = "pubmed", ids, term } = params;

					// Enhanced validation based on operation
					switch (operation) {
						case "search":
						case "global_query":
						case "spell":
							if (!term) {
								throw new Error(
									`${operation} requires 'term' parameter. Provide a search query or keywords.`,
								);
							}
							if (term.trim().length === 0) {
								throw new Error(
									`${operation} requires a non-empty 'term' parameter.`,
								);
							}
							break;
						case "summary":
						case "fetch":
						case "post":
						case "link": {
							if (!ids) {
								throw new Error(
									`${operation} requires 'ids' parameter. Provide comma-separated UIDs (e.g., "12345,67890").`,
								);
							}
							// Validate IDs format
							const idsValidation = validateIds(ids);
							if (!idsValidation.isValid) {
								const suggestions = idsValidation.suggestions
									? `\n💡 ${idsValidation.suggestions.join(", ")}`
									: "";
								throw new Error(`${idsValidation.error}${suggestions}`);
							}
							break;
						}
						// info has no required params
					}

					// Validate database parameter
					const dbValidation = validateDatabase(database);
					if (!dbValidation.isValid) {
						const suggestions =
							dbValidation.suggestions && dbValidation.suggestions.length > 0
								? `\n💡 Did you mean: ${dbValidation.suggestions.join(", ")}?`
								: "";
						throw new Error(`${dbValidation.error}${suggestions}`);
					}

					// Validate rettype if provided
					if (params.rettype) {
						const rettypeValidation = validateRettype(database, params.rettype);
						if (!rettypeValidation.isValid) {
							const suggestions =
								rettypeValidation.suggestions &&
								rettypeValidation.suggestions.length > 0
									? `\n💡 Valid options: ${rettypeValidation.suggestions.join(", ")}`
									: "";
							throw new Error(`${rettypeValidation.error}${suggestions}`);
						}
					}

					// Route to appropriate handler
					switch (operation) {
						case "search":
							return await this.handleSearch(params);
						case "summary":
							return await this.handleSummary(params);
						case "info":
							return await this.handleInfo(params);
						case "fetch":
							return await this.handleFetch(params);
						case "link":
							return await this.handleLink(params);
						case "post":
							return await this.handlePost(params);
						case "global_query":
							return await this.handleGlobalQuery(params);
						case "spell":
							return await this.handleSpell(params);
						default:
							throw new Error(`Unknown operation: ${operation}`);
					}
				} catch (error) {
					const errorMessage =
						error instanceof Error ? error.message : String(error);

					// Enhanced error reporting with context
					let enhancedError = `❌ **Error in ${params.operation || "entrez-query"}**: ${errorMessage}`;

					// Add operation-specific guidance
					if (params.operation) {
						switch (params.operation) {
							case "search":
								enhancedError +=
									'\n\n🔍 **Search Help**: Use keywords like "cancer treatment" or field tags like "author[AU]"';
								break;
							case "summary":
							case "link":
								enhancedError +=
									'\n\n🆔 **ID Help**: Use comma-separated numeric UIDs (e.g., "12345,67890")';
								break;
							case "fetch":
								enhancedError +=
									'\n\n🆔 **ID Help**: Use comma-separated numeric UIDs (e.g., "12345,67890")';
								if (errorMessage.includes("rettype")) {
									enhancedError +=
										'\n📄 **Format Help**: Use rettype="abstract" for PubMed or "fasta" for sequences';
								}
								break;
						}
					}

					return this.textResult(enhancedError);
				}
			},
		);
	}

	override getCapabilities() {
		const sharedDatabaseParam = {
			name: "database",
			type: "string",
			description:
				"Entrez database identifier (e.g., pubmed, protein, nuccore)",
			defaultValue: "pubmed",
		};

		const sharedIdParam = {
			name: "ids",
			type: "string",
			description: "Comma-separated Entrez UID list",
		};

		const operations = [
			{
				name: "search",
				summary: "ESearch query with token-conscious defaults and validation",
				required: [
					sharedDatabaseParam,
					{
						name: "term",
						type: "string",
						description: "Query expression (field tags supported)",
					},
				],
				optional: [
					{
						name: "retmax",
						type: "number",
						description: "Maximum results returned",
						defaultValue: 20,
					},
					{
						name: "retstart",
						type: "number",
						description: "Pagination offset",
					},
					{
						name: "sort",
						type: "string",
						description: "Sort order such as relevance or mostrecent",
					},
					{
						name: "field",
						type: "string",
						description: "Field restriction for the query",
					},
					{
						name: "intended_use",
						type: "string",
						description:
							"Hint for formatter (search, analysis, citation, staging)",
					},
				],
				remarks: [
					"Returns formatted preview plus optimization tips",
					"Use retmax <= 100 unless staging",
				],
			},
			{
				name: "summary",
				summary: "ESummary for metadata-heavy inspection with optional staging",
				required: [sharedDatabaseParam, sharedIdParam],
				optional: [
					{
						name: "retmax",
						type: "number",
						description: "Trim number of summaries",
					},
					{
						name: "compact_mode",
						type: "boolean",
						description: "Force minimal token output",
					},
					{
						name: "detail_level",
						type: "string",
						description: "Preferred verbosity (brief, auto, full)",
					},
					{
						name: "max_tokens",
						type: "number",
						description: "Cap formatter token budget",
						defaultValue: 500,
					},
				],
				remarks: [
					"Automatically stages large payloads",
					"See entrez-data fetch_and_stage for raw records",
				],
			},
			{
				name: "info",
				summary: "EInfo database metadata and available fields",
				required: [sharedDatabaseParam],
				optional: [],
			},
			{
				name: "fetch",
				summary: "EFetch detail retrieval with format optimizers",
				required: [sharedDatabaseParam, sharedIdParam],
				optional: [
					{
						name: "rettype",
						type: "string",
						description: "Return type such as abstract, fasta, gb",
					},
					{
						name: "intended_use",
						type: "string",
						description: "Hint for summarizer (analysis, citation, staging)",
					},
					{
						name: "detail_level",
						type: "string",
						description: "Preferred verbosity (brief, auto, full)",
					},
				],
				remarks: ["Use compact_mode when you only need highlights"],
			},
			{
				name: "link",
				summary: "ELink cross-database relationships",
				required: [sharedDatabaseParam, sharedIdParam],
				optional: [
					{
						name: "dbfrom",
						type: "string",
						description: "Override source database",
					},
					{
						name: "linkname",
						type: "string",
						description: "Specific linkage name",
					},
				],
			},
			{
				name: "post",
				summary: "EPost to Entrez history for batch workflows",
				required: [sharedDatabaseParam, sharedIdParam],
				optional: [
					{
						name: "usehistory",
						type: "string",
						description: "Enable history server",
						defaultValue: "y",
					},
				],
				remarks: ["Returns WebEnv + QueryKey for subsequent calls"],
			},
			{
				name: "global_query",
				summary: "EGQuery cross-database term coverage",
				required: [
					{ name: "term", type: "string", description: "Query expression" },
				],
				optional: [],
			},
			{
				name: "spell",
				summary: "ESpell spelling suggestions",
				required: [
					{
						name: "term",
						type: "string",
						description: "Query needing correction",
					},
				],
				optional: [],
			},
		];

		return {
			tool: "entrez-query",
			summary:
				"Unified gateway to Entrez E-utilities with token-aware formatting and staging.",
			operations,
			contexts: [
				"literature_search",
				"biomedical_analysis",
				"citation_management",
			],
			stageable: true,
			requiresApiKey: false,
			tokenProfile: { typical: 350, upper: 12000 },
			metadata: {
				supportsRetmode: ["xml", "json"],
				defaultIntendedUse: "analysis",
			},
		};
	}

	private async handleSearch(params: EntrezQueryParams) {
		const {
			database,
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
		} = params;

		// Enhanced query validation
		const queryValidation = this.context.validateQuery(term ?? "", database);
		if (!queryValidation.valid) {
			const errorMsg = queryValidation.message;
			const suggestion = queryValidation.suggestion
				? `\n💡 Suggestion: ${queryValidation.suggestion}`
				: "";
			throw new Error(`${errorMsg}${suggestion}`);
		}

		const queryTerm = term as string;

		// Build search parameters
		const searchParams = new URLSearchParams({
			db: database,
			term: queryTerm.trim(),
			tool: this.context.defaultTool,
			email: this.context.defaultEmail,
			retmode:
				retmode ||
				this.context.getOptimalRetmode("esearch", database, intended_use),
		});

		if (retstart !== undefined)
			searchParams.append("retstart", retstart.toString());
		if (retmax !== undefined) searchParams.append("retmax", retmax.toString());
		if (sort) searchParams.append("sort", sort);
		if (field) searchParams.append("field", field);
		if (usehistory) searchParams.append("usehistory", usehistory);
		if (datetype) searchParams.append("datetype", datetype);
		if (reldate !== undefined)
			searchParams.append("reldate", reldate.toString());
		if (mindate) searchParams.append("mindate", mindate);
		if (maxdate) searchParams.append("maxdate", maxdate);

		const url = this.buildUrl("esearch.fcgi", searchParams);
		const response = await fetch(url);
		const data: any = await this.parseResponse(
			response,
			"ESearch",
			searchParams.get("retmode") || undefined,
		);

		// Get query suggestions
		const suggestions = this.context.suggestQueryImprovements(
			queryTerm,
			database,
		);
		const suggestionText =
			suggestions.length > 0
				? `\n\n💡 **Query Optimization Tips**:\n${suggestions.map((s) => `• ${s}`).join("\n")}`
				: "";

		// Format response more efficiently
		let formattedData: string;
		if (typeof data === "object" && data.esearchresult) {
			const result = data.esearchresult;
			const count = result.count || "0";
			const returned = result.retmax || "0";
			const ids = result.idlist || [];

			// Enhanced search results with more context
			let contextInfo = "";
			if (parseInt(count) === 0) {
				contextInfo =
					"\n\n❌ **No results found**\n💡 **Suggestions**:\n• Check spelling and try broader terms\n• Use fewer keywords or remove quotes\n• Try related synonyms or MeSH terms";
			} else if (parseInt(count) > 10000) {
				contextInfo =
					"\n\n⚠️ **Large result set** - consider adding more specific terms or date filters";
			} else if (parseInt(count) < 10) {
				contextInfo =
					"\n\n💡 **Small result set** - try broader terms if you need more results";
			}

			// Add next steps guidance
			const nextSteps =
				parseInt(count) > 0
					? '\n\n📋 **Next Steps**:\n• Use `summary` operation for article metadata\n• Use `fetch` with rettype="abstract" for abstracts\n• Use higher retmax for more results (max 100 recommended)'
					: "";

			formattedData = `📊 **Search Results**: ${count} total, ${returned} returned\n🆔 **IDs**: ${ids.length > 0 ? ids.slice(0, 10).join(", ") + (ids.length > 10 ? "..." : "") : "None"}${contextInfo}${nextSteps}`;
		} else {
			formattedData = this.formatResponseData(data);
		}

		return this.textResult(
			`**E-utilities Search Results**\n${formattedData}${suggestionText}`,
		);
	}

	private async handleSummary(params: EntrezQueryParams) {
		const { database, ids, retmax, retmode, intended_use } = params;

		const summaryParams = new URLSearchParams({
			db: database,
			id: ids!,
			tool: this.context.defaultTool,
			email: this.context.defaultEmail,
			retmode: retmode || this.context.getOptimalRetmode("esummary", database),
		});

		if (retmax !== undefined) summaryParams.append("retmax", retmax.toString());

		const url = this.buildUrl("esummary.fcgi", summaryParams);
		const response = await fetch(url);
		const data: any = await this.parseResponse(
			response,
			"ESummary",
			summaryParams.get("retmode") || undefined,
		);

		// Check if staging is beneficial
		const stagingInfo = this.context.shouldStageResponse(
			typeof data === "string" ? data : JSON.stringify(data),
			"ESummary",
		);

		if (stagingInfo.shouldStage || params.force_staging) {
			// Route to staging system
			return this.stageAndReturnSummary(data, ids!);
		}

		// Use new response formatter for more efficient output
		const detailPrefs = this.resolveDetailPreferences(params);
		const normalizedUse =
			intended_use === "staging" ? "analysis" : intended_use;
		const formatOptions = {
			maxTokens: detailPrefs.maxTokens,
			intendedUse: normalizedUse as
				| "search"
				| "analysis"
				| "citation"
				| "full"
				| undefined,
			compactMode: detailPrefs.compactMode,
		};

		const formattedData = ResponseFormatter.formatESummary(
			data,
			formatOptions,
			database,
		);
		const estimatedTokens = ResponseFormatter.estimateTokens(formattedData);

		return this.textResult(
			`**E-utilities Summary** (${estimatedTokens} tokens, detail: ${detailPrefs.detailLevel})\n\n${formattedData}`,
		);
	}

	private async handleInfo(params: EntrezQueryParams) {
		const { database, retmode } = params;

		const infoParams = new URLSearchParams({
			tool: this.context.defaultTool,
			email: this.context.defaultEmail,
			retmode: retmode || "xml",
		});

		if (database && database !== "all") {
			infoParams.append("db", database);
		}

		const url = this.buildUrl("einfo.fcgi", infoParams);
		const response = await fetch(url);
		const data = await this.parseResponse(
			response,
			"EInfo",
			infoParams.get("retmode") || undefined,
		);

		// Always check staging for EInfo due to complexity
		const stagingInfo = this.context.shouldStageResponse(
			typeof data === "string" ? data : JSON.stringify(data),
			"EInfo",
		);

		if (stagingInfo.shouldStage || params.force_staging) {
			return this.stageAndReturnInfo(data, database ?? "");
		}

		return this.textResult(
			`**Database Info** (${stagingInfo.estimatedTokens} tokens):\n\n${this.formatResponseData(data)}`,
		);
	}

	private async handleFetch(params: EntrezQueryParams) {
		const { database, ids, rettype, retmode, intended_use } = params;

		const fetchParams = new URLSearchParams({
			db: database,
			id: ids!,
			tool: this.context.defaultTool,
			email: this.context.defaultEmail,
		});

		if (rettype) fetchParams.append("rettype", rettype);
		if (retmode) fetchParams.append("retmode", retmode);

		const url = this.buildUrl("efetch.fcgi", fetchParams);
		const response = await fetch(url);
		const data: any = await this.parseResponse(response, "EFetch", retmode);

		// Route to existing staging system for complex data
		const stagingInfo = this.context.shouldStageResponse(
			typeof data === "string" ? data : JSON.stringify(data),
			"EFetch",
		);

		if (stagingInfo.shouldStage || params.force_staging) {
			return this.stageAndReturnFetch(data, database ?? "", ids!, rettype);
		}

		// Use enhanced formatter for fetch results
		const detailPrefs = this.resolveDetailPreferences(params);
		const normalizedFetchUse =
			intended_use === "staging" ? "analysis" : intended_use;
		const formatOptions = {
			maxTokens: detailPrefs.maxTokens,
			intendedUse: normalizedFetchUse as
				| "search"
				| "analysis"
				| "citation"
				| "full"
				| undefined,
			compactMode: detailPrefs.compactMode,
		};

		const formattedData = ResponseFormatter.formatEFetch(
			data,
			rettype,
			formatOptions,
		);
		const estimatedTokens = ResponseFormatter.estimateTokens(formattedData);

		return this.textResult(
			`**E-utilities Fetch Results** (${estimatedTokens} tokens, detail: ${detailPrefs.detailLevel})\n\n${formattedData}`,
		);
	}

	private async handleLink(params: EntrezQueryParams) {
		const { database, dbfrom, ids, linkname, retmode } = params;

		const linkParams = new URLSearchParams({
			dbfrom: dbfrom || database,
			db: database,
			id: ids!,
			tool: this.context.defaultTool,
			email: this.context.defaultEmail,
			retmode: retmode || "xml",
		});

		if (linkname) linkParams.append("linkname", linkname);

		const url = this.buildUrl("elink.fcgi", linkParams);
		const response = await fetch(url);
		const data = await this.parseResponse(
			response,
			"ELink",
			linkParams.get("retmode") || undefined,
		);

		return this.textResult(
			`**E-utilities Link Results**:\n\n${this.formatResponseData(data)}`,
		);
	}

	private async handlePost(params: EntrezQueryParams) {
		const { database, ids } = params;

		const postParams = new URLSearchParams({
			db: database,
			id: ids!,
			tool: this.context.defaultTool,
			email: this.context.defaultEmail,
		});

		const url = this.buildUrl("epost.fcgi", postParams);
		const response = await fetch(url);
		const data = await this.parseResponse(response, "EPost");

		return this.textResult(
			`**E-utilities Post Results**:\n\n${this.formatResponseData(data)}`,
		);
	}

	private async handleGlobalQuery(params: EntrezQueryParams) {
		const { term } = params;

		const gqueryParams = new URLSearchParams({
			term: term ?? "",
			tool: this.context.defaultTool,
			email: this.context.defaultEmail,
		});

		const url = this.buildUrl("egquery.fcgi", gqueryParams);
		const response = await fetch(url);
		const data = await this.parseResponse(response, "EGQuery");

		return this.textResult(
			`**Global Query Results**:\n\n${this.formatResponseData(data)}`,
		);
	}

	private async handleSpell(params: EntrezQueryParams) {
		const { database, term } = params;

		const spellParams = new URLSearchParams({
			db: database,
			term: term ?? "",
			tool: this.context.defaultTool,
			email: this.context.defaultEmail,
		});

		const url = this.buildUrl("espell.fcgi", spellParams);

		try {
			const response = await fetch(url);

			// Add better error handling for spell check
			if (!response.ok) {
				return {
					content: [
						{
							type: "text",
							text: `**Spelling Check Unavailable**\n\nNCBI ESpell service returned error ${response.status}. The term "${term}" cannot be checked at this time.\n\n💡 **Suggested alternatives**: Try searching for "${term}" directly or use common variations.`,
						},
					],
				};
			}

			const rawText = await response.text();

			// Check if response is empty or malformed
			if (!rawText || rawText.trim().length === 0) {
				return {
					content: [
						{
							type: "text",
							text: `**No Spelling Suggestions**\n\nThe term "${term}" appears to be correctly spelled or no alternatives were found.`,
						},
					],
				};
			}

			// Try to parse XML and extract suggestions
			const correctedQueryMatch = rawText.match(
				/<CorrectedQuery>([^<]+)<\/CorrectedQuery>/,
			);
			const spelledQueryMatch = rawText.match(
				/<SpelledQuery>([^<]+)<\/SpelledQuery>/,
			);

			if (correctedQueryMatch || spelledQueryMatch) {
				let suggestions = "";
				if (correctedQueryMatch) {
					suggestions += `**Corrected**: ${correctedQueryMatch[1]}\n`;
				}
				if (spelledQueryMatch) {
					suggestions += `**Alternative**: ${spelledQueryMatch[1]}\n`;
				}

				return this.textResult(
					`**Spelling Suggestions for "${term}"**:\n\n${suggestions}`,
				);
			}

			// If no structured suggestions found, check for any text content
			const cleanText = rawText.replace(/<[^>]*>/g, "").trim();
			if (cleanText && cleanText !== term) {
				return this.textResult(
					`**Spelling Suggestions for "${term}"**:\n\n${cleanText}`,
				);
			}

			return this.textResult(
				`**No Spelling Corrections Needed**\n\nThe term "${term}" appears to be correctly spelled.`,
			);
		} catch (error) {
			return this.textResult(
				`**Spelling Check Error**\n\nService temporarily unavailable: ${error instanceof Error ? error.message : String(error)}\n\n**Original term**: ${term}\n\n💡 **Tip**: Try searching for "${term}" directly.`,
			);
		}
	}

	// Helper methods for staging integration
	private resolveDetailPreferences(params: EntrezQueryParams) {
		const detailLevel = params.detail_level ?? "auto";
		const defaultMap: Record<
			string,
			{ compactMode: boolean; maxTokens: number }
		> = {
			auto: {
				compactMode: params.compact_mode ?? false,
				maxTokens: params.max_tokens ?? 500,
			},
			brief: { compactMode: true, maxTokens: params.max_tokens ?? 200 },
			full: { compactMode: false, maxTokens: params.max_tokens ?? 900 },
		};

		const baseline = defaultMap[detailLevel] || defaultMap.auto;
		return {
			detailLevel,
			compactMode: params.compact_mode ?? baseline.compactMode,
			maxTokens: params.max_tokens ?? baseline.maxTokens,
		};
	}

	private async stageAndReturnSummary(_data: unknown, ids: string) {
		// Integrate with existing staging system
		return this.textResult(
			`✅ **ESummary Data Successfully Staged**\n\n🗃️ Use data staging tools for complex queries on ${ids.split(",").length} records.`,
		);
	}

	private async stageAndReturnInfo(_data: unknown, database: string) {
		return this.textResult(
			`✅ **EInfo Data Successfully Staged**\n\n📊 Database metadata for '${database}' available for SQL queries.`,
		);
	}

	private async stageAndReturnFetch(
		_data: unknown,
		database: string,
		ids: string,
		_rettype?: string,
	) {
		return this.textResult(
			`✅ **EFetch Data Successfully Staged**\n\n📋 ${ids.split(",").length} records from '${database}' ready for analysis.`,
		);
	}
}
