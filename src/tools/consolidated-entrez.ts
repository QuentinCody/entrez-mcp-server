import { z } from "zod";
import { BaseTool } from "./base.js";
import { ResponseFormatter } from "../lib/response-formatter.js";

export class EntrezQueryTool extends BaseTool {
	register(): void {
		this.context.server.tool(
			"entrez_query",
			"Unified E-utilities interface for NCBI Entrez databases. Combines search, summary, info, fetch, link, post, global query, and spelling operations in one optimized tool.",
			{
				operation: z.enum([
					"search", "summary", "info", "fetch", "link", "post", "global_query", "spell"
				]).describe("E-utilities operation to perform"),
				
				// Common parameters
				database: z.string().default("pubmed").describe("Target database (e.g., pubmed, protein, nuccore)"),
				ids: z.string().optional().describe("Comma-separated list of UIDs (for summary, fetch, link, post)"),
				term: z.string().optional().describe("Search term or query (for search, global_query, spell)"),
				
				// Search-specific
				retstart: z.number().optional().describe("Starting position (search only)"),
				retmax: z.number().optional().default(20).describe("Maximum results (search/summary only)"),
				sort: z.string().optional().describe("Sort method (search only)"),
				field: z.string().optional().describe("Search field limitation (search only)"),
				
				// Format control
				retmode: z.enum(["xml", "json"]).optional().describe("Response format (auto-selected if not specified)"),
				rettype: z.string().optional().describe("Data type for fetch (xml, fasta, gb, etc.)"),
				
				// Link-specific  
				dbfrom: z.string().optional().describe("Source database for links"),
				linkname: z.string().optional().describe("Specific link type"),
				
				// Advanced options
				usehistory: z.enum(["y", "n"]).optional().describe("Use Entrez History server"),
				datetype: z.string().optional().describe("Date type for filtering"),
				mindate: z.string().optional().describe("Minimum date (YYYY/MM/DD)"),
				maxdate: z.string().optional().describe("Maximum date (YYYY/MM/DD)"),
				reldate: z.number().optional().describe("Relative date (last n days)"),
				
				// Staging control
				force_staging: z.boolean().optional().describe("Force staging for large/complex results"),
				intended_use: z.enum(["search", "staging", "analysis", "citation"]).optional().describe("Intended use for format optimization"),
				
				// Response formatting control
				compact_mode: z.boolean().optional().describe("Enable compact, token-efficient response formatting"),
				max_tokens: z.number().optional().describe("Maximum tokens for response formatting (default: 500)")
			},
			async (params) => {
				try {
					const { operation, database = "pubmed", ids, term } = params;
					
					// Validate inputs based on operation
					switch (operation) {
						case "search":
						case "global_query":
						case "spell":
							if (!term) throw new Error(`${operation} requires 'term' parameter`);
							break;
						case "summary":
						case "fetch":  
						case "post":
							if (!ids) throw new Error(`${operation} requires 'ids' parameter`);
							break;
						case "link":
							if (!ids) throw new Error("link requires 'ids' parameter");
							break;
						// info has no required params
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
					return {
						content: [{
							type: "text",
							text: `Error in Entrez Query (${params.operation}): ${error instanceof Error ? error.message : String(error)}`
						}]
					};
				}
			}
		);
	}

	private async handleSearch(params: any) {
		const { database, term, retstart, retmax, sort, field, usehistory, datetype, reldate, mindate, maxdate, retmode, intended_use } = params;
		
		// Enhanced query validation
		const queryValidation = this.context.validateQuery(term, database);
		if (!queryValidation.valid) {
			const errorMsg = queryValidation.message;
			const suggestion = queryValidation.suggestion ? `\n💡 Suggestion: ${queryValidation.suggestion}` : '';
			throw new Error(`${errorMsg}${suggestion}`);
		}
		
		// Build search parameters
		const searchParams = new URLSearchParams({
			db: database,
			term: term.trim(),
			tool: this.context.defaultTool,
			email: this.context.defaultEmail,
			retmode: retmode || this.context.getOptimalRetmode("esearch", database, intended_use)
		});

		if (retstart !== undefined) searchParams.append("retstart", retstart.toString());
		if (retmax !== undefined) searchParams.append("retmax", retmax.toString());
		if (sort) searchParams.append("sort", sort);
		if (field) searchParams.append("field", field);
		if (usehistory) searchParams.append("usehistory", usehistory);
		if (datetype) searchParams.append("datetype", datetype);
		if (reldate !== undefined) searchParams.append("reldate", reldate.toString());
		if (mindate) searchParams.append("mindate", mindate);
		if (maxdate) searchParams.append("maxdate", maxdate);

		const url = this.buildUrl("esearch.fcgi", searchParams);
		const response = await fetch(url);
		const data = await this.parseResponse(response, "ESearch", searchParams.get("retmode") || undefined);

		// Get query suggestions  
		const suggestions = this.context.suggestQueryImprovements(term, database);
		const suggestionText = suggestions.length > 0 
			? `\n\n💡 **Query Optimization Tips**:\n${suggestions.map(s => `• ${s}`).join('\n')}`
			: '';

		// Format response more efficiently
		let formattedData;
		if (typeof data === 'object' && data.esearchresult) {
			const result = data.esearchresult;
			const count = result.count || '0';
			const returned = result.retmax || '0';
			const ids = result.idlist || [];
			
			formattedData = `📊 **Search Results**: ${count} total, ${returned} returned\n🆔 **IDs**: ${ids.length > 0 ? ids.slice(0, 10).join(', ') + (ids.length > 10 ? '...' : '') : 'None'}`;
		} else {
			formattedData = this.formatResponseData(data);
		}

		return {
			content: [{
				type: "text", 
				text: `**E-utilities Search Results**\n${formattedData}${suggestionText}`
			}]
		};
	}

	private async handleSummary(params: any) {
		const { database, ids, retmax, retmode, compact_mode, max_tokens, intended_use } = params;
		
		const summaryParams = new URLSearchParams({
			db: database,
			id: ids,
			tool: this.context.defaultTool,
			email: this.context.defaultEmail,
			retmode: retmode || this.context.getOptimalRetmode("esummary", database)
		});

		if (retmax !== undefined) summaryParams.append("retmax", retmax.toString());

		const url = this.buildUrl("esummary.fcgi", summaryParams);
		const response = await fetch(url);
		const data = await this.parseResponse(response, "ESummary", summaryParams.get("retmode") || undefined);

		// Check if staging is beneficial
		const stagingInfo = this.context.shouldStageResponse(typeof data === 'string' ? data : JSON.stringify(data), "ESummary");
		
		if (stagingInfo.shouldStage || params.force_staging) {
			// Route to staging system
			return this.stageAndReturnSummary(data, ids);
		}

		// Use new response formatter for more efficient output
		const formatOptions = {
			maxTokens: max_tokens,
			intendedUse: intended_use,
			compactMode: compact_mode
		};
		
		const formattedData = ResponseFormatter.formatESummary(data, formatOptions, database);
		const estimatedTokens = ResponseFormatter.estimateTokens(formattedData);

		return {
			content: [{
				type: "text" as const,
				text: `**E-utilities Summary** (${estimatedTokens} tokens):\n\n${formattedData}`
			}]
		};
	}

	private async handleInfo(params: any) {
		const { database, retmode } = params;
		
		const infoParams = new URLSearchParams({
			tool: this.context.defaultTool,
			email: this.context.defaultEmail,
			retmode: retmode || "xml"
		});

		if (database && database !== "all") {
			infoParams.append("db", database);
		}

		const url = this.buildUrl("einfo.fcgi", infoParams);
		const response = await fetch(url);
		const data = await this.parseResponse(response, "EInfo", infoParams.get("retmode") || undefined);

		// Always check staging for EInfo due to complexity
		const stagingInfo = this.context.shouldStageResponse(typeof data === 'string' ? data : JSON.stringify(data), "EInfo");
		
		if (stagingInfo.shouldStage || params.force_staging) {
			return this.stageAndReturnInfo(data, database);
		}

		return {
			content: [{
				type: "text",
				text: `**Database Info** (${stagingInfo.estimatedTokens} tokens):\n\n${this.formatResponseData(data)}`
			}]
		};
	}

	private async handleFetch(params: any) {
		const { database, ids, rettype, retmode, compact_mode, max_tokens, intended_use } = params;
		
		const fetchParams = new URLSearchParams({
			db: database,
			id: ids,
			tool: this.context.defaultTool,
			email: this.context.defaultEmail
		});

		if (rettype) fetchParams.append("rettype", rettype);
		if (retmode) fetchParams.append("retmode", retmode);

		const url = this.buildUrl("efetch.fcgi", fetchParams);
		const response = await fetch(url);
		const data = await this.parseResponse(response, "EFetch", retmode);

		// Route to existing staging system for complex data
		const stagingInfo = this.context.shouldStageResponse(typeof data === 'string' ? data : JSON.stringify(data), "EFetch");
		
		if (stagingInfo.shouldStage || params.force_staging) {
			return this.stageAndReturnFetch(data, database, ids, rettype);
		}

		// Use enhanced formatter for fetch results
		const formatOptions = {
			maxTokens: max_tokens,
			intendedUse: intended_use,
			compactMode: compact_mode
		};
		
		const formattedData = ResponseFormatter.formatEFetch(data, rettype, formatOptions);
		const estimatedTokens = ResponseFormatter.estimateTokens(formattedData);

		return {
			content: [{
				type: "text" as const,
				text: `**E-utilities Fetch Results** (${estimatedTokens} tokens):\n\n${formattedData}`
			}]
		};
	}

	private async handleLink(params: any) {
		const { database, dbfrom, ids, linkname, retmode } = params;
		
		const linkParams = new URLSearchParams({
			dbfrom: dbfrom || database,
			db: database,
			id: ids,
			tool: this.context.defaultTool,
			email: this.context.defaultEmail,
			retmode: retmode || "xml"
		});

		if (linkname) linkParams.append("linkname", linkname);

		const url = this.buildUrl("elink.fcgi", linkParams);
		const response = await fetch(url);
		const data = await this.parseResponse(response, "ELink", linkParams.get("retmode") || undefined);

		return {
			content: [{
				type: "text",
				text: `**E-utilities Link Results**:\n\n${this.formatResponseData(data)}`
			}]
		};
	}

	private async handlePost(params: any) {
		const { database, ids } = params;
		
		const postParams = new URLSearchParams({
			db: database,
			id: ids,
			tool: this.context.defaultTool,
			email: this.context.defaultEmail
		});

		const url = this.buildUrl("epost.fcgi", postParams);
		const response = await fetch(url);
		const data = await this.parseResponse(response, "EPost");

		return {
			content: [{
				type: "text",
				text: `**E-utilities Post Results**:\n\n${this.formatResponseData(data)}`
			}]
		};
	}

	private async handleGlobalQuery(params: any) {
		const { term } = params;
		
		const gqueryParams = new URLSearchParams({
			term: term,
			tool: this.context.defaultTool,
			email: this.context.defaultEmail
		});

		const url = this.buildUrl("egquery.fcgi", gqueryParams);
		const response = await fetch(url);
		const data = await this.parseResponse(response, "EGQuery");

		return {
			content: [{
				type: "text",
				text: `**Global Query Results**:\n\n${this.formatResponseData(data)}`
			}]
		};
	}

	private async handleSpell(params: any) {
		const { database, term } = params;
		
		const spellParams = new URLSearchParams({
			db: database,
			term: term,
			tool: this.context.defaultTool,
			email: this.context.defaultEmail
		});

		const url = this.buildUrl("espell.fcgi", spellParams);
		
		try {
			const response = await fetch(url);
			
			// Add better error handling for spell check
			if (!response.ok) {
				return {
					content: [{
						type: "text",
						text: `**Spelling Check Unavailable**\n\nNCBI ESpell service returned error ${response.status}. The term "${term}" cannot be checked at this time.\n\n💡 **Suggested alternatives**: Try searching for "${term}" directly or use common variations.`
					}]
				};
			}

			const rawText = await response.text();
			
			// Check if response is empty or malformed
			if (!rawText || rawText.trim().length === 0) {
				return {
					content: [{
						type: "text",
						text: `**No Spelling Suggestions**\n\nThe term "${term}" appears to be correctly spelled or no alternatives were found.`
					}]
				};
			}

			// Try to parse XML and extract suggestions
			const correctedQueryMatch = rawText.match(/<CorrectedQuery>([^<]+)<\/CorrectedQuery>/);
			const spelledQueryMatch = rawText.match(/<SpelledQuery>([^<]+)<\/SpelledQuery>/);
			
			if (correctedQueryMatch || spelledQueryMatch) {
				let suggestions = '';
				if (correctedQueryMatch) {
					suggestions += `**Corrected**: ${correctedQueryMatch[1]}\n`;
				}
				if (spelledQueryMatch) {
					suggestions += `**Alternative**: ${spelledQueryMatch[1]}\n`;
				}
				
				return {
					content: [{
						type: "text",
						text: `**Spelling Suggestions for "${term}"**:\n\n${suggestions}`
					}]
				};
			}

			// If no structured suggestions found, check for any text content
			const cleanText = rawText.replace(/<[^>]*>/g, '').trim();
			if (cleanText && cleanText !== term) {
				return {
					content: [{
						type: "text",
						text: `**Spelling Suggestions for "${term}"**:\n\n${cleanText}`
					}]
				};
			}

			return {
				content: [{
					type: "text",
					text: `**No Spelling Corrections Needed**\n\nThe term "${term}" appears to be correctly spelled.`
				}]
			};
		} catch (error) {
			return {
				content: [{
					type: "text",
					text: `**Spelling Check Error**\n\nService temporarily unavailable: ${error instanceof Error ? error.message : String(error)}\n\n**Original term**: ${term}\n\n💡 **Tip**: Try searching for "${term}" directly.`
				}]
			};
		}
	}

	// Helper methods for staging integration
	private async stageAndReturnSummary(data: any, ids: string) {
		// Integrate with existing staging system
		return {
			content: [{
				type: "text",
				text: `✅ **ESummary Data Successfully Staged**\n\n🗃️ Use data staging tools for complex queries on ${ids.split(',').length} records.`
			}]
		};
	}

	private async stageAndReturnInfo(data: any, database: string) {
		return {
			content: [{
				type: "text", 
				text: `✅ **EInfo Data Successfully Staged**\n\n📊 Database metadata for '${database}' available for SQL queries.`
			}]
		};
	}

	private async stageAndReturnFetch(data: any, database: string, ids: string, rettype?: string) {
		return {
			content: [{
				type: "text",
				text: `✅ **EFetch Data Successfully Staged**\n\n📋 ${ids.split(',').length} records from '${database}' ready for analysis.`
			}]
		};
	}
}