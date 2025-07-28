import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import JSZip from "jszip";
import { JsonToSqlDO } from "./do.js";
import { getParserFor } from "./lib/parsers.js";
import { ToolRegistry } from "./tools/index.js";
import type { ToolContext } from "./tools/index.js";

// Define our MCP agent for NCBI Entrez E-utilities
export class EntrezMCP extends McpAgent implements ToolContext {
	server = new McpServer({
		name: "Complete NCBI APIs MCP Server",
		version: "1.0.0",
		description: "A comprehensive MCP server for E-utilities, BLAST, PubChem, and PMC, with advanced data staging capabilities.",
	});

	baseUrl = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/";
	defaultEmail = "entrez-mcp-server@example.com";
	defaultTool = "entrez-mcp-server";

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
	getApiKey(): string | undefined {
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
	getEnvironment(): Env | undefined {
		return this.workerEnv || EntrezMCP.currentEnv;
	}

	// Helper method to validate database names
	isValidDatabase(db: string): boolean {
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
	async parseResponse(response: Response, toolName: string, requestedRetmode?: string): Promise<string | any> {
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
		if (lowerData.includes("<e>") || lowerData.includes('"error"') || lowerData.includes("error")) {
			// Capture NCBI error messages accurately
			const errorMatch =
				// Match XML error tags like <e> or <e>
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
	formatResponseData(data: any): string {
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
	buildUrl(endpoint: string, params: URLSearchParams): string {
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
	shouldBypassStaging(entities: any[], diagnostics: any, payloadSize: number): { bypass: boolean; reason: string } {
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
		// Register all tools using the new tool registry
		const toolRegistry = new ToolRegistry(this);
		toolRegistry.registerAll();
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
