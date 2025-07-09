import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import JSZip from "jszip";
import { JsonToSqlDO } from "./do.js";
import { getParserFor } from "./lib/parsers.js";

// Define our MCP agent for NCBI Entrez E-utilities
export class EntrezMCP extends McpAgent {
	server = new McpServer({
		name: "Complete NCBI APIs MCP Server",
		version: "1.0.0",
		description: "A comprehensive MCP server for E-utilities, BLAST, PubChem, and PMC, with advanced data staging capabilities.",
	});

	private baseUrl = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/";
	private defaultEmail = "entrez-mcp-server@example.com";
	private defaultTool = "entrez-mcp-server";

	// Optional Entrez API key - accessed from environment via method
	private getApiKey(): string | undefined {
		// In Cloudflare Workers, we need to access env through the context
		// This will be set via a static property during request handling
		return EntrezMCP.currentEnv?.NCBI_API_KEY;
	}

	// Static property to hold the current environment during request processing
	public static currentEnv: Env | undefined;

	// Helper method to get API key status for user feedback
	private getApiKeyStatus(): { hasKey: boolean; message: string; rateLimit: string } {
		const apiKey = this.getApiKey();
		if (apiKey) {
			return {
				hasKey: true,
				message: `✅ NCBI API Key configured (${apiKey.substring(0, 8)}...)`,
				rateLimit: "10 requests/second"
			};
		} else {
			return {
				hasKey: false,
				message: "⚠️  No NCBI API Key found - using default rate limits",
				rateLimit: "3 requests/second"
			};
		}
	}

	// Helper method to validate database names
	private isValidDatabase(db: string): boolean {
		// Valid databases list sourced from current EInfo endpoint (2025-06)
		const validDbs = [
			"pubmed", "pmc", "protein", "nuccore", "ipg", "nucleotide", "structure", "genome",
			"annotinfo", "assembly", "bioproject", "biosample", "blastdbinfo", "books", "cdd",
			"clinvar", "gap", "gapplus", "grasp", "dbvar", "gene", "gds", "geoprofiles", "medgen",
			"mesh", "nlmcatalog", "omim", "orgtrack", "proteinclusters", "pcassay", "protfam",
			"pccompound", "pcsubstance", "seqannot", "snp", "sra", "taxonomy", "biocollections", "gtr",
			// Additional databases observed via EInfo but previously missing
			"pubmedhealth", "nucgss", "nucest", "biosystems", "unigene", "popset", "probe"
		];
		return validDbs.includes(db.toLowerCase());
	}

	// Helper method to parse and validate response
	private async parseResponse(response: Response, toolName: string): Promise<string | any> {
		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(`${toolName} request failed: ${response.status} ${response.statusText}. Response: ${errorText}`);
		}

