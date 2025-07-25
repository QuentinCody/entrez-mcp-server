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

	// Instance-based environment storage instead of static
	private workerEnv: Env | undefined;

	// Proper Durable Object constructor that captures the environment
	constructor(ctx?: any, env?: Env) {
		super(ctx, env);
		if (env) {
			this.workerEnv = env;
			console.log("EntrezMCP constructor: environment bindings available:", {
				hasJsonToSqlDO: !!env.JSON_TO_SQL_DO,
				hasMcpObject: !!env.MCP_OBJECT,
				hasApiKey: !!env.NCBI_API_KEY
			});
		} else {
			console.log("EntrezMCP constructor: no environment provided");
		}
	}

	// Optional Entrez API key - accessed from environment via method
	private getApiKey(): string | undefined {
		// Access through instance environment
		const apiKey = this.workerEnv?.NCBI_API_KEY || EntrezMCP.currentEnv?.NCBI_API_KEY;
		// Don't return literal placeholder strings from environment
		if (apiKey && apiKey.startsWith('${') && apiKey.endsWith('}')) {
			return undefined;
		}
		return apiKey;
	}

	// Static property to hold the current environment during request processing (fallback)
	public static currentEnv: Env | undefined;

	// Method to set environment on this instance
	public setEnvironment(env: Env): void {
		this.workerEnv = env;
	}

	// Helper method to get environment (prefer instance, fallback to static)
	private getEnvironment(): Env | undefined {
		return this.workerEnv || EntrezMCP.currentEnv;
	}

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
	private async parseResponse(response: Response, toolName: string, requestedRetmode?: string): Promise<string | any> {
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
		// Check if JSON was explicitly requested or if content-type indicates JSON
		if (requestedRetmode === "json" || 
			toolName.includes("JSON") || 
			response.headers.get('content-type')?.includes('application/json')) {
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

	// Helper method to format response data (handles both strings and objects)
	private formatResponseData(data: any): string {
		if (typeof data === 'string') {
			return data;
		} else if (typeof data === 'object' && data !== null) {
			// Check if this is an ESearch result with query translations that could be improved
			if (data.esearchresult && (data.esearchresult.translationset || data.esearchresult.querytranslation)) {
				return this.formatESearchResponse(data);
			}
			return JSON.stringify(data, null, 2);
		} else {
			return String(data);
		}
	}

	// Enhanced formatter for ESearch responses with cleaned up query translations
	private formatESearchResponse(data: any): string {
		const result = data.esearchresult;
		let output = '';

		// Basic search info
		output += `Search Results Summary:\n`;
		output += `========================\n`;
		output += `Total Results: ${result.count || '0'}\n`;
		output += `Returned: ${result.retmax || '0'}\n`;
		output += `Starting at: ${result.retstart || '0'}\n\n`;

		// Clean up query translations
		if (result.translationset && result.translationset.length > 0) {
			output += `Query Interpretation:\n`;
			output += `====================\n`;
			
			for (const translation of result.translationset) {
				output += `Your search: "${translation.from}"\n`;
				output += `Expanded to include:\n`;
				
				const cleanedTerms = this.extractMeaningfulTerms(translation.to);
				for (const term of cleanedTerms) {
					output += `  • ${term}\n`;
				}
				output += '\n';
			}
		}

		// If query translation exists but no translation set, show cleaned version
		if (result.querytranslation && (!result.translationset || result.translationset.length === 0)) {
			output += `Search Terms Used:\n`;
			output += `==================\n`;
			const cleanedTerms = this.extractMeaningfulTerms(result.querytranslation);
			for (const term of cleanedTerms) {
				output += `  • ${term}\n`;
			}
			output += '\n';
		}

		// Article IDs
		if (result.idlist && result.idlist.length > 0) {
			output += `Article IDs Found:\n`;
			output += `==================\n`;
			output += result.idlist.join(', ') + '\n\n';
		}

		// Add raw technical details for power users (collapsed)
		output += `Technical Details (Full Query):\n`;
		output += `===============================\n`;
		output += `${result.querytranslation || 'No query translation available'}\n\n`;

		// Include any other fields that might be present
		const otherFields = Object.keys(result).filter(key => 
			!['count', 'retmax', 'retstart', 'idlist', 'translationset', 'querytranslation'].includes(key)
		);
		
		if (otherFields.length > 0) {
			output += `Additional Information:\n`;
			output += `======================\n`;
			for (const field of otherFields) {
				output += `${field}: ${JSON.stringify(result[field])}\n`;
			}
		}

		return output;
	}

	// Extract meaningful search terms from NCBI's verbose Boolean query
	private extractMeaningfulTerms(queryString: string): string[] {
		const terms = new Set<string>();
		
		// Match patterns like "term"[Field] or just quoted terms
		const patterns = [
			// MeSH terms: "diabetes mellitus"[MeSH Terms]
			/"([^"]+)"\[MeSH Terms\]/g,
			// Supplementary concepts: "covid-19 vaccines"[Supplementary Concept]  
			/"([^"]+)"\[Supplementary Concept\]/g,
			// All fields (only include if not already captured): "meaningful term"[All Fields]
			/"([^"]+)"\[All Fields\]/g,
			// Other field types
			/"([^"]+)"\[Title\]/g,
			/"([^"]+)"\[Author\]/g,
			/"([^"]+)"\[Journal\]/g,
		];

		for (const pattern of patterns) {
			let match: RegExpExecArray | null;
			match = pattern.exec(queryString);
			while (match !== null) {
				const term = match[1].trim();
				if (term && term.length > 2) { // Filter out very short terms
					// Add field type annotation for clarity
					if (pattern.source.includes('MeSH Terms')) {
						terms.add(`${term} (MeSH term)`);
					} else if (pattern.source.includes('Supplementary Concept')) {
						terms.add(`${term} (medical concept)`);
					} else if (pattern.source.includes('Title')) {
						terms.add(`${term} (in title)`);
					} else if (pattern.source.includes('Author')) {
						terms.add(`${term} (author name)`);
					} else if (pattern.source.includes('Journal')) {
						terms.add(`${term} (journal name)`);
					} else {
						// For All Fields, only add if it's not a duplicate of a more specific field
						const simplePattern = term.toLowerCase().replace(/[^a-z0-9\s]/g, '');
						const alreadyHasSpecific = Array.from(terms).some(existingTerm => 
							existingTerm.toLowerCase().includes(simplePattern)
						);
						if (!alreadyHasSpecific) {
							terms.add(`${term} (anywhere in article)`);
						}
					}
				}
				match = pattern.exec(queryString);
			}
		}

		// If no structured terms found, try to extract basic quoted terms
		if (terms.size === 0) {
			const basicQuotedTerms = queryString.match(/"([^"]+)"/g);
			if (basicQuotedTerms) {
				basicQuotedTerms.forEach(quotedTerm => {
					const term = quotedTerm.replace(/"/g, '').trim();
					if (term.length > 2) {
						terms.add(term);
					}
				});
			}
		}

		return Array.from(terms).sort();
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

	// Intelligent staging bypass logic
	private shouldBypassStaging(entities: any[], diagnostics: any, payloadSize: number): { bypass: boolean; reason: string } {
		const entityCount = entities.length;
		
		// Count different entity types
		const entityTypes = new Set(entities.map(e => e.type));
		const entityTypeCount = entityTypes.size;
		
		// Estimate potential table count (entity types + junction tables)
		const estimatedTableCount = entityTypeCount + Math.max(0, entityTypeCount - 1);
		
		// Check various bypass conditions
		
		// 1. Very small payload (< 1KB)
		if (payloadSize < 1024) {
			return { bypass: true, reason: "Small dataset (< 1KB) returned directly - no staging overhead needed" };
		}
		
		// 2. Very few entities (< 10 total)
		if (entityCount < 10) {
			return { bypass: true, reason: "Few entities extracted (< 10) - direct return more efficient than SQL staging" };
		}
		
		// 3. Only 1-2 entity types (minimal relational benefit)
		if (entityTypeCount <= 2 && entityCount < 25) {
			return { bypass: true, reason: "Simple structure with few entity types - SQL staging provides minimal benefit" };
		}
		
		// 4. Poor data quality / parsing failure
		if (diagnostics.failed_extractions?.length > 0 || diagnostics.mesh_availability === 'none') {
			if (entityCount < 15) {
				return { bypass: true, reason: "Limited data extraction success - returning parsed results directly" };
			}
		}
		
		// 5. Single article with basic info only
		if (entityCount < 20 && entityTypeCount <= 3 && payloadSize < 2048) {
			return { bypass: true, reason: "Single article with basic information - staging unnecessary for simple data" };
		}
		
		// If none of the bypass conditions are met, proceed with staging
		return { bypass: false, reason: "Dataset complexity justifies SQL staging for efficient querying" };
	}

	async init() {
		// API Key Status - Check NCBI API key configuration and rate limits
		this.server.tool(
			"api_key_status",
			"Check your NCBI API key configuration and current rate limits. Without an API key, you're limited to 3 requests/second. With a valid API key, you get 10 requests/second (or higher by request). Essential for optimizing E-utilities performance.",
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
						tool: this.defaultTool,
						email: this.defaultEmail,
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

		// ESearch - Run a text or UID-based query
		this.server.tool(
			"esearch",
			"Search Entrez databases with text queries to find matching UIDs. Core Entrez function that converts queries into UID lists for use with other E-utilities. Supports Boolean operators (AND, OR, NOT) and field-specific searches.",
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
					const data = await this.parseResponse(response, "ESearch", retmode);

					return {
						content: [
							{
								type: "text",
								text: `ESearch Results:\n\n${this.formatResponseData(data)}`
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
						tool: this.defaultTool,
						email: this.defaultEmail,
						retmode: retmode || "xml"
					});

					if (retstart !== undefined) params.append("retstart", retstart.toString());
					if (retmax !== undefined) params.append("retmax", retmax.toString());
					if (version) params.append("version", version);

					const url = this.buildUrl("esummary.fcgi", params);
					const response = await fetch(url);
					const data = await this.parseResponse(response, "ESummary", retmode);

					return {
						content: [
							{
								type: "text",
								text: `ESummary Results:\n\n${this.formatResponseData(data)}`
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
					// Parse the raw text content into structured JSON with UIDs and diagnostics
					const parseResult = parser.parse(rawContent);
					const processedData = parseResult.entities;

					// --- INTELLIGENT BYPASS AND STAGING LOGIC ---
					const payloadSize = JSON.stringify(processedData).length;
					const entityCount = processedData.length;
					
					// Analyze data to determine if staging is beneficial
					const shouldBypass = this.shouldBypassStaging(processedData, parseResult.diagnostics, payloadSize);
					
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

		// Query Staged Data - Execute SQL queries against staged datasets
		this.server.tool(
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

		// Get Staged Schema - Retrieve enhanced database schema and guidance for staged datasets
		this.server.tool(
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

		// ELink - Find UIDs linked/related within same or different databases
		this.server.tool(
			"elink",
			"Find UIDs linked between Entrez databases (e.g., SNP records linked to Nucleotide, Domain records linked to Protein). Essential for discovering related data across NCBI's interconnected databases and creating data pipelines.",
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
					const data = await this.parseResponse(response, "ELink", retmode);

					return {
						content: [
							{
								type: "text",
								text: `ELink Results:\n\n${this.formatResponseData(data)}`
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
			"Upload UIDs to the Entrez History server for efficient batch processing. Essential for large datasets - upload thousands of IDs once, then use with other E-utilities. Returns query_key and WebEnv for pipeline workflows.",
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
								text: `EPost Results:\n\n${this.formatResponseData(data)}`
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
			"Search across all 38+ Entrez databases simultaneously to see hit counts for your query in each database. Global version of ESearch that helps identify which databases contain relevant data before focused searches.",
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
			"Get spelling suggestions for search terms in Entrez databases. Helps optimize queries by suggesting correct spellings for biomedical terms, gene names, and scientific terminology before running searches.",
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
								text: `ESpell Results:\n\n${this.formatResponseData(data)}`
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
			"Submit sequences for BLAST similarity searching against NCBI databases. Supports all BLAST programs (blastn, blastp, blastx, tblastn, tblastx) with customizable parameters. Returns job ID for result retrieval.",
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
								text: `BLAST Submit Results:\n\n${this.formatResponseData(data)}`
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
			"Retrieve results from a submitted BLAST job using the Request ID. Get detailed sequence alignments, similarity scores, and annotations. Multiple output formats available including XML, JSON, and tabular.",
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
											text: `BLAST search with RID ${rid} is still running after ${maxRetries} attempts. Please try again later.\n\n${this.formatResponseData(data)}`
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
									text: `BLAST Results:\n\n${this.formatResponseData(data)}`
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
			"Get detailed compound information from PubChem including chemical properties, synonyms, and classifications. Search by CID, name, SMILES, InChI, or molecular formula.",
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
								text: `PubChem Compound Results:\n\n${this.formatResponseData(data)}`
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
			"Get substance information from PubChem including substance records, synonyms, and cross-references. Search by SID, source ID, name, or external references.",
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
								text: `PubChem Substance Results:\n\n${this.formatResponseData(data)}`
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
			"Get bioassay information from PubChem including assay descriptions, targets, and activity data. Search by AID, target, or activity type.",
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
								text: `PubChem BioAssay Results:\n\n${this.formatResponseData(data)}`
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
			"Perform structure-based searches in PubChem including identity, substructure, superstructure, and similarity searches. Input chemical structures as SMILES, InChI, SDF, or MOL.",
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
									text: `PubChem Structure Search Submitted:\n\nSearch is running. Please wait and try again with the returned key to get results.\n\n${this.formatResponseData(responseData)}`
								}
							]
						};
					}

					return {
						content: [
							{
								type: "text",
								text: `PubChem Structure Search Results:\n\n${this.formatResponseData(responseData)}`
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
			"Convert between different PMC article identifiers including PMC IDs, PubMed IDs (PMID), DOIs, and Manuscript IDs (MID). Supports up to 200 IDs per request.",
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
								text: `PMC ID Converter Results:\n\n${this.formatResponseData(data)}`
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
			"Check if a PMC article is available in the Open Access subset and get download links for full-text content. Works with PMC IDs, PubMed IDs, or DOIs.",
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
								text: `PMC Open Access Service Results:\n\n${this.formatResponseData(data)}`
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
			"Export properly formatted citations for PMC articles in various bibliographic formats including RIS, NBIB, MEDLINE, and BibTeX for use in reference managers.",
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
								text: `PMC Citation Exporter Results:\n\n${this.formatResponseData(data)}`
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
