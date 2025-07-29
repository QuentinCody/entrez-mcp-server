import { z } from "zod";
import { BaseTool } from "./base.js";

export class ExternalAPIsTool extends BaseTool {
	register(): void {
		this.context.server.tool(
			"external_apis",
			"Unified interface for external NCBI services: BLAST sequence similarity, PubChem chemical data, and PMC full-text articles. Combines 9 specialized tools into one optimized interface.",
			{
				service: z.enum([
					"blast", "pubchem", "pmc"
				]).describe("External service to access"),
				
				operation: z.enum([
					// BLAST operations
					"submit", "get_results",
					// PubChem operations  
					"compound", "substance", "bioassay", "structure_search",
					// PMC operations
					"id_convert", "oa_service", "citation_export"
				]).describe("Service operation to perform"),
				
				// BLAST parameters
				query: z.string().optional().describe("BLAST query sequence (FASTA, accession, or GI)"),
				database_name: z.string().optional().describe("BLAST database (nt, nr, swissprot, etc.)"),
				program: z.enum(["blastn", "blastp", "blastx", "tblastn", "tblastx"]).optional().describe("BLAST program"),
				rid: z.string().optional().describe("BLAST Request ID for retrieving results"),
				expect: z.number().optional().default(10).describe("BLAST expect value threshold"),
				format_type: z.enum(["HTML", "Text", "XML2", "XML2_S", "JSON2", "JSON2_S", "SAM"]).optional().default("XML2").describe("BLAST output format"),
				
				// PubChem parameters
				identifier: z.string().optional().describe("Chemical identifier (name, CID, SID, etc.)"),
				identifier_type: z.enum([
					"cid", "name", "smiles", "inchi", "inchikey", "formula", // compound
					"sid", "sourceid", "xref", // substance  
					"aid", "listkey", "target", "activity" // bioassay
				]).optional().describe("Type of chemical identifier"),
				search_type: z.enum(["identity", "substructure", "superstructure", "similarity"]).optional().describe("Structure search type"),
				structure: z.string().optional().describe("Chemical structure (SMILES, InChI, SDF, MOL)"),
				structure_type: z.enum(["smiles", "inchi", "sdf", "mol"]).optional().describe("Structure input format"),
				threshold: z.number().optional().default(90).describe("Similarity threshold (0-100)"),
				
				// PMC parameters
				ids: z.string().optional().describe("PMC/PMID/DOI identifiers (comma-separated, up to 200)"),
				id: z.string().optional().describe("Single PMC/PMID/DOI identifier"),
				citation_format: z.enum(["ris", "nbib", "medline", "bibtex"]).optional().describe("Citation export format"),
				
				// Common parameters
				output_format: z.enum(["json", "xml", "csv", "txt", "sdf", "png"]).optional().default("json").describe("Response format"),
				max_records: z.number().optional().default(1000).describe("Maximum records to return"),
				versions: z.enum(["yes", "no"]).optional().default("no").describe("Include version information (PMC)")
			},
			async (params) => {
				try {
					const { service, operation } = params;
					
					// Validate service-operation combinations
					this.validateServiceOperation(service, operation);
					
					// Route to appropriate service handler
					switch (service) {
						case "blast":
							return await this.handleBLAST(operation, params);
						case "pubchem":
							return await this.handlePubChem(operation, params);
						case "pmc":
							return await this.handlePMC(operation, params);
						default:
							throw new Error(`Unknown service: ${service}`);
					}
				} catch (error) {
					return {
						content: [{
							type: "text",
							text: `Error in External APIs (${params.service}/${params.operation}): ${error instanceof Error ? error.message : String(error)}`
						}]
					};
				}
			}
		);
	}

	private validateServiceOperation(service: string, operation: string) {
		const validCombinations: Record<string, string[]> = {
			blast: ["submit", "get_results"],
			pubchem: ["compound", "substance", "bioassay", "structure_search"],
			pmc: ["id_convert", "oa_service", "citation_export"]
		};

		if (!validCombinations[service]?.includes(operation)) {
			throw new Error(`Invalid operation '${operation}' for service '${service}'. Valid operations: ${validCombinations[service]?.join(', ') || 'none'}`);
		}
	}

	private async handleBLAST(operation: string, params: any) {
		switch (operation) {
			case "submit":
				return await this.blastSubmit(params);
			case "get_results":
				return await this.blastGetResults(params);
			default:
				throw new Error(`Unknown BLAST operation: ${operation}`);
		}
	}