		// For BLAST results, check if the response is compressed
		if (toolName.includes("BLAST Get")) {
			const contentType = response.headers.get('content-type') || '';
			const contentEncoding = response.headers.get('content-encoding') || '';
			
			// If it's a ZIP file or compressed content, try to extract readable data
			if (contentType.includes('application/zip') || contentType.includes('application/x-zip') || 
				response.headers.get('content-disposition')?.includes('.zip') ||
				contentEncoding.includes('gzip') || contentEncoding.includes('deflate')) {
				
				const arrayBuffer = await response.arrayBuffer();

				// Handle gzip/deflate first
				if (contentEncoding === 'gzip' || contentEncoding === 'deflate') {
					const decompressionStream = new DecompressionStream(contentEncoding);
					const decompressedStream = new Response(arrayBuffer).body!.pipeThrough(decompressionStream);
					return await new Response(decompressedStream).text();
				}

				// Check for ZIP file signature ('PK') and handle it
				const firstBytes = new Uint8Array(arrayBuffer.slice(0, 4));
				if (firstBytes[0] === 0x50 && firstBytes[1] === 0x4B) { // ZIP file signature
					try {
						const zip = await JSZip.loadAsync(arrayBuffer);
						const fileNames = Object.keys(zip.files);
						if (fileNames.length > 0) {
							// Find the primary XML file, often with an XInclude
							const primaryXmlFile = fileNames.find(name => name.endsWith('.xml') && !name.includes('_'));
							const primaryFile = primaryXmlFile ? zip.file(primaryXmlFile) : zip.file(fileNames[0]);
							
							if (primaryFile) {
								const primaryContent = await primaryFile.async("string");
								
								// Check for XInclude and resolve it
								const includeMatch = primaryContent.match(/<xi:include\s+href="([^"]+)"/);
								if (includeMatch && includeMatch[1]) {
									const includedFileName = includeMatch[1];
									const includedFile = zip.file(includedFileName);
									if (includedFile) {
										return await includedFile.async("string"); // Return the content of the included file
									} else {
										throw new Error(`XInclude file '${includedFileName}' not found in the BLAST archive.`);
									}
								}
								
								return primaryContent; // Return primary content if no include found
							}
						}
						throw new Error("ZIP archive from BLAST was empty.");
					} catch (zipError) {
						throw new Error(`Failed to decompress BLAST result archive: ${zipError instanceof Error ? zipError.message : String(zipError)}`);
					}
				}
			}
		}

		const data = await response.text();
		
		// Skip error checking for BLAST and PMC tools as they have different response formats
		if (toolName.includes("BLAST") || toolName.includes("PMC") || toolName.includes("PubChem")) {
			return data;
		}
		
		// Try parsing as JSON for modern API responses
		if (toolName.includes("JSON") || response.headers.get('content-type')?.includes('application/json')) {
			try {
				return JSON.parse(data);
			} catch {
				// Fall through to text processing
			}
		}
		
		// Check for common NCBI error patterns (only for E-utilities tools). Perform case-insensitive scan.
		const lowerData = data.toLowerCase();
		if (lowerData.includes("<error>") || lowerData.includes('"error"') || lowerData.includes("error")) {
			// Capture NCBI error messages accurately
			const errorMatch =
				// Match XML error tags like <Error> or <ERROR>
				data.match(/<Error[^>]*>([\s\S]*?)<\/Error>/i) ||
				data.match(/<ERROR[^>]*>([\s\S]*?)<\/ERROR>/i) ||
				// Match JSON style "ERROR":"message"
				data.match(/"ERROR"\s*:\s*"([^"]*)"/i) ||
				// Generic 'error' text in plain responses
				data.match(/error['":]?\s*([^"',}\n]*)/i);
			if (errorMatch) {
				throw new Error(`NCBI ${toolName} error: ${errorMatch[1]}`);
			}
		}

		return data;
	}

	// Helper method to build URL with validation
	private buildUrl(endpoint: string, params: URLSearchParams): string {
		// Remove empty parameters
		const cleanParams = new URLSearchParams();
		params.forEach((value, key) => {
			if (value && value.trim() !== '') {
				cleanParams.append(key, value.trim());
			}
		});
		// Automatically attach API key if available
		const apiKey = this.getApiKey();
		if (apiKey) {
			cleanParams.append("api_key", apiKey);
		}
		return `${this.baseUrl}${endpoint}?${cleanParams}`;
	}

	async init() {
		// API Key Status - Check NCBI API key configuration and rate limits
		this.server.tool(
			"api_key_status",
			{},
			async () => {
				const status = this.getApiKeyStatus();
				
				const helpMessage = status.hasKey 
					? `Your NCBI API key is properly configured and active! You can make up to ${status.rateLimit}.`
					: `No API key configured. You're limited to ${status.rateLimit}. 

To get 3x better performance:
1. Get your free API key: https://ncbiinsights.ncbi.nlm.nih.gov/2017/11/02/new-api-keys-for-the-e-utilities/
2. Set environment variable: NCBI_API_KEY="your_key_here"
3. Restart the server
4. Run this tool again to verify

See API_KEY_SETUP.md for detailed instructions.`;

				return {
					content: [
						{
							type: "text",
							text: `NCBI API Key Status Report
================================

${status.message}
Rate Limit: ${status.rateLimit}

${helpMessage}

Need help? Run the rate limit tester:
node test-rate-limits.js`
						}
					]
				};
			}
		);

		// EInfo - Get metadata about an Entrez database
		this.server.tool(
			"einfo",
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
						tool: this.defaultTool,
						email: this.defaultEmail,
						retmode: retmode || "xml"
					});

					if (db) params.append("db", db);
					if (version) params.append("version", version);

					const url = this.buildUrl("einfo.fcgi", params);
					const response = await fetch(url);
					const data = await this.parseResponse(response, "EInfo");

					return {
						content: [
							{
								type: "text",
								text: `EInfo Results:\n\n${data}`
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

		// ESearch - Run a text or UID-based query
		this.server.tool(
			"esearch",
			{
				db: z.string().default("pubmed").describe("Database to search"),
				term: z.string().describe("Entrez text query"),
				retstart: z.number().optional().describe("Starting position (0-based)"),
				retmax: z.number().optional().default(20).describe("Maximum number of UIDs to retrieve"),
				sort: z.string().optional().describe("Sort method (e.g., 'relevance', 'pub_date')"),
				field: z.string().optional().describe("Search field limitation"),
				usehistory: z.enum(["y", "n"]).optional().describe("Use Entrez History server"),
				datetype: z.string().optional().describe("Date type for date filtering"),
				reldate: z.number().optional().describe("Relative date (last n days)"),
				mindate: z.string().optional().describe("Minimum date (YYYY/MM/DD)"),
				maxdate: z.string().optional().describe("Maximum date (YYYY/MM/DD)"),
				retmode: z.enum(["xml", "json"]).optional().default("xml").describe("Output format"),
			},
			async ({ db, term, retstart, retmax, sort, field, usehistory, datetype, reldate, mindate, maxdate, retmode }) => {
				try {
					// Validate inputs
					if (!term || term.trim() === '') {
						throw new Error("Search term cannot be empty");
					}
					if (db && !this.isValidDatabase(db)) {
						throw new Error(`Invalid database name: ${db}`);
					}
					if (retmax !== undefined && (retmax < 0 || retmax > 100000)) {
						throw new Error("retmax must be between 0 and 100000");
					}
					if (retstart !== undefined && retstart < 0) {
						throw new Error("retstart must be non-negative");
					}

					const params = new URLSearchParams({
						db: db || "pubmed",
						term: term.trim(),
						tool: this.defaultTool,
						email: this.defaultEmail,
						retmode: retmode || "xml"
					});

					if (retstart !== undefined) params.append("retstart", retstart.toString());
					if (retmax !== undefined) params.append("retmax", retmax.toString());
					if (sort) params.append("sort", sort);
					if (field) params.append("field", field);
					if (usehistory) params.append("usehistory", usehistory);
					if (datetype) params.append("datetype", datetype);
					if (reldate !== undefined) params.append("reldate", reldate.toString());
					if (mindate) params.append("mindate", mindate);
					if (maxdate) params.append("maxdate", maxdate);

					const url = this.buildUrl("esearch.fcgi", params);
					const response = await fetch(url);
					const data = await this.parseResponse(response, "ESearch");

					return {
						content: [
							{
								type: "text",
								text: `ESearch Results:\n\n${data}`
							}
						]
					};
				} catch (error) {
					return {
						content: [
							{
								type: "text",
								text: `Error in ESearch: ${error instanceof Error ? error.message : String(error)}`
							}
						]
					};
				}
			}
		);

		// ESummary - Retrieve concise document summaries for UIDs
		this.server.tool(
			"esummary",
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
						tool: this.defaultTool,
						email: this.defaultEmail,
						retmode: retmode || "xml"
					});

					if (retstart !== undefined) params.append("retstart", retstart.toString());
					if (retmax !== undefined) params.append("retmax", retmax.toString());
					if (version) params.append("version", version);

					const url = this.buildUrl("esummary.fcgi", params);
					const response = await fetch(url);
					const data = await this.parseResponse(response, "ESummary");

					return {
						content: [
							{
								type: "text",
								text: `ESummary Results:\n\n${data}`
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

		// EFetch with Data Staging - Downloads and PARSES data from Entrez into relational SQLite database
		this.server.tool(
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
						tool: this.defaultTool,
						email: this.defaultEmail,
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
					// Parse the raw text content into structured JSON with UIDs
					const processedData = parser.parse(rawContent);

					// --- BYPASS AND STAGING LOGIC (Now receives clean structured data) ---
					const payloadSize = JSON.stringify(processedData).length;
					if (payloadSize < 1024) {
						return {
							content: [{ type: "text", text: JSON.stringify(processedData, null, 2) }],
							_meta: { bypassed: true, reason: "small_payload", size_bytes: payloadSize }
						};
					}

					// --- HAND-OFF TO DURABLE OBJECT FOR STAGING (sending clean array with UIDs) ---
					if (!EntrezMCP.currentEnv?.JSON_TO_SQL_DO) {
						throw new Error("JSON_TO_SQL_DO binding not available");
					}
					const doId = EntrezMCP.currentEnv.JSON_TO_SQL_DO.newUniqueId();
					const stub = EntrezMCP.currentEnv.JSON_TO_SQL_DO.get(doId);
					const stagingResponse = await stub.fetch("http://do/process", {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify(processedData)
					});
					const stagingResult = await stagingResponse.json();

					return { content: [{ type: "text", text: JSON.stringify(stagingResult, null, 2) }] };
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

		// Query Staged Data - Execute SQL queries against staged datasets
		this.server.tool(
			"query_staged_data",
			{
				data_access_id: z.string().describe("The data_access_id from a tool call that staged data."),
				sql: z.string().describe("The SQL SELECT query to run."),
			},
			async ({ data_access_id, sql }) => {
				try {
					if (!EntrezMCP.currentEnv?.JSON_TO_SQL_DO) {
						throw new Error("JSON_TO_SQL_DO binding not available");
					}
					const doId = EntrezMCP.currentEnv.JSON_TO_SQL_DO.idFromString(data_access_id);
					const stub = EntrezMCP.currentEnv.JSON_TO_SQL_DO.get(doId);
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

		// Get Staged Schema - Retrieve database schema for staged datasets
		this.server.tool(
			"get_staged_schema",
			{
				data_access_id: z.string().describe("The data_access_id from a tool call that staged data."),
			},
			async ({ data_access_id }) => {
				try {
					if (!EntrezMCP.currentEnv?.JSON_TO_SQL_DO) {
						throw new Error("JSON_TO_SQL_DO binding not available");
					}
					const doId = EntrezMCP.currentEnv.JSON_TO_SQL_DO.idFromString(data_access_id);
					const stub = EntrezMCP.currentEnv.JSON_TO_SQL_DO.get(doId);
					const response = await stub.fetch("http://do/schema");
					const schema = await response.json() as any[];
					const formattedSchema = schema.map((t: any) => `\n-- Table: ${t.name}\n${t.sql};`).join('\n');
					return { content: [{ type: "text", text: `Database Schema:\n${formattedSchema}` }] };
				} catch (e) {
					return { content: [{ type: "text", text: "Error: Invalid data_access_id. Please provide a valid ID from a staging tool." }] };
				}
			}
		);

		// ELink - Find UIDs linked/related within same or different databases
		this.server.tool(
			"elink",
			{
				db: z.string().default("pubmed").describe("Target database"),
				dbfrom: z.string().default("pubmed").describe("Source database"),
				id: z.string().describe("Comma-separated list of UIDs"),
				cmd: z.enum(["neighbor", "neighbor_score", "neighbor_history", "acheck", "ncheck", "lcheck", "llinks", "llinkslib", "prlinks"]).optional().default("neighbor").describe("ELink command mode"),
				linkname: z.string().optional().describe("Specific link name to retrieve"),
				term: z.string().optional().describe("Entrez query to limit output"),
				holding: z.string().optional().describe("LinkOut provider name"),
				datetype: z.string().optional().describe("Date type for filtering"),
				reldate: z.number().optional().describe("Relative date (last n days)"),
				mindate: z.string().optional().describe("Minimum date (YYYY/MM/DD)"),
				maxdate: z.string().optional().describe("Maximum date (YYYY/MM/DD)"),
				retmode: z.enum(["xml", "json", "ref"]).optional().default("xml").describe("Output format"),
			},
			async ({ db, dbfrom, id, cmd, linkname, term, holding, datetype, reldate, mindate, maxdate, retmode }) => {
				try {
					// Validate inputs
					if (!id || id.trim() === '') {
						throw new Error("ID parameter cannot be empty");
					}
					if (db && !this.isValidDatabase(db)) {
						throw new Error(`Invalid target database name: ${db}`);
					}
					if (dbfrom && !this.isValidDatabase(dbfrom)) {
						throw new Error(`Invalid source database name: ${dbfrom}`);
					}

					// Clean and validate IDs
					const cleanIds = id.split(',').map(i => i.trim()).filter(i => i !== '' && !isNaN(Number(i)));
					if (cleanIds.length === 0) {
						throw new Error("No valid numeric IDs provided");
					}

					const params = new URLSearchParams({
						db: db || "pubmed",
						dbfrom: dbfrom || "pubmed",
						id: cleanIds.join(','),
						tool: this.defaultTool,
						email: this.defaultEmail,
						retmode: retmode || "xml"
					});

					if (cmd) params.append("cmd", cmd);
					if (linkname) params.append("linkname", linkname);
					if (term) params.append("term", term);
					if (holding) params.append("holding", holding);
					if (datetype) params.append("datetype", datetype);
					if (reldate !== undefined) params.append("reldate", reldate.toString());
					if (mindate) params.append("mindate", mindate);
					if (maxdate) params.append("maxdate", maxdate);

					const url = this.buildUrl("elink.fcgi", params);
					const response = await fetch(url);
					const data = await this.parseResponse(response, "ELink");

					return {
						content: [
							{
								type: "text",
								text: `ELink Results:\n\n${data}`
							}
						]
					};
				} catch (error) {
					return {
						content: [
							{
								type: "text",
								text: `Error in ELink: ${error instanceof Error ? error.message : String(error)}`
							}
						]
					};
				}
			}
		);

		// EPost - Upload UIDs to Entrez History for later use
		this.server.tool(
			"epost",
			{
				db: z.string().default("pubmed").describe("Database name"),
				id: z.string().describe("Comma-separated list of UIDs to upload"),
				WebEnv: z.string().optional().describe("Existing Web Environment to append to"),
			},
			async ({ db, id, WebEnv }) => {
				try {
					// Validate inputs
					if (!id || id.trim() === '') {
						throw new Error("ID parameter cannot be empty");
					}
					if (db && !this.isValidDatabase(db)) {
						throw new Error(`Invalid database name: ${db}`);
					}

					// Clean and validate IDs
					const cleanIds = id.split(',').map(i => i.trim()).filter(i => i !== '' && !isNaN(Number(i)));
					if (cleanIds.length === 0) {
						throw new Error("No valid numeric IDs provided");
					}

					const params = new URLSearchParams({
						db: db || "pubmed",
						id: cleanIds.join(','),
						tool: this.defaultTool,
						email: this.defaultEmail,
					});

					if (WebEnv) params.append("WebEnv", WebEnv);

					const url = this.buildUrl("epost.fcgi", params);
					const response = await fetch(url);
					const data = await this.parseResponse(response, "EPost");

					return {
						content: [
							{
								type: "text",
								text: `EPost Results:\n\n${data}`
							}
						]
					};
				} catch (error) {
					return {
						content: [
							{
								type: "text",
								text: `Error in EPost: ${error instanceof Error ? error.message : String(error)}`
							}
						]
					};
				}
			}
		);

		// EGQuery - Run a global query across all Entrez databases
		this.server.tool(
			"egquery",
			{
				term: z.string().describe("Entrez text query to search across all databases"),
			},
			async ({ term }) => {
				try {
					// Validate input
					if (!term || term.trim() === '') {
						throw new Error("Search term cannot be empty");
					}

					// Clean and prepare the term - egquery is very sensitive to formatting
					const cleanTerm = term.trim().replace(/\s+/g, ' ');
					
					// Try multiple parameter combinations as egquery is notoriously finicky
					const paramSets = [
						// Standard approach with retmode
						new URLSearchParams({
							term: cleanTerm,
							tool: this.defaultTool,
							email: this.defaultEmail,
							retmode: "xml"
						}),
						// Alternative with simpler parameters
						new URLSearchParams({
							term: cleanTerm,
							tool: this.defaultTool,
							email: this.defaultEmail,
						}),
						// Try with URL encoding
						new URLSearchParams({
							term: encodeURIComponent(cleanTerm),
							tool: this.defaultTool,
							email: this.defaultEmail,
							retmode: "xml"
						})
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
									method: 'GET',
									headers: {
										'User-Agent': 'entrez-mcp-server/1.0.0',
										'Accept': 'text/xml, application/xml, text/plain, */*'
									}
								});

								diagnosticInfo += `Response status: ${response.status} ${response.statusText}\n`;
								diagnosticInfo += `Response headers: ${JSON.stringify(Object.fromEntries(response.headers.entries()))}\n`;

								if (!response.ok) {
									const errorText = await response.text();
									diagnosticInfo += `Error response body: ${errorText.substring(0, 500)}...\n`;
									throw new Error(`HTTP ${response.status}: ${errorText.substring(0, 200)}`);
								}

								const data = await response.text();
								diagnosticInfo += `Response length: ${data.length} characters\n`;
								
								// Enhanced error detection for egquery
								if (data.includes("<ERROR>") || data.includes('"ERROR"') || 
									data.includes("error") || data.includes("Error") ||
									data.includes("internal error") || data.includes("reference =")) {
									
									const errorMatch = data.match(/<ERROR>(.*?)<\/ERROR>/) || 
													  data.match(/"ERROR":"([^"]*)"/) || 
													  data.match(/error['":]?\s*([^"',}\n]*)/i) ||
													  data.match(/reference\s*=\s*([^\s,}\n]*)/i);
									
									if (errorMatch) {
										diagnosticInfo += `NCBI Error detected: ${errorMatch[0]}\n`;
										throw new Error(`NCBI EGQuery error: ${errorMatch[1] || errorMatch[0]}`);
									} else {
										diagnosticInfo += `Generic error detected in response\n`;
										throw new Error(`NCBI EGQuery error: ${data.substring(0, 200)}`);
									}
								}

								// Check for valid egquery response structure
								if (!data.includes("<eGQueryResult>") && !data.includes('"Result"') && 
									!data.includes("Result") && data.length < 50) {
									diagnosticInfo += `Response appears invalid or too short\n`;
									throw new Error("Invalid or empty response from EGQuery");
								}

								// Success!
								diagnosticInfo += `SUCCESS: Valid response received\n`;
								return {
									content: [
										{
											type: "text",
											text: `EGQuery Results:\n\n${data}\n\n--- Debug Info ---\n${diagnosticInfo}`
										}
									]
								};

							} catch (error) {
								diagnosticInfo += `Attempt ${attempt} failed: ${error instanceof Error ? error.message : String(error)}\n`;
								if (attempt < 2) {
									diagnosticInfo += `Waiting before retry...\n`;
									await new Promise(resolve => setTimeout(resolve, 1500 * attempt));
								}
							}
						}
						diagnosticInfo += `Parameter set ${paramIndex + 1} failed after all retries\n\n`;
					}

					// If all attempts failed, try a fallback approach using esearch on each database
					diagnosticInfo += `All direct egquery attempts failed. Attempting fallback approach...\n`;
					
					try {
						const majorDatabases = ["pubmed", "pmc", "protein", "nuccore", "gene"];
						const fallbackResults = [];
						
						for (const db of majorDatabases) {
							try {
								const searchParams = new URLSearchParams({
									db: db,
									term: cleanTerm,
									retmax: "0", // Just get counts
									tool: this.defaultTool,
									email: this.defaultEmail,
									retmode: "json"
								});
								
								const searchUrl = this.buildUrl("esearch.fcgi", searchParams);
								const searchResponse = await fetch(searchUrl);
								
								if (searchResponse.ok) {
									const searchData = await searchResponse.text();
									const countMatch = searchData.match(/"count":"(\d+)"/) || searchData.match(/<Count>(\d+)<\/Count>/);
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
										text: `EGQuery Results (via fallback method):\n\nCross-database search counts for "${cleanTerm}":\n${fallbackResults.join('\n')}\n\nNote: EGQuery service unavailable, results obtained via individual database searches.\n\n--- Debug Info ---\n${diagnosticInfo}`
									}
								]
							};
						}
					} catch (fallbackError) {
						diagnosticInfo += `Fallback approach also failed: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}\n`;
					}

					// Complete failure
					throw new Error(`All EGQuery approaches failed. NCBI EGQuery service may be experiencing issues.`);

				} catch (error) {
					return {
						content: [
							{
								type: "text",
								text: `Error in EGQuery: ${error instanceof Error ? error.message : String(error)}\n\nThis appears to be an ongoing issue with NCBI's EGQuery service. The service is known to be unstable and frequently returns internal server errors.\n\nWorkaround: Use individual database searches with esearch for each database of interest.`
							}
						]
					};
				}
			}
		);

		// ESpell - Return spelling suggestions for search terms
		this.server.tool(
			"espell",
			{
				db: z.string().default("pubmed").describe("Database name"),
				term: z.string().describe("Text query to get spelling suggestions for"),
			},
			async ({ db, term }) => {
				try {
					// Validate inputs
					if (!term || term.trim() === '') {
						throw new Error("Search term cannot be empty");
					}
					if (db && !this.isValidDatabase(db)) {
						throw new Error(`Invalid database name: ${db}`);
					}

					const params = new URLSearchParams({
						db: db || "pubmed",
						term: term.trim(),
						tool: this.defaultTool,
						email: this.defaultEmail,
					});

					const url = this.buildUrl("espell.fcgi", params);
					const response = await fetch(url);
					const data = await this.parseResponse(response, "ESpell");

					return {
						content: [
							{
								type: "text",
								text: `ESpell Results:\n\n${data}`
							}
						]
					};
				} catch (error) {
					return {
						content: [
							{
								type: "text",
								text: `Error in ESpell: ${error instanceof Error ? error.message : String(error)}`
							}
						]
					};
				}
			}
		);

		// ===== BLAST URL API =====
		
		// BLAST Submit - Submit a BLAST search job
		this.server.tool(
			"blast_submit",
			{
				cmd: z.literal("Put").describe("Command to submit search"),
				query: z.string().describe("Search query (FASTA sequence, accession, or GI)"),
				database: z.string().describe("BLAST database name (e.g., nt, nr, swissprot)"),
				program: z.enum(["blastn", "blastp", "blastx", "tblastn", "tblastx"]).describe("BLAST program"),
				megablast: z.enum(["on", "off"]).optional().describe("Enable megablast for blastn"),
				expect: z.number().optional().default(10).describe("Expect value threshold"),
				filter: z.string().optional().describe("Low complexity filtering (L, F, or m+filter)"),
				word_size: z.number().optional().describe("Word size for initial matches"),
				gapcosts: z.string().optional().describe("Gap existence and extension costs (space-separated)"),
				matrix: z.enum(["BLOSUM45", "BLOSUM50", "BLOSUM62", "BLOSUM80", "BLOSUM90", "PAM250", "PAM30", "PAM70"]).optional().describe("Scoring matrix"),
				nucl_reward: z.number().optional().describe("Reward for matching nucleotides"),
				nucl_penalty: z.number().optional().describe("Penalty for mismatching nucleotides"),
				hitlist_size: z.number().optional().default(100).describe("Number of database sequences to keep"),
				format_type: z.enum(["HTML", "Text", "XML2", "XML2_S", "JSON2", "JSON2_S", "SAM"]).optional().default("XML2").describe("Output format"),
				descriptions: z.number().optional().default(100).describe("Number of descriptions to show"),
				alignments: z.number().optional().default(100).describe("Number of alignments to show"),
			},
			async ({ cmd, query, database, program, megablast, expect, filter, word_size, gapcosts, matrix, nucl_reward, nucl_penalty, hitlist_size, format_type, descriptions, alignments }) => {
				try {
					if (!query || query.trim() === '') {
						throw new Error("Query sequence cannot be empty");
					}

					const params = new URLSearchParams({
						CMD: cmd,
						QUERY: query.trim(),
						DATABASE: database,
						PROGRAM: program,
						EMAIL: this.defaultEmail,
						TOOL: this.defaultTool,
					});

					// Add optional parameters
					if (megablast) params.append("MEGABLAST", megablast);
					if (expect !== undefined) params.append("EXPECT", expect.toString());
					if (filter) params.append("FILTER", filter);
					if (word_size !== undefined) params.append("WORD_SIZE", word_size.toString());
					if (gapcosts) params.append("GAPCOSTS", gapcosts);
					if (matrix) params.append("MATRIX", matrix);
					if (nucl_reward !== undefined) params.append("NUCL_REWARD", nucl_reward.toString());
					if (nucl_penalty !== undefined) params.append("NUCL_PENALTY", nucl_penalty.toString());
					if (hitlist_size !== undefined) params.append("HITLIST_SIZE", hitlist_size.toString());
					if (format_type) params.append("FORMAT_TYPE", format_type);
					if (descriptions !== undefined) params.append("DESCRIPTIONS", descriptions.toString());
					if (alignments !== undefined) params.append("ALIGNMENTS", alignments.toString());

					const url = `https://blast.ncbi.nlm.nih.gov/Blast.cgi?${params}`;
					const response = await fetch(url, { method: 'POST' });
					const data = await this.parseResponse(response, "BLAST Submit");

					return {
						content: [
							{
								type: "text",
								text: `BLAST Submit Results:\n\n${data}`
							}
						]
					};
				} catch (error) {
					return {
						content: [
							{
								type: "text",
								text: `Error in BLAST Submit: ${error instanceof Error ? error.message : String(error)}`
							}
						]
					};
				}
			}
		);

		// BLAST Get - Retrieve BLAST search results
		this.server.tool(
			"blast_get",
			{
				cmd: z.literal("Get").describe("Command to get results"),
				rid: z.string().describe("Request ID from BLAST submission"),
				format_type: z.enum(["HTML", "Text", "XML2", "XML2_S", "JSON2", "JSON2_S", "SAM"]).optional().default("XML2").describe("Output format"),
				descriptions: z.number().optional().default(100).describe("Number of descriptions to show"),
				alignments: z.number().optional().default(100).describe("Number of alignments to show"),
				alignment_view: z.enum(["Pairwise", "QueryAnchored", "FlatQueryAnchored", "Tabular"]).optional().describe("Alignment view format"),
			},
			async ({ cmd, rid, format_type, descriptions, alignments, alignment_view }) => {
				try {
					if (!rid || rid.trim() === '') {
						throw new Error("Request ID (RID) cannot be empty");
					}
		
					const params = new URLSearchParams({
						CMD: cmd,
						RID: rid.trim(),
					});
		
					if (format_type) params.append("FORMAT_TYPE", format_type);
					if (descriptions !== undefined) params.append("DESCRIPTIONS", descriptions.toString());
					if (alignments !== undefined) params.append("ALIGNMENTS", alignments.toString());
					if (alignment_view) params.append("ALIGNMENT_VIEW", alignment_view);
		
					const url = `https://blast.ncbi.nlm.nih.gov/Blast.cgi?${params}`;
		
					// Implement polling for BLAST results
					const maxRetries = 15;
					const retryDelay = 10000; // 10 seconds
		
					for (let i = 0; i < maxRetries; i++) {
						const response = await fetch(url);
						const data = await this.parseResponse(response, "BLAST Get");
		
						// Check if the search is still running
						if (data.includes("Status=WAITING") || data.includes("Status=UNKNOWN")) {
							if (i < maxRetries - 1) {
								// Wait before the next attempt
								await new Promise(resolve => setTimeout(resolve, retryDelay));
								continue;
							} else {
								return {
									content: [
										{
											type: "text",
											text: `BLAST search with RID ${rid} is still running after ${maxRetries} attempts. Please try again later.\n\n${data}`
										}
									]
								};
							}
						}
		
						// If results are ready or an error occurred, return the response
						return {
							content: [
								{
									type: "text",
									text: `BLAST Results:\n\n${data}`
								}
							]
						};
					}
		
					// This should not be reached, but as a fallback:
					throw new Error("BLAST polling failed unexpectedly.");
		
				} catch (error) {
					return {
						content: [
							{
								type: "text",
								text: `Error in BLAST Get: ${error instanceof Error ? error.message : String(error)}`
							}
						]
					};
				}
			}
		);

		// ===== PubChem PUG REST API =====

		// PubChem Compound Lookup - Get compound information
		this.server.tool(
			"pubchem_compound",
			{
				identifier_type: z.enum(["cid", "name", "smiles", "inchi", "inchikey", "formula"]).describe("Type of identifier"),
				identifier: z.string().describe("Compound identifier"),
				operation: z.enum(["record", "property", "synonyms", "classification", "conformers"]).default("record").describe("Type of data to retrieve"),
				property_list: z.string().optional().describe("Comma-separated list of properties (for property operation)"),
				output_format: z.enum(["json", "xml", "sdf", "csv", "png", "txt"]).default("json").describe("Output format"),
			},
			async ({ identifier_type, identifier, operation, property_list, output_format }) => {
				try {
					if (!identifier || identifier.trim() === '') {
						throw new Error("Identifier cannot be empty");
					}

					let url = `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/${identifier_type}/${encodeURIComponent(identifier.trim())}`;
					
					if (operation === "property" && property_list) {
						url += `/property/${property_list}`;
					} else if (operation !== "record") {
						url += `/${operation}`;
					}

					url += `/${output_format.toUpperCase()}`;

					// Add tool and email parameters
					const params = new URLSearchParams({
						tool: this.defaultTool,
						email: this.defaultEmail,
					});
					url += `?${params}`;

					const response = await fetch(url);
					const data = await this.parseResponse(response, "PubChem Compound");

					return {
						content: [
							{
								type: "text",
								text: `PubChem Compound Results:\n\n${data}`
							}
						]
					};
				} catch (error) {
					return {
						content: [
							{
								type: "text",
								text: `Error in PubChem Compound: ${error instanceof Error ? error.message : String(error)}`
							}
						]
					};
				}
			}
		);

		// PubChem Substance Lookup - Get substance information
		this.server.tool(
			"pubchem_substance",
			{
				identifier_type: z.enum(["sid", "sourceid", "name", "xref"]).describe("Type of identifier"),
				identifier: z.string().describe("Substance identifier"),
				operation: z.enum(["record", "synonyms", "classification", "xrefs"]).default("record").describe("Type of data to retrieve"),
				output_format: z.enum(["json", "xml", "sdf", "csv", "txt"]).default("json").describe("Output format"),
			},
			async ({ identifier_type, identifier, operation, output_format }) => {
				try {
					if (!identifier || identifier.trim() === '') {
						throw new Error("Identifier cannot be empty");
					}

					let url = `https://pubchem.ncbi.nlm.nih.gov/rest/pug/substance/${identifier_type}/${encodeURIComponent(identifier.trim())}`;
					
					if (operation !== "record") {
						url += `/${operation}`;
					}

					url += `/${output_format.toUpperCase()}`;

					// Add tool and email parameters
					const params = new URLSearchParams({
						tool: this.defaultTool,
						email: this.defaultEmail,
					});
					url += `?${params}`;

					const response = await fetch(url);
					const data = await this.parseResponse(response, "PubChem Substance");

					return {
						content: [
							{
								type: "text",
								text: `PubChem Substance Results:\n\n${data}`
							}
						]
					};
				} catch (error) {
					return {
						content: [
							{
								type: "text",
								text: `Error in PubChem Substance: ${error instanceof Error ? error.message : String(error)}`
							}
						]
					};
				}
			}
		);

		// PubChem BioAssay Lookup - Get bioassay information
		this.server.tool(
			"pubchem_bioassay",
			{
				identifier_type: z.enum(["aid", "listkey", "target", "activity"]).describe("Type of identifier"),
				identifier: z.string().describe("BioAssay identifier"),
				operation: z.enum(["record", "summary", "description", "targets", "aids"]).default("record").describe("Type of data to retrieve"),
				output_format: z.enum(["json", "xml", "csv", "txt"]).default("json").describe("Output format"),
			},
			async ({ identifier_type, identifier, operation, output_format }) => {
				try {
					if (!identifier || identifier.trim() === '') {
						throw new Error("Identifier cannot be empty");
					}

					let url = `https://pubchem.ncbi.nlm.nih.gov/rest/pug/assay/${identifier_type}/${encodeURIComponent(identifier.trim())}`;
					
					if (operation !== "record") {
						url += `/${operation}`;
					}

					url += `/${output_format.toUpperCase()}`;

					// Add tool and email parameters
					const params = new URLSearchParams({
						tool: this.defaultTool,
						email: this.defaultEmail,
					});
					url += `?${params}`;

					const response = await fetch(url);
					const data = await this.parseResponse(response, "PubChem BioAssay");

					return {
						content: [
							{
								type: "text",
								text: `PubChem BioAssay Results:\n\n${data}`
							}
						]
					};
				} catch (error) {
					return {
						content: [
							{
								type: "text",
								text: `Error in PubChem BioAssay: ${error instanceof Error ? error.message : String(error)}`
							}
						]
					};
				}
			}
		);

		// PubChem Structure Search - Search by chemical structure
		this.server.tool(
			"pubchem_structure_search",
			{
				structure_type: z.enum(["smiles", "inchi", "sdf", "mol"]).describe("Type of structure input"),
				structure: z.string().describe("Chemical structure representation"),
				search_type: z.enum(["identity", "substructure", "superstructure", "similarity"]).describe("Type of structure search"),
				threshold: z.number().optional().default(90).describe("Similarity threshold (for similarity searches, 0-100)"),
				max_records: z.number().optional().default(1000).describe("Maximum number of records to return"),
				output_format: z.enum(["json", "xml", "sdf", "csv", "txt"]).default("json").describe("Output format"),
			},
			async ({ structure_type, structure, search_type, threshold, max_records, output_format }) => {
				try {
					if (!structure || structure.trim() === '') {
						throw new Error("Structure cannot be empty");
					}

					// Build the correct PubChem structure search URL
					const baseUrl = `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound`;
					let url: string;
					
					const params = new URLSearchParams({
						tool: this.defaultTool,
						email: this.defaultEmail,
					});

					let response: Response;

					if (search_type === "identity") {
						// Identity search is synchronous and uses GET.
						// e.g. /compound/identity/smiles/c1ccccc1/cids/JSON
						url = `${baseUrl}/identity/${structure_type}/${encodeURIComponent(structure.trim())}/cids/${output_format.toUpperCase()}`;
						url += `?${params}`;
						response = await fetch(url);
					} else {
						// Other searches (substructure, superstructure, similarity) are asynchronous and use POST.
						// This implementation follows the PUG-REST documentation.
						// e.g. /compound/substructure/smiles/cids/JSON
						url = `${baseUrl}/${search_type}/${structure_type}/cids/${output_format.toUpperCase()}`;
						
						if (search_type === 'similarity' && threshold !== undefined) {
							params.append('Threshold', threshold.toString());
						}
						if (max_records !== undefined) {
							params.append('MaxRecords', max_records.toString());
						}
						
						url += `?${params}`;

						response = await fetch(url, {
							method: 'POST',
							headers: { 'Content-Type': 'text/plain' },
							body: structure.trim()
						});
					}

					if (!response.ok) {
						const errorText = await response.text();
						throw new Error(`PubChem search failed: ${response.status} ${response.statusText}. Response: ${errorText}`);
					}

					const responseData = await response.text();
					
					// Check if this is a waiting response or direct results
					if (responseData.includes('"Waiting"') || responseData.includes('"Running"')) {
						return {
							content: [
								{
									type: "text",
									text: `PubChem Structure Search Submitted:\n\nSearch is running. Please wait and try again with the returned key to get results.\n\n${responseData}`
								}
							]
						};
					}

					return {
						content: [
							{
								type: "text",
								text: `PubChem Structure Search Results:\n\n${responseData}`
							}
						]
					};
				} catch (error) {
					return {
						content: [
							{
								type: "text",
								text: `Error in PubChem Structure Search: ${error instanceof Error ? error.message : String(error)}`
							}
						]
					};
				}
			}
		);

		// ===== PMC APIs =====

		// PMC ID Converter - Convert between PMC, PMID, DOI, MID
		this.server.tool(
			"pmc_id_converter",
			{
				ids: z.string().describe("Comma-separated list of IDs to convert (up to 200)"),
				idtype: z.enum(["pmcid", "pmid", "mid", "doi"]).optional().describe("Type of input IDs (auto-detected if not specified)"),
				versions: z.enum(["yes", "no"]).default("no").describe("Show version information"),
				showaiid: z.enum(["yes", "no"]).default("no").describe("Show Article Instance IDs"),
				format: z.enum(["xml", "json", "csv"]).default("json").describe("Output format"),
			},
			async ({ ids, idtype, versions, showaiid, format }) => {
				try {
					if (!ids || ids.trim() === '') {
						throw new Error("IDs parameter cannot be empty");
					}

					// Clean and validate IDs
					const cleanIds = ids.split(',').map(id => id.trim()).filter(id => id !== '');
					if (cleanIds.length === 0) {
						throw new Error("No valid IDs provided");
					}
					if (cleanIds.length > 200) {
						throw new Error("Too many IDs provided (maximum 200)");
					}

					const params = new URLSearchParams({
						ids: cleanIds.join(','),
						versions: versions,
						showaiid: showaiid,
						format: format,
						tool: this.defaultTool,
						email: this.defaultEmail,
					});

					if (idtype) {
						params.append("idtype", idtype);
					}

					const url = `https://www.ncbi.nlm.nih.gov/pmc/utils/idconv/v1.0/?${params}`;
					const response = await fetch(url);
					const data = await this.parseResponse(response, "PMC ID Converter");

					return {
						content: [
							{
								type: "text",
								text: `PMC ID Converter Results:\n\n${data}`
							}
						]
					};
				} catch (error) {
					return {
						content: [
							{
								type: "text",
								text: `Error in PMC ID Converter: ${error instanceof Error ? error.message : String(error)}`
							}
						]
					};
				}
			}
		);

		// PMC Open Access Service - Check if article is available in Open Access
		this.server.tool(
			"pmc_oa_service",
			{
				id: z.string().describe("PMC ID, PMID, or DOI"),
				format: z.enum(["xml", "json"]).optional().default("xml").describe("Output format"),
			},
			async ({ id, format }) => {
				try {
					if (!id || id.trim() === '') {
						throw new Error("ID cannot be empty");
					}

					// Build the PMC OA service URL - this service only works for articles in PMC Open Access Subset
					const url = `https://www.ncbi.nlm.nih.gov/pmc/utils/oa/oa.fcgi?id=${encodeURIComponent(id.trim())}&tool=entrez-mcp-server&email=entrez-mcp-server%40example.com`;

					const response = await fetch(url, {
						headers: {
							'User-Agent': 'NCBI Entrez E-utilities MCP Server (entrez-mcp-server@example.com)'
						}
					});

					const data = await this.parseResponse(response, "PMC OA Service");
					
					// Check if the article is not available in OA
					if (data.includes('cannotDisseminateFormat') || data.includes('not available')) {
						return {
							content: [
								{
									type: "text",
									text: `PMC Open Access Service Results:\n\nArticle ${id} is not available through the PMC Open Access Service. This may be because:\n1. The article is not in the PMC Open Access Subset\n2. The article has access restrictions\n3. The article is available only to PMC subscribers\n\nResponse: ${data}`
								}
							]
						};
					}

					return {
						content: [
							{
								type: "text",
								text: `PMC Open Access Service Results:\n\n${data}`
							}
						]
					};
				} catch (error) {
					return {
						content: [
							{
								type: "text",
								text: `Error in PMC Open Access Service: ${error instanceof Error ? error.message : String(error)}`
							}
						]
					};
				}
			}
		);

		// PMC Citation Exporter - Get formatted citations for PMC articles
		this.server.tool(
			"pmc_citation_exporter",
			{
				id: z.string().describe("PMC ID or PMID"),
				format: z.enum(["ris", "nbib", "medline", "bibtex"]).describe("Citation format"),
			},
			async ({ id, format }) => {
				try {
					if (!id || id.trim() === '') {
						throw new Error("ID cannot be empty");
					}

					// Build the PMC citation exporter URL based on documentation examples
					// Format: https://api.ncbi.nlm.nih.gov/lit/ctxp/v1/pmc/{format}?id={id}
					const url = `https://api.ncbi.nlm.nih.gov/lit/ctxp/v1/pmc/${format}?id=${encodeURIComponent(id.trim())}`;

					const response = await fetch(url, {
						headers: {
							'User-Agent': `${this.defaultTool} (${this.defaultEmail})`
						}
					});

					if (!response.ok) {
						const errorText = await response.text();
						throw new Error(`PMC Citation Exporter request failed: ${response.status} ${response.statusText}. Response: ${errorText}`);
					}

					const data = await response.text();

					return {
						content: [
							{
								type: "text",
								text: `PMC Citation Exporter Results:\n\n${data}`
							}
						]
					};
				} catch (error) {
					return {
						content: [
							{
								type: "text",
								text: `Error in PMC Citation Exporter: ${error instanceof Error ? error.message : String(error)}`
							}
						]
					};
				}
			}
		);
	}
}

// Temporary alias for migration
export class MyMCP extends EntrezMCP {}

export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext) {
		// Set the environment for the EntrezMCP class to access
		EntrezMCP.currentEnv = env;
		
		const url = new URL(request.url);

		if (url.pathname === "/sse" || url.pathname === "/sse/message") {
			return EntrezMCP.serveSSE("/sse").fetch(request, env, ctx);
		}

		if (url.pathname === "/mcp") {
			return EntrezMCP.serve("/mcp").fetch(request, env, ctx);
		}

		return new Response("Complete NCBI APIs MCP Server - Including E-utilities, BLAST, PubChem PUG, PMC APIs, and Advanced Data Staging", { 
			status: 200,
			headers: { "Content-Type": "text/plain" }
		});
	},
};

export { JsonToSqlDO };
