import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
	isValidDatabase,
	parseResponse,
	buildUrl,
	createBaseParams,
} from "../utils/helpers";

export function registerEutilsTools(server: McpServer, apiKey?: string) {
	// EInfo - Get metadata about an Entrez database
	server.tool(
		"einfo",
		{
			db: z
				.string()
				.optional()
				.describe(
					"Database name (optional). If not provided, returns list of all databases",
				),
			version: z
				.string()
				.optional()
				.describe("Version 2.0 for enhanced XML output"),
			retmode: z
				.enum(["xml", "json"])
				.optional()
				.default("xml")
				.describe("Output format"),
		},
		async ({ db, version, retmode }) => {
			try {
				// Validate database if provided
				if (db && !isValidDatabase(db)) {
					throw new Error(`Invalid database name: ${db}`);
				}

				const params = createBaseParams(retmode);

				if (db) params.append("db", db);
				if (version) params.append("version", version);

				const url = buildUrl("einfo.fcgi", params, apiKey);
				const response = await fetch(url);
				const data = await parseResponse(response, "EInfo");

				return {
					content: [
						{
							type: "text",
							text: `EInfo Results:\n\n${data}`,
						},
					],
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: `Error in EInfo: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
				};
			}
		},
	);

	// ESearch - Run a text or UID-based query
	server.tool(
		"esearch",
		{
			db: z.string().default("pubmed").describe("Database to search"),
			term: z.string().describe("Entrez text query"),
			retstart: z.number().optional().describe("Starting position (0-based)"),
			retmax: z
				.number()
				.optional()
				.default(20)
				.describe("Maximum number of UIDs to retrieve"),
			sort: z
				.string()
				.optional()
				.describe("Sort method (e.g., 'relevance', 'pub_date')"),
			field: z.string().optional().describe("Search field limitation"),
			usehistory: z
				.enum(["y", "n"])
				.optional()
				.describe("Use Entrez History server"),
			datetype: z.string().optional().describe("Date type for date filtering"),
			reldate: z.number().optional().describe("Relative date (last n days)"),
			mindate: z.string().optional().describe("Minimum date (YYYY/MM/DD)"),
			maxdate: z.string().optional().describe("Maximum date (YYYY/MM/DD)"),
			retmode: z
				.enum(["xml", "json"])
				.optional()
				.default("xml")
				.describe("Output format"),
		},
		async ({
			db,
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
		}) => {
			try {
				// Validate inputs
				if (!term || term.trim() === "") {
					throw new Error("Search term cannot be empty");
				}
				if (db && !isValidDatabase(db)) {
					throw new Error(`Invalid database name: ${db}`);
				}
				if (retmax !== undefined && (retmax < 0 || retmax > 100000)) {
					throw new Error("retmax must be between 0 and 100000");
				}
				if (retstart !== undefined && retstart < 0) {
					throw new Error("retstart must be non-negative");
				}

				const params = createBaseParams(retmode);
				params.append("db", db || "pubmed");
				params.append("term", term.trim());

				if (retstart !== undefined)
					params.append("retstart", retstart.toString());
				if (retmax !== undefined) params.append("retmax", retmax.toString());
				if (sort) params.append("sort", sort);
				if (field) params.append("field", field);
				if (usehistory) params.append("usehistory", usehistory);
				if (datetype) params.append("datetype", datetype);
				if (reldate !== undefined) params.append("reldate", reldate.toString());
				if (mindate) params.append("mindate", mindate);
				if (maxdate) params.append("maxdate", maxdate);

				const url = buildUrl("esearch.fcgi", params, apiKey);
				const response = await fetch(url);
				const data = await parseResponse(response, "ESearch");

				return {
					content: [
						{
							type: "text",
							text: `ESearch Results:\n\n${data}`,
						},
					],
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: `Error in ESearch: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
				};
			}
		},
	);

	// ESummary - Retrieve concise document summaries for UIDs
	server.tool(
		"esummary",
		{
			db: z.string().default("pubmed").describe("Database name"),
			id: z.string().describe("Comma-separated list of UIDs"),
			retstart: z.number().optional().describe("Starting position"),
			retmax: z.number().optional().describe("Maximum number of summaries"),
			version: z.string().optional().describe("Version 2.0 for enhanced XML"),
			retmode: z
				.enum(["xml", "json"])
				.optional()
				.default("xml")
				.describe("Output format"),
		},
		async ({ db, id, retstart, retmax, version, retmode }) => {
			try {
				// Validate inputs
				if (!id || id.trim() === "") {
					throw new Error("ID parameter cannot be empty");
				}
				if (db && !isValidDatabase(db)) {
					throw new Error(`Invalid database name: ${db}`);
				}

				// Clean and validate IDs
				const cleanIds = id
					.split(",")
					.map((i) => i.trim())
					.filter((i) => i !== "");
				if (cleanIds.length === 0) {
					throw new Error("No valid IDs provided");
				}
				if (cleanIds.length > 200) {
					throw new Error("Too many IDs provided (maximum 200)");
				}

				const params = createBaseParams(retmode);
				params.append("db", db || "pubmed");
				params.append("id", cleanIds.join(","));

				if (retstart !== undefined)
					params.append("retstart", retstart.toString());
				if (retmax !== undefined) params.append("retmax", retmax.toString());
				if (version) params.append("version", version);

				const url = buildUrl("esummary.fcgi", params, apiKey);
				const response = await fetch(url);
				const data = await parseResponse(response, "ESummary");

				return {
					content: [
						{
							type: "text",
							text: `ESummary Results:\n\n${data}`,
						},
					],
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: `Error in ESummary: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
				};
			}
		},
	);

	// EFetch - Download complete data records
	server.tool(
		"efetch",
		{
			db: z.string().default("pubmed").describe("Database name"),
			id: z.string().describe("Comma-separated list of UIDs"),
			rettype: z
				.string()
				.optional()
				.describe("Retrieval type (e.g., 'abstract', 'fasta', 'gb')"),
			retmode: z
				.string()
				.optional()
				.describe("Retrieval mode (e.g., 'text', 'xml')"),
			retstart: z.number().optional().describe("Starting position"),
			retmax: z.number().optional().describe("Maximum number of records"),
			strand: z
				.enum(["1", "2"])
				.optional()
				.describe("DNA strand (1=plus, 2=minus)"),
			seq_start: z
				.number()
				.optional()
				.describe("First sequence base to retrieve"),
			seq_stop: z
				.number()
				.optional()
				.describe("Last sequence base to retrieve"),
			complexity: z
				.enum(["0", "1", "2", "3", "4"])
				.optional()
				.describe("Data complexity level"),
		},
		async ({
			db,
			id,
			rettype,
			retmode,
			retstart,
			retmax,
			strand,
			seq_start,
			seq_stop,
			complexity,
		}) => {
			try {
				// Validate inputs
				if (!id || id.trim() === "") {
					throw new Error("ID parameter cannot be empty");
				}
				if (db && !isValidDatabase(db)) {
					throw new Error(`Invalid database name: ${db}`);
				}

				// Clean and validate IDs
				const cleanIds = id
					.split(",")
					.map((i) => i.trim())
					.filter((i) => i !== "");
				if (cleanIds.length === 0) {
					throw new Error("No valid IDs provided");
				}

				// Database-specific validation
				const dbName = db || "pubmed";
				if (
					dbName === "pubmed" &&
					(rettype === "fasta" || seq_start || seq_stop)
				) {
					throw new Error(
						"FASTA format and sequence parameters not supported for PubMed database",
					);
				}
				if (
					(dbName === "protein" || dbName === "nuccore") &&
					rettype === "abstract"
				) {
					throw new Error(
						"Abstract format not supported for sequence databases",
					);
				}

				const params = createBaseParams();
				params.append("db", dbName);
				params.append("id", cleanIds.join(","));

				// Add optional parameters with validation
				if (rettype) {
					// Validate rettype for specific databases
					const validRetTypes: Record<string, string[]> = {
						pubmed: ["abstract", "medline", "xml"],
						pmc: ["medline", "xml"],
						protein: ["fasta", "gb", "gp", "xml"],
						nuccore: ["fasta", "gb", "xml"],
						nucleotide: ["fasta", "gb", "xml"],
					};

					if (
						validRetTypes[dbName] &&
						!validRetTypes[dbName].includes(rettype)
					) {
						throw new Error(
							`Invalid rettype '${rettype}' for database '${dbName}'. Valid types: ${validRetTypes[dbName].join(", ")}`,
						);
					}
					params.append("rettype", rettype);
				}

				if (retmode) params.append("retmode", retmode);
				if (retstart !== undefined)
					params.append("retstart", retstart.toString());
				if (retmax !== undefined) params.append("retmax", retmax.toString());

				// Sequence-specific parameters (only for sequence databases)
				if (
					dbName === "protein" ||
					dbName === "nuccore" ||
					dbName === "nucleotide"
				) {
					if (strand) params.append("strand", strand);
					if (seq_start !== undefined)
						params.append("seq_start", seq_start.toString());
					if (seq_stop !== undefined)
						params.append("seq_stop", seq_stop.toString());
					if (complexity) params.append("complexity", complexity);
				}

				const url = buildUrl("efetch.fcgi", params, apiKey);
				const response = await fetch(url);
				const data = await parseResponse(response, "EFetch");

				return {
					content: [
						{
							type: "text",
							text: `EFetch Results:\n\n${data}`,
						},
					],
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: `Error in EFetch: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
				};
			}
		},
	);

	// ELink - Find UIDs linked/related within same or different databases
	server.tool(
		"elink",
		{
			db: z.string().default("pubmed").describe("Target database"),
			dbfrom: z.string().default("pubmed").describe("Source database"),
			id: z.string().describe("Comma-separated list of UIDs"),
			cmd: z
				.enum([
					"neighbor",
					"neighbor_score",
					"neighbor_history",
					"acheck",
					"ncheck",
					"lcheck",
					"llinks",
					"llinkslib",
					"prlinks",
				])
				.optional()
				.default("neighbor")
				.describe("ELink command mode"),
			linkname: z
				.string()
				.optional()
				.describe("Specific link name to retrieve"),
			term: z.string().optional().describe("Entrez query to limit output"),
			holding: z.string().optional().describe("LinkOut provider name"),
			datetype: z.string().optional().describe("Date type for filtering"),
			reldate: z.number().optional().describe("Relative date (last n days)"),
			mindate: z.string().optional().describe("Minimum date (YYYY/MM/DD)"),
			maxdate: z.string().optional().describe("Maximum date (YYYY/MM/DD)"),
			retmode: z
				.enum(["xml", "json", "ref"])
				.optional()
				.default("xml")
				.describe("Output format"),
		},
		async ({
			db,
			dbfrom,
			id,
			cmd,
			linkname,
			term,
			holding,
			datetype,
			reldate,
			mindate,
			maxdate,
			retmode,
		}) => {
			try {
				// Validate inputs
				if (!id || id.trim() === "") {
					throw new Error("ID parameter cannot be empty");
				}
				if (db && !isValidDatabase(db)) {
					throw new Error(`Invalid target database name: ${db}`);
				}
				if (dbfrom && !isValidDatabase(dbfrom)) {
					throw new Error(`Invalid source database name: ${dbfrom}`);
				}

				// Clean and validate IDs
				const cleanIds = id
					.split(",")
					.map((i) => i.trim())
					.filter((i) => i !== "" && !isNaN(Number(i)));
				if (cleanIds.length === 0) {
					throw new Error("No valid numeric IDs provided");
				}

				const params = createBaseParams(retmode);
				params.append("db", db || "pubmed");
				params.append("dbfrom", dbfrom || "pubmed");
				params.append("id", cleanIds.join(","));

				if (cmd) params.append("cmd", cmd);
				if (linkname) params.append("linkname", linkname);
				if (term) params.append("term", term);
				if (holding) params.append("holding", holding);
				if (datetype) params.append("datetype", datetype);
				if (reldate !== undefined) params.append("reldate", reldate.toString());
				if (mindate) params.append("mindate", mindate);
				if (maxdate) params.append("maxdate", maxdate);

				const url = buildUrl("elink.fcgi", params, apiKey);
				const response = await fetch(url);
				const data = await parseResponse(response, "ELink");

				return {
					content: [
						{
							type: "text",
							text: `ELink Results:\n\n${data}`,
						},
					],
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: `Error in ELink: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
				};
			}
		},
	);

	// EPost - Upload UIDs to Entrez History for later use
	server.tool(
		"epost",
		{
			db: z.string().default("pubmed").describe("Database name"),
			id: z.string().describe("Comma-separated list of UIDs to upload"),
			WebEnv: z
				.string()
				.optional()
				.describe("Existing Web Environment to append to"),
		},
		async ({ db, id, WebEnv }) => {
			try {
				// Validate inputs
				if (!id || id.trim() === "") {
					throw new Error("ID parameter cannot be empty");
				}
				if (db && !isValidDatabase(db)) {
					throw new Error(`Invalid database name: ${db}`);
				}

				// Clean and validate IDs
				const cleanIds = id
					.split(",")
					.map((i) => i.trim())
					.filter((i) => i !== "" && !isNaN(Number(i)));
				if (cleanIds.length === 0) {
					throw new Error("No valid numeric IDs provided");
				}

				const params = createBaseParams();
				params.append("db", db || "pubmed");
				params.append("id", cleanIds.join(","));

				if (WebEnv) params.append("WebEnv", WebEnv);

				const url = buildUrl("epost.fcgi", params, apiKey);
				const response = await fetch(url);
				const data = await parseResponse(response, "EPost");

				return {
					content: [
						{
							type: "text",
							text: `EPost Results:\n\n${data}`,
						},
					],
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: `Error in EPost: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
				};
			}
		},
	);

	// EGQuery - Run a global query across all Entrez databases
	server.tool(
		"egquery",
		{
			term: z
				.string()
				.describe("Entrez text query to search across all databases"),
		},
		async ({ term }) => {
			try {
				// Validate input
				if (!term || term.trim() === "") {
					throw new Error("Search term cannot be empty");
				}

				// Clean and prepare the term - egquery is very sensitive to formatting
				const cleanTerm = term.trim().replace(/\s+/g, " ");

				// Try multiple parameter combinations as egquery is notoriously finicky
				const paramSets = [
					// Standard approach with retmode
					createBaseParams("xml").set("term", cleanTerm),
					// Alternative with simpler parameters
					createBaseParams().set("term", cleanTerm),
					// Try with URL encoding
					createBaseParams("xml").set("term", encodeURIComponent(cleanTerm)),
				];

				let diagnosticInfo = `EGQuery Diagnostic Information:\n`;
				diagnosticInfo += `Original term: "${term}"\n`;
				diagnosticInfo += `Cleaned term: "${cleanTerm}"\n`;
				diagnosticInfo += `Attempting ${paramSets.length} different parameter combinations...\n\n`;

				for (let paramIndex = 0; paramIndex < paramSets.length; paramIndex++) {
					const params = paramSets[paramIndex];
					// Use direct URL construction for gquery since it's not under eutils path
					const gqueryUrl = `https://eutils.ncbi.nlm.nih.gov/gquery?${params}`;
					const url = gqueryUrl;

					diagnosticInfo += `Attempt ${paramIndex + 1}: ${url}\n`;

					// Try with retries for each parameter set
					for (let attempt = 1; attempt <= 2; attempt++) {
						try {
							const response = await fetch(url, {
								method: "GET",
								headers: {
									"User-Agent": "entrez-mcp-server/1.0.0",
									Accept: "text/xml, application/xml, text/plain, */*",
								},
							});

							diagnosticInfo += `Response status: ${response.status} ${response.statusText}\n`;
							diagnosticInfo += `Response headers: ${JSON.stringify(Object.fromEntries(response.headers.entries()))}\n`;

							if (!response.ok) {
								const errorText = await response.text();
								diagnosticInfo += `Error response body: ${errorText.substring(0, 500)}...\n`;
								throw new Error(
									`HTTP ${response.status}: ${errorText.substring(0, 200)}`,
								);
							}

							const data = await response.text();
							diagnosticInfo += `Response length: ${data.length} characters\n`;

							// Enhanced error detection for egquery
							if (
								data.includes("<ERROR>") ||
								data.includes('"ERROR"') ||
								data.includes("error") ||
								data.includes("Error") ||
								data.includes("internal error") ||
								data.includes("reference =")
							) {
								const errorMatch =
									data.match(/<ERROR>(.*?)<\/ERROR>/) ||
									data.match(/"ERROR":"([^"]*)"/) ||
									data.match(/error['":]?\s*([^"',}\n]*)/i) ||
									data.match(/reference\s*=\s*([^\s,}\n]*)/i);

								if (errorMatch) {
									diagnosticInfo += `NCBI Error detected: ${errorMatch[0]}\n`;
									throw new Error(
										`NCBI EGQuery error: ${errorMatch[1] || errorMatch[0]}`,
									);
								} else {
									diagnosticInfo += `Generic error detected in response\n`;
									throw new Error(
										`NCBI EGQuery error: ${data.substring(0, 200)}`,
									);
								}
							}

							// Check for valid egquery response structure
							if (
								!data.includes("<eGQueryResult>") &&
								!data.includes('"Result"') &&
								!data.includes("Result") &&
								data.length < 50
							) {
								diagnosticInfo += `Response appears invalid or too short\n`;
								throw new Error("Invalid or empty response from EGQuery");
							}

							// Success!
							diagnosticInfo += `SUCCESS: Valid response received\n`;
							return {
								content: [
									{
										type: "text",
										text: `EGQuery Results:\n\n${data}\n\n--- Debug Info ---\n${diagnosticInfo}`,
									},
								],
							};
						} catch (error) {
							diagnosticInfo += `Attempt ${attempt} failed: ${error instanceof Error ? error.message : String(error)}\n`;
							if (attempt < 2) {
								diagnosticInfo += `Waiting before retry...\n`;
								await new Promise((resolve) =>
									setTimeout(resolve, 1500 * attempt),
								);
							}
						}
					}
					diagnosticInfo += `Parameter set ${paramIndex + 1} failed after all retries\n\n`;
				}

				// If all attempts failed, try a fallback approach using esearch on each database
				diagnosticInfo += `All direct egquery attempts failed. Attempting fallback approach...\n`;

				try {
					const majorDatabases = [
						"pubmed",
						"pmc",
						"protein",
						"nuccore",
						"gene",
					];
					const fallbackResults = [];

					for (const db of majorDatabases) {
						try {
							const searchParams = createBaseParams("json");
							searchParams.append("db", db);
							searchParams.append("term", cleanTerm);
							searchParams.append("retmax", "0"); // Just get counts

							const searchUrl = buildUrl("esearch.fcgi", searchParams, apiKey);
							const searchResponse = await fetch(searchUrl);

							if (searchResponse.ok) {
								const searchData = await searchResponse.text();
								const countMatch =
									searchData.match(/"count":"(\d+)"/) ||
									searchData.match(/<Count>(\d+)<\/Count>/);
								const count = countMatch ? countMatch[1] : "0";
								fallbackResults.push(`${db}: ${count} results`);
							}
						} catch (dbError) {
							fallbackResults.push(`${db}: error`);
						}
					}

					if (fallbackResults.length > 0) {
						diagnosticInfo += `Fallback results obtained\n`;
						return {
							content: [
								{
									type: "text",
									text: `EGQuery Results (via fallback method):\n\nCross-database search counts for "${cleanTerm}":\n${fallbackResults.join("\n")}\n\nNote: EGQuery service unavailable, results obtained via individual database searches.\n\n--- Debug Info ---\n${diagnosticInfo}`,
								},
							],
						};
					}
				} catch (fallbackError) {
					diagnosticInfo += `Fallback approach also failed: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}\n`;
				}

				// Complete failure
				throw new Error(
					`All EGQuery approaches failed. NCBI EGQuery service may be experiencing issues.`,
				);
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: `Error in EGQuery: ${error instanceof Error ? error.message : String(error)}\n\nThis appears to be an ongoing issue with NCBI's EGQuery service. The service is known to be unstable and frequently returns internal server errors.\n\nWorkaround: Use individual database searches with esearch for each database of interest.`,
						},
					],
				};
			}
		},
	);

	// ESpell - Return spelling suggestions for search terms
	server.tool(
		"espell",
		{
			db: z.string().default("pubmed").describe("Database name"),
			term: z.string().describe("Text query to get spelling suggestions for"),
		},
		async ({ db, term }) => {
			try {
				// Validate inputs
				if (!term || term.trim() === "") {
					throw new Error("Search term cannot be empty");
				}
				if (db && !isValidDatabase(db)) {
					throw new Error(`Invalid database name: ${db}`);
				}

				const params = createBaseParams();
				params.append("db", db || "pubmed");
				params.append("term", term.trim());

				const url = buildUrl("espell.fcgi", params, apiKey);
				const response = await fetch(url);
				const data = await parseResponse(response, "ESpell");

				return {
					content: [
						{
							type: "text",
							text: `ESpell Results:\n\n${data}`,
						},
					],
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: `Error in ESpell: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
				};
			}
		},
	);
}