	private async blastSubmit(params: any) {
		const { query, database_name, program, expect, format_type } = params;
		
		if (!query || !database_name || !program) {
			throw new Error("BLAST submit requires: query, database_name, and program");
		}

		// Validate sequence (basic check)
		const cleanQuery = query.trim();
		if (cleanQuery.length < 10) {
			throw new Error("Query sequence too short (minimum 10 characters)");
		}

		const submitParams = new URLSearchParams({
			CMD: "Put",
			QUERY: cleanQuery,
			DATABASE: database_name,
			PROGRAM: program,
			EMAIL: this.context.defaultEmail,
			TOOL: this.context.defaultTool
		});

		if (expect !== undefined) submitParams.append("EXPECT", expect.toString());
		if (format_type) submitParams.append("FORMAT_TYPE", format_type);

		const url = `https://blast.ncbi.nlm.nih.gov/Blast.cgi?${submitParams}`;
		const response = await fetch(url, { method: 'POST' });
		const data = await this.parseResponse(response, "BLAST Submit");

		// Extract RID using existing parser
		const { getParserForTool } = await import("../lib/parsers.js");
		const parser = getParserForTool("BLAST Submit", data);
		const parseResult = parser.parse(data);
		
		if (parseResult.entities.length > 0) {
			const jobData = parseResult.entities[0].data;
			return {
				content: [{
					type: "text",
					text: `✅ **BLAST Job Submitted**\n\n🆔 **RID**: \`${jobData.rid}\`\n⏱️ **Estimated Time**: ${jobData.estimated_time || 15} seconds\n\n💡 Use \`external_apis\` with service='blast', operation='get_results', rid='${jobData.rid}' to retrieve results.`
				}]
			};
		}

		throw new Error("Failed to extract job information from BLAST response");
	}

	private async blastGetResults(params: any) {
		const { rid, format_type } = params;
		
		if (!rid) {
			throw new Error("BLAST get_results requires: rid");
		}

		const getParams = new URLSearchParams({
			CMD: "Get",
			RID: rid.trim()
		});

		if (format_type) getParams.append("FORMAT_TYPE", format_type);

		const url = `https://blast.ncbi.nlm.nih.gov/Blast.cgi?${getParams}`;
		
		// Implement polling with timeout
		const maxRetries = 10;
		const retryDelay = 5000; // 5 seconds
		
		for (let i = 0; i < maxRetries; i++) {
			const response = await fetch(url);
			const data = await this.parseResponse(response, "BLAST Get");
			
			// Check for completion
			if (typeof data === 'string' && (data.includes("Status=WAITING") || data.includes("Status=UNKNOWN"))) {
				if (i < maxRetries - 1) {
					await new Promise(resolve => setTimeout(resolve, retryDelay));
					continue;
				} else {
					return {
						content: [{
							type: "text",
							text: `⏳ **BLAST Still Running** (${rid})\n\nJob is taking longer than expected. Please try again in a few minutes.`
						}]
					};
				}
			}
			
			// Results ready
			const dataLength = typeof data === 'string' ? data.length : JSON.stringify(data).length;
			return {
				content: [{
					type: "text",
					text: `✅ **BLAST Results** (${(dataLength / 1024).toFixed(1)} KB)\n\n\`\`\`xml\n${typeof data === 'string' ? data.substring(0, 2000) : JSON.stringify(data).substring(0, 2000)}${dataLength > 2000 ? '...' : ''}\n\`\`\``
				}]
			};
		}
		
		throw new Error("BLAST polling timeout exceeded");
	}

	private async handlePubChem(operation: string, params: any) {
		switch (operation) {
			case "compound":
				return await this.pubchemCompound(params);
			case "substance":
				return await this.pubchemSubstance(params);
			case "bioassay":
				return await this.pubchemBioAssay(params);
			case "structure_search":
				return await this.pubchemStructureSearch(params);
			default:
				throw new Error(`Unknown PubChem operation: ${operation}`);
		}
	}

	private async pubchemCompound(params: any) {
		const { identifier, identifier_type, output_format } = params;
		
		if (!identifier || !identifier_type) {
			throw new Error("PubChem compound requires: identifier and identifier_type");
		}

		const url = `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/${identifier_type}/${encodeURIComponent(identifier)}/record/${output_format}`;
		
		const response = await fetch(url);
		const data = await this.parseResponse(response, "PubChem Compound");

		const dataSize = typeof data === 'string' ? data.length : JSON.stringify(data).length;
		return {
			content: [{
				type: "text",
				text: `🧪 **PubChem Compound Data** (${(dataSize / 1024).toFixed(1)} KB)\n\n\`\`\`json\n${typeof data === 'string' ? data.substring(0, 1500) : JSON.stringify(data, null, 2).substring(0, 1500)}${dataSize > 1500 ? '...' : ''}\n\`\`\``
			}]
		};
	}

