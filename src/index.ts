import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import JSZip from "jszip";

// Define our MCP agent for NCBI Entrez E-utilities
export class EntrezMCP extends McpAgent {
	server = new McpServer({
		name: "Complete NCBI APIs MCP Server",
		version: "1.0.0",
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
	private async parseResponse(response: Response, toolName: string): Promise<string> {
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

	// Enhanced response parsing with structured data extraction
	private async parseAndStructureResponse(response: Response, toolName: string, format: string = "xml"): Promise<any> {
		const rawData = await this.parseResponse(response, toolName);
		
		// Try to structure the response based on format and tool
		if (format === "json") {
			try {
				return JSON.parse(rawData);
			} catch {
				return { raw: rawData };
			}
		}
		
		// For XML responses, extract key information
		if (format === "xml" && toolName.includes("ESearch")) {
			const count = rawData.match(/<Count>(\d+)<\/Count>/)?.[1];
			const idList = rawData.match(/<Id>(\d+)<\/Id>/g)?.map(id => id.match(/<Id>(\d+)<\/Id>/)?.[1]);
			const webEnv = rawData.match(/<WebEnv>([^<]+)<\/WebEnv>/)?.[1];
			const queryKey = rawData.match(/<QueryKey>(\d+)<\/QueryKey>/)?.[1];
			
			return {
				count: count ? parseInt(count) : 0,
				ids: idList || [],
				webEnv,
				queryKey,
				raw: rawData
			};
		}
		
		if (format === "xml" && toolName.includes("ESummary")) {
			// Extract key fields from summary XML
			const summaries: any[] = [];
			const docSumPattern = /<DocSum>([\s\S]*?)<\/DocSum>/g;
			let match;
			
			while ((match = docSumPattern.exec(rawData)) !== null) {
				const docSum = match[1];
				const id = docSum.match(/<Id>(\d+)<\/Id>/)?.[1];
				const title = docSum.match(/<Item Name="Title"[^>]*>([^<]+)<\/Item>/)?.[1];
				const authors = docSum.match(/<Item Name="AuthorList"[^>]*>([^<]+)<\/Item>/)?.[1];
				const pubDate = docSum.match(/<Item Name="PubDate"[^>]*>([^<]+)<\/Item>/)?.[1];
				const source = docSum.match(/<Item Name="Source"[^>]*>([^<]+)<\/Item>/)?.[1];
				
				if (id) {
					summaries.push({
						id,
						title: title?.trim(),
						authors: authors?.trim(),
						pubDate: pubDate?.trim(),
						source: source?.trim()
					});
				}
			}
			
			return {
				summaries,
				count: summaries.length,
				raw: rawData
			};
		}
		
		return { raw: rawData };
	}

	// Batch processing support for ID-based operations
	private async processBatchIds(ids: string[], batchSize: number, processor: (batch: string[]) => Promise<any>): Promise<any[]> {
		const results: any[] = [];
		const batches: string[][] = [];
		
		// Create batches
		for (let i = 0; i < ids.length; i += batchSize) {
			batches.push(ids.slice(i, i + batchSize));
		}
		
		// Process batches with rate limiting
		for (const batch of batches) {
			try {
				const result = await processor(batch);
				results.push(result);
				
				// Add delay between batches to respect rate limits
				if (batches.indexOf(batch) < batches.length - 1) {
					const delay = this.getApiKey() ? 100 : 350; // 10/sec with key, ~3/sec without
					await new Promise(resolve => setTimeout(resolve, delay));
				}
			} catch (error) {
				results.push({
					error: error instanceof Error ? error.message : String(error),
					batch
				});
			}
		}
		
		return results;
	}

	// Intelligent query builder with field optimization
	private buildOptimizedQuery(term: string, field?: string, filters?: { mindate?: string; maxdate?: string; rettype?: string[] }): string {
		let query = term.trim();
		
		// Apply field restriction if specified
		if (field) {
			query = `${query}[${field}]`;
		}
		
		// Add date filters
		if (filters?.mindate || filters?.maxdate) {
			const dateFilter = [];
			if (filters.mindate) dateFilter.push(filters.mindate);
			if (filters.maxdate) dateFilter.push(filters.maxdate);
			query += ` AND ${dateFilter.join(":")}[Date - Publication]`;
		}
		
		// Add publication type filters
		if (filters?.rettype && filters.rettype.length > 0) {
			const typeFilter = filters.rettype.map(type => `${type}[Publication Type]`).join(" OR ");
			query += ` AND (${typeFilter})`;
		}
		
		return query;
	}

	// Cache for frequently accessed data
	private cache: Map<string, { data: any; timestamp: number }> = new Map();
	private CACHE_TTL = 300000; // 5 minutes

	private getCached(key: string): any | null {
		const cached = this.cache.get(key);
		if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
			return cached.data;
		}
		this.cache.delete(key);
		return null;
	}

	private setCached(key: string, data: any): void {
		this.cache.set(key, { data, timestamp: Date.now() });
		
		// Clean old entries if cache gets too large
		if (this.cache.size > 100) {
			const now = Date.now();
			for (const [k, v] of this.cache.entries()) {
				if (now - v.timestamp > this.CACHE_TTL) {
					this.cache.delete(k);
				}
			}
		}
	}

	// Format helper for better output presentation
	private formatOutput(data: any, format: "summary" | "detailed" | "raw" = "summary"): string {
		if (format === "raw") {
			return typeof data === "string" ? data : JSON.stringify(data, null, 2);
		}
		
		if (format === "summary" && data.summaries) {
			return data.summaries.map((item: any, index: number) => 
				`${index + 1}. ${item.title || "No title"}\n` +
				`   ID: ${item.id}\n` +
				`   Authors: ${item.authors || "N/A"}\n` +
				`   Date: ${item.pubDate || "N/A"}\n` +
				`   Source: ${item.source || "N/A"}`
			).join("\n\n");
		}
		
		if (format === "detailed") {
			// Recursive formatter for nested objects
			const formatObject = (obj: any, indent: number = 0): string => {
				const spaces = " ".repeat(indent);
				if (typeof obj !== "object" || obj === null) {
					return `${spaces}${obj}`;
				}
				
				return Object.entries(obj)
					.filter(([key]) => key !== "raw") // Skip raw data in detailed view
					.map(([key, value]) => {
						if (Array.isArray(value)) {
							return `${spaces}${key}: [${value.length} items]\n${value.map(v => formatObject(v, indent + 2)).join("\n")}`;
						} else if (typeof value === "object") {
							return `${spaces}${key}:\n${formatObject(value, indent + 2)}`;
						}
						return `${spaces}${key}: ${value}`;
					})
					.join("\n");
			};
			
			return formatObject(data);
		}
		
		return this.formatOutput(data, "raw");
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

		// Enhanced Search and Summary - Combines ESearch and ESummary for efficiency
		this.server.tool(
			"search_and_summarize",
			{
				db: z.string().default("pubmed").describe("Database to search"),
				term: z.string().describe("Search query"),
				retmax: z.number().optional().default(20).describe("Maximum results to return"),
				sort: z.string().optional().describe("Sort method (e.g., 'relevance', 'pub_date')"),
				mindate: z.string().optional().describe("Minimum date (YYYY/MM/DD)"),
				maxdate: z.string().optional().describe("Maximum date (YYYY/MM/DD)"),
				field: z.string().optional().describe("Search field limitation"),
				output_format: z.enum(["summary", "detailed", "ids_only"]).default("summary").describe("Output format"),
			},
			async ({ db, term, retmax, sort, mindate, maxdate, field, output_format }) => {
				try {
					// Check cache first
					const cacheKey = `search_summary:${db}:${term}:${retmax}:${sort}`;
					const cached = this.getCached(cacheKey);
					if (cached) {
						return {
							content: [
								{
									type: "text",
									text: `[CACHED] ${cached}`
								}
							]
						};
					}

					// Build optimized query
					const optimizedQuery = this.buildOptimizedQuery(term, field, { mindate, maxdate });
					
					// Step 1: Search
					const searchParams = new URLSearchParams({
						db: db || "pubmed",
						term: optimizedQuery,
						retmax: retmax?.toString() || "20",
						tool: this.defaultTool,
						email: this.defaultEmail,
						retmode: "json",
						usehistory: "y"
					});

					if (sort) searchParams.append("sort", sort);
					if (mindate) searchParams.append("mindate", mindate);
					if (maxdate) searchParams.append("maxdate", maxdate);

					const searchUrl = this.buildUrl("esearch.fcgi", searchParams);
					const searchResponse = await fetch(searchUrl);
					const searchData = await this.parseAndStructureResponse(searchResponse, "ESearch", "json");

					if (!searchData || !searchData.esearchresult || searchData.esearchresult.count === "0") {
						const result = "No results found for your search query.";
						this.setCached(cacheKey, result);
						return {
							content: [
								{
									type: "text",
									text: result
								}
							]
						};
					}

					const idList = searchData.esearchresult.idlist || [];
					const totalCount = parseInt(searchData.esearchresult.count || "0");
					
					if (output_format === "ids_only") {
						const result = `Found ${totalCount} results. Showing first ${idList.length} IDs:\n${idList.join(", ")}`;
						this.setCached(cacheKey, result);
						return {
							content: [
								{
									type: "text",
									text: result
								}
							]
						};
					}

					// Step 2: Get summaries using history
					const summaryParams = new URLSearchParams({
						db: db || "pubmed",
						query_key: searchData.esearchresult.querykey || "1",
						WebEnv: searchData.esearchresult.webenv || "",
						retmax: retmax?.toString() || "20",
						tool: this.defaultTool,
						email: this.defaultEmail,
						retmode: "xml",
						version: "2.0"
					});

					const summaryUrl = this.buildUrl("esummary.fcgi", summaryParams);
					const summaryResponse = await fetch(summaryUrl);
					const summaryData = await this.parseAndStructureResponse(summaryResponse, "ESummary", "xml");

					// Format output
					let result = `Search Results: ${totalCount} total (showing ${Math.min(retmax || 20, totalCount)})\n\n`;
					
					if (output_format === "detailed") {
						result += this.formatOutput(summaryData, "detailed");
					} else {
						result += this.formatOutput(summaryData, "summary");
					}

					// Add search metadata
					result += `\n\n---\nSearch Query: "${term}"`;
					if (field) result += ` in field: ${field}`;
					if (mindate || maxdate) result += `\nDate Range: ${mindate || "*"} to ${maxdate || "*"}`;
					if (sort) result += `\nSorted by: ${sort}`;

					this.setCached(cacheKey, result);
					
					return {
						content: [
							{
								type: "text",
								text: result
							}
						]
					};
				} catch (error) {
					return {
						content: [
							{
								type: "text",
								text: `Error in Search and Summarize: ${error instanceof Error ? error.message : String(error)}`
							}
						]
					};
				}
			}
		);

		// Batch Fetch - Efficiently fetch multiple records
		this.server.tool(
			"batch_fetch",
			{
				db: z.string().default("pubmed").describe("Database name"),
				ids: z.string().describe("Comma-separated list of IDs (or 'file:path' to read from file)"),
				rettype: z.string().optional().describe("Retrieval type"),
				retmode: z.string().optional().describe("Retrieval mode"),
				batch_size: z.number().optional().default(200).describe("Number of IDs per batch"),
			},
			async ({ db, ids, rettype, retmode, batch_size }) => {
				try {
					// Parse IDs
					let idList: string[];
					if (ids.startsWith("file:")) {
						// In a real implementation, you'd read from file
						throw new Error("File reading not implemented in this environment");
					} else {
						idList = ids.split(',').map(id => id.trim()).filter(id => id !== '');
					}

					if (idList.length === 0) {
						throw new Error("No valid IDs provided");
					}

					const results = await this.processBatchIds(idList, batch_size, async (batch) => {
						const params = new URLSearchParams({
							db: db || "pubmed",
							id: batch.join(','),
							tool: this.defaultTool,
							email: this.defaultEmail,
						});

						if (rettype) params.append("rettype", rettype);
						if (retmode) params.append("retmode", retmode);

						const url = this.buildUrl("efetch.fcgi", params);
						const response = await fetch(url);
						return this.parseResponse(response, "Batch EFetch");
					});

					return {
						content: [
							{
								type: "text",
								text: `Batch Fetch Results:\n\nProcessed ${idList.length} IDs in ${results.length} batches.\n\n${results.map((r, i) => `Batch ${i + 1}:\n${r}`).join("\n\n---\n\n")}`
							}
						]
					};
				} catch (error) {
					return {
						content: [
							{
								type: "text",
								text: `Error in Batch Fetch: ${error instanceof Error ? error.message : String(error)}`
							}
						]
					};
				}
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
					const structuredData = await this.parseAndStructureResponse(response, "ESearch", retmode || "xml");

					// Format the response based on the data structure
					let formattedResult = `ESearch Results for "${term}" in ${db}:\n\n`;
					
					if (structuredData.count !== undefined) {
						formattedResult += `Total Results: ${structuredData.count}\n`;
						if (structuredData.ids && structuredData.ids.length > 0) {
							formattedResult += `IDs Retrieved: ${structuredData.ids.length}\n`;
							formattedResult += `ID List: ${structuredData.ids.join(", ")}\n`;
						}
						if (structuredData.webEnv) {
							formattedResult += `\nWeb Environment: ${structuredData.webEnv}\n`;
							formattedResult += `Query Key: ${structuredData.queryKey ?? "N/A"}\n`;
							formattedResult += `(Use these for history-based operations)\n`;
						}
					} else {
						// Fallback to raw output if structure parsing failed
						formattedResult += structuredData.raw || JSON.stringify(structuredData);
					}

					return {
						content: [
							{
								type: "text",
								text: formattedResult
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
					const structuredData = await this.parseAndStructureResponse(response, "ESummary", retmode || "xml");

					// Format the response based on the data structure
					let formattedResult = `ESummary Results for ${cleanIds.length} IDs in ${db}:\n\n`;
					
					if (structuredData.summaries && structuredData.summaries.length > 0) {
						formattedResult += this.formatOutput(structuredData, "summary");
						formattedResult += `\n\nTotal summaries retrieved: ${structuredData.count}`;
					} else {
						// Fallback to raw output if structure parsing failed
						formattedResult += structuredData.raw || JSON.stringify(structuredData);
					}

					return {
						content: [
							{
								type: "text",
								text: formattedResult
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

		// EFetch - Download complete data records
		this.server.tool(
			"efetch",
			{
				db: z.string().default("pubmed").describe("Database name"),
				id: z.string().describe("Comma-separated list of UIDs"),
				rettype: z.string().optional().describe("Retrieval type (e.g., 'abstract', 'fasta', 'gb')"),
				retmode: z.string().optional().describe("Retrieval mode (e.g., 'text', 'xml')"),
				retstart: z.number().optional().describe("Starting position"),
				retmax: z.number().optional().describe("Maximum number of records"),
				strand: z.enum(["1", "2"]).optional().describe("DNA strand (1=plus, 2=minus)"),
				seq_start: z.number().optional().describe("First sequence base to retrieve"),
				seq_stop: z.number().optional().describe("Last sequence base to retrieve"),
				complexity: z.enum(["0", "1", "2", "3", "4"]).optional().describe("Data complexity level"),
			},
			async ({ db, id, rettype, retmode, retstart, retmax, strand, seq_start, seq_stop, complexity }) => {
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

					// Database-specific validation
					const dbName = db || "pubmed";
					if (dbName === "pubmed" && (rettype === "fasta" || seq_start || seq_stop)) {
						throw new Error("FASTA format and sequence parameters not supported for PubMed database");
					}
					if ((dbName === "protein" || dbName === "nuccore") && rettype === "abstract") {
						throw new Error("Abstract format not supported for sequence databases");
					}

					const params = new URLSearchParams({
						db: dbName,
						id: cleanIds.join(','),
						tool: this.defaultTool,
						email: this.defaultEmail,
					});

					// Add optional parameters with validation
					if (rettype) {
						// Validate rettype for specific databases
						const validRetTypes: Record<string, string[]> = {
							"pubmed": ["abstract", "medline", "xml"],
							"pmc": ["medline", "xml"],
							"protein": ["fasta", "gb", "gp", "xml"],
							"nuccore": ["fasta", "gb", "xml"],
							"nucleotide": ["fasta", "gb", "xml"]
						};
						
						if (validRetTypes[dbName] && !validRetTypes[dbName].includes(rettype)) {
							throw new Error(`Invalid rettype '${rettype}' for database '${dbName}'. Valid types: ${validRetTypes[dbName].join(', ')}`);
						}
						params.append("rettype", rettype);
					}
					
					if (retmode) params.append("retmode", retmode);
					if (retstart !== undefined) params.append("retstart", retstart.toString());
					if (retmax !== undefined) params.append("retmax", retmax.toString());
					
					// Sequence-specific parameters (only for sequence databases)
					if (dbName === "protein" || dbName === "nuccore" || dbName === "nucleotide") {
						if (strand) params.append("strand", strand);
						if (seq_start !== undefined) params.append("seq_start", seq_start.toString());
						if (seq_stop !== undefined) params.append("seq_stop", seq_stop.toString());
						if (complexity) params.append("complexity", complexity);
					}

					const url = this.buildUrl("efetch.fcgi", params);
					const response = await fetch(url);
					const data = await this.parseResponse(response, "EFetch");

					return {
						content: [
							{
								type: "text",
								text: `EFetch Results:\n\n${data}`
							}
						]
					};
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

					// Extract RID from response
					const ridMatch = data.match(/RID = (\w+)/);
					const estimatedTimeMatch = data.match(/RTOE = (\d+)/);
					
					if (ridMatch) {
						const rid = ridMatch[1];
						const estimatedTime = estimatedTimeMatch ? parseInt(estimatedTimeMatch[1]) : 60;
						
						return {
							content: [
								{
									type: "text",
									text: `BLAST Search Submitted Successfully!\n\n` +
										`Request ID (RID): ${rid}\n` +
										`Estimated completion time: ${estimatedTime} seconds\n\n` +
										`To retrieve results, use blast_get with RID: ${rid}\n\n` +
										`Note: The search is processing. Wait at least ${Math.ceil(estimatedTime / 2)} seconds before checking results.`
								}
							]
						};
					}

					// Fallback if RID not found
					return {
						content: [
							{
								type: "text",
								text: `BLAST Submit Response:\n\n${data}`
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
											text: `BLAST search status: Still processing\n\n` +
												`RID: ${rid}\n` +
												`Status: WAITING\n` +
												`Attempts: ${maxRetries}/${maxRetries}\n\n` +
												`The search is taking longer than expected. You can:\n` +
												`1. Try again in a few minutes using the same RID\n` +
												`2. Check the NCBI BLAST website directly with your RID`
										}
									]
								};
							}
						}

						// Check for completion status
						if (data.includes("Status=READY")) {
							// Parse key information from BLAST results
							const hitCountMatch = data.match(/<Hits>.*?<\/Hits>/s);
							const numHits = hitCountMatch ? (hitCountMatch[0].match(/<Hit>/g) || []).length : 0;
							
							return {
								content: [
									{
										type: "text",
										text: `BLAST Results Retrieved Successfully!\n\n` +
											`RID: ${rid}\n` +
											`Status: READY\n` +
											`Number of hits found: ${numHits}\n` +
											`Format: ${format_type}\n\n` +
											`Full Results:\n${"=".repeat(50)}\n${data}`
									}
								]
							};
						}

						// Check for errors
						if (data.includes("Status=FAILED") || data.includes("Error")) {
							return {
								content: [
									{
										type: "text",
										text: `BLAST search failed!\n\n` +
											`RID: ${rid}\n` +
											`Status: FAILED\n\n` +
											`Error details:\n${data}`
									}
								]
							};
						}
		
						// Unknown status - return raw response
						return {
							content: [
								{
									type: "text",
									text: `BLAST Results (Unknown Status):\n\n${data}`
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

					// Format based on operation and output format
					let formattedResult = `PubChem Compound Results\n`;
					formattedResult += `Identifier: ${identifier} (${identifier_type})\n`;
					formattedResult += `Operation: ${operation}\n\n`;

					if (output_format === "json" && operation === "property") {
						try {
							const jsonData = JSON.parse(data);
							if (jsonData.PropertyTable && jsonData.PropertyTable.Properties) {
								const props = jsonData.PropertyTable.Properties[0];
								formattedResult += "Properties:\n";
								for (const [key, value] of Object.entries(props)) {
									if (key !== "CID") {
										formattedResult += `  ${key}: ${value}\n`;
									}
								}
							}
						} catch {
							formattedResult += data;
						}
					} else if (output_format === "json" && operation === "synonyms") {
						try {
							const jsonData = JSON.parse(data);
							if (jsonData.InformationList && jsonData.InformationList.Information) {
								const info = jsonData.InformationList.Information[0];
								if (info.Synonym) {
									formattedResult += `Found ${info.Synonym.length} synonyms:\n`;
									formattedResult += info.Synonym.slice(0, 10).join(", ");
									if (info.Synonym.length > 10) {
										formattedResult += `, ... (and ${info.Synonym.length - 10} more)`;
									}
								}
							}
						} catch {
							formattedResult += data;
						}
					} else {
						formattedResult += data;
					}

					return {
						content: [
							{
								type: "text",
								text: formattedResult
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

		// PubChem Quick Lookup - Combined search and property retrieval
		this.server.tool(
			"pubchem_quick_lookup",
			{
				query: z.string().describe("Compound name, SMILES, InChI, or CID"),
				properties: z.array(z.string()).optional().default(["MolecularFormula", "MolecularWeight", "IUPACName", "CanonicalSMILES", "IsomericSMILES"]).describe("Properties to retrieve"),
				include_synonyms: z.boolean().optional().default(true).describe("Include common synonyms"),
				include_description: z.boolean().optional().default(true).describe("Include compound description"),
			},
			async ({ query, properties, include_synonyms, include_description }) => {
				try {
					// Determine identifier type
					let identifierType = "name"; // default
					let identifier = query.trim();
					
					// Check if it's a CID (all digits)
					if (/^\d+$/.test(identifier)) {
						identifierType = "cid";
					} else if (identifier.startsWith("InChI=")) {
						identifierType = "inchi";
					} else if (identifier.includes("[") && identifier.includes("]")) {
						identifierType = "smiles";
					}

					// Step 1: Get CID if needed
					let cid = identifier;
					if (identifierType !== "cid") {
						const cidUrl = `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/${identifierType}/${encodeURIComponent(identifier)}/cids/JSON`;
						const cidResponse = await fetch(cidUrl);
						
						if (!cidResponse.ok) {
							throw new Error(`Compound not found: ${query}`);
						}
						
						const cidData = await cidResponse.json();
						if (cidData.IdentifierList && cidData.IdentifierList.CID && cidData.IdentifierList.CID.length > 0) {
							cid = cidData.IdentifierList.CID[0].toString();
						} else {
							throw new Error(`No compounds found for: ${query}`);
						}
					}

					// Parallel requests for efficiency
					const requests: Promise<any>[] = [];
					
					// Get properties
					if (properties && properties.length > 0) {
						const propsUrl = `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid/${cid}/property/${properties.join(",")}/JSON`;
						requests.push(fetch(propsUrl).then(r => r.json()));
					}
					
					// Get synonyms
					if (include_synonyms) {
						const synonymsUrl = `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid/${cid}/synonyms/JSON`;
						requests.push(fetch(synonymsUrl).then(r => r.json()));
					}
					
					// Get description
					if (include_description) {
						const descUrl = `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid/${cid}/description/JSON`;
						requests.push(fetch(descUrl).then(r => r.json()).catch(() => null));
					}

					const results = await Promise.all(requests);
					
					// Format results
					let formattedResult = `PubChem Quick Lookup Results\n`;
					formattedResult += `${"=".repeat(50)}\n\n`;
					formattedResult += `Query: "${query}"\n`;
					formattedResult += `PubChem CID: ${cid}\n`;
					formattedResult += `Direct Link: https://pubchem.ncbi.nlm.nih.gov/compound/${cid}\n\n`;

					// Add properties
					if (properties && properties.length > 0 && results[0]) {
						const propsData = results[0];
						if (propsData.PropertyTable && propsData.PropertyTable.Properties && propsData.PropertyTable.Properties[0]) {
							const props = propsData.PropertyTable.Properties[0];
							formattedResult += "Chemical Properties:\n";
							for (const [key, value] of Object.entries(props)) {
								if (key !== "CID") {
									formattedResult += `  ${key}: ${value}\n`;
								}
							}
							formattedResult += "\n";
						}
					}

					// Add synonyms
					if (include_synonyms && results[1]) {
						const synonymsData = results[include_description ? 1 : 1];
						if (synonymsData.InformationList && synonymsData.InformationList.Information && synonymsData.InformationList.Information[0]) {
							const synonymsList = synonymsData.InformationList.Information[0].Synonym || [];
							formattedResult += `Common Names (${Math.min(10, synonymsList.length)} of ${synonymsList.length}):\n`;
							formattedResult += `  ${synonymsList.slice(0, 10).join(", ")}\n\n`;
						}
					}

					// Add description
					if (include_description && results[results.length - 1]) {
						const descData = results[results.length - 1];
						if (descData && descData.InformationList && descData.InformationList.Information) {
							const info = descData.InformationList.Information[0];
							if (info && info.Description) {
								formattedResult += "Description:\n";
								formattedResult += `  ${info.Description.substring(0, 500)}`;
								if (info.Description.length > 500) {
									formattedResult += "...";
								}
								formattedResult += "\n";
							}
						}
					}

					return {
						content: [
							{
								type: "text",
								text: formattedResult
							}
						]
					};
				} catch (error) {
					return {
						content: [
							{
								type: "text",
								text: `Error in PubChem Quick Lookup: ${error instanceof Error ? error.message : String(error)}`
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

		return new Response("Complete NCBI APIs MCP Server - Including E-utilities, BLAST, PubChem PUG, and PMC APIs", { 
			status: 200,
			headers: { "Content-Type": "text/plain" }
		});
	},
};