	private async pubchemSubstance(params: any) {
		const { identifier, identifier_type, output_format } = params;
		
		if (!identifier || !identifier_type) {
			throw new Error("PubChem substance requires: identifier and identifier_type");
		}

		const url = `https://pubchem.ncbi.nlm.nih.gov/rest/pug/substance/${identifier_type}/${encodeURIComponent(identifier)}/record/${output_format}`;
		
		const response = await fetch(url);
		const data = await this.parseResponse(response, "PubChem Substance");

		return {
			content: [{
				type: "text",
				text: `🧪 **PubChem Substance Data**\n\n\`\`\`json\n${typeof data === 'string' ? data : JSON.stringify(data, null, 2)}\n\`\`\``
			}]
		};
	}

	private async pubchemBioAssay(params: any) {
		const { identifier, identifier_type, output_format } = params;
		
		if (!identifier || !identifier_type) {
			throw new Error("PubChem bioassay requires: identifier and identifier_type");
		}

		const url = `https://pubchem.ncbi.nlm.nih.gov/rest/pug/assay/${identifier_type}/${encodeURIComponent(identifier)}/record/${output_format}`;
		
		const response = await fetch(url);
		const data = await this.parseResponse(response, "PubChem BioAssay");

		return {
			content: [{
				type: "text",
				text: `🔬 **PubChem BioAssay Data**\n\n\`\`\`json\n${typeof data === 'string' ? data : JSON.stringify(data, null, 2)}\n\`\`\``
			}]
		};
	}

	private async pubchemStructureSearch(params: any) {
		const { structure, structure_type, search_type, threshold, max_records, output_format } = params;
		
		if (!structure || !structure_type || !search_type) {
			throw new Error("PubChem structure search requires: structure, structure_type, and search_type");
		}

		// This is a simplified version - real implementation would be more complex
		const searchUrl = `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/structure/${search_type}/${structure_type}/${output_format}`;
		
		const response = await fetch(searchUrl, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: `structure=${encodeURIComponent(structure)}&threshold=${threshold}&max_records=${max_records}`
		});
		
		const data = await this.parseResponse(response, "PubChem Structure Search");

		return {
			content: [{
				type: "text",
				text: `🔍 **PubChem Structure Search Results**\n\n\`\`\`json\n${typeof data === 'string' ? data : JSON.stringify(data, null, 2)}\n\`\`\``
			}]
		};
	}

	private async handlePMC(operation: string, params: any) {
		switch (operation) {
			case "id_convert":
				return await this.pmcIdConvert(params);
			case "oa_service":
				return await this.pmcOAService(params);
			case "citation_export":
				return await this.pmcCitationExport(params);
			default:
				throw new Error(`Unknown PMC operation: ${operation}`);
		}
	}

	private async pmcIdConvert(params: any) {
		const { ids, versions, output_format } = params;
		
		if (!ids) {
			throw new Error("PMC id_convert requires: ids");
		}

		const convertParams = new URLSearchParams({
			ids,
			versions: versions || "no",
			format: output_format || "json",
			tool: this.context.defaultTool,
			email: this.context.defaultEmail
		});

		const url = `https://www.ncbi.nlm.nih.gov/pmc/utils/idconv/v1.0/?${convertParams}`;
		const response = await fetch(url);
		const data = await this.parseResponse(response, "PMC ID Converter");

		return {
			content: [{
				type: "text",
				text: `🔄 **PMC ID Conversion Results**\n\n\`\`\`json\n${typeof data === 'string' ? data : JSON.stringify(data, null, 2)}\n\`\`\``
			}]
		};
	}

	private async pmcOAService(params: any) {
		const { id, output_format } = params;
		
		if (!id) {
			throw new Error("PMC oa_service requires: id");
		}

		const oaParams = new URLSearchParams({
			id,
			format: output_format || "xml"
		});

		const url = `https://www.ncbi.nlm.nih.gov/pmc/utils/oa/oa.fcgi?${oaParams}`;
		const response = await fetch(url);
		const data = await this.parseResponse(response, "PMC OA Service");

		return {
			content: [{
				type: "text",
				text: `📖 **PMC Open Access Info**\n\n\`\`\`xml\n${typeof data === 'string' ? data : JSON.stringify(data)}\n\`\`\``
			}]
		};
	}

	private async pmcCitationExport(params: any) {
		const { id, citation_format } = params;
		
		if (!id || !citation_format) {
			throw new Error("PMC citation_export requires: id and citation_format");
		}

		const citeParams = new URLSearchParams({
			id,
			format: citation_format
		});

		const url = `https://www.ncbi.nlm.nih.gov/pmc/utils/ctxp/ctxp.cgi?${citeParams}`;
		const response = await fetch(url);
		const data = await this.parseResponse(response, "PMC Citation Export");

		return {
			content: [{
				type: "text",
				text: `📝 **Citation Export (${citation_format.toUpperCase()})**\n\n\`\`\`\n${typeof data === 'string' ? data : JSON.stringify(data)}\n\`\`\``
			}]
		};
	}
}