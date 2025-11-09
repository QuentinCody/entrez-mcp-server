import { z } from "zod";
import { BaseTool } from "./base.js";

const ExternalParamsShape = {
	service: z
		.enum(["pubchem", "pmc"])
		.describe("External service to access"),

	operation: z
		.enum([
			// PubChem operations
			"compound",
			"substance",
			"bioassay",
			"structure_search",
			// PMC operations
			"id_convert",
			"oa_service",
			"citation_export",
		])
		.describe("Service operation to perform"),

	// PubChem parameters
	identifier: z
		.string()
		.optional()
		.describe("Chemical identifier (name, CID, SID, etc.)"),
	identifier_type: z
		.enum([
			"cid",
			"name",
			"smiles",
			"inchi",
			"inchikey",
			"formula", // compound
			"sid",
			"sourceid",
			"xref", // substance
			"aid",
			"listkey",
			"target",
			"activity", // bioassay
		])
		.optional()
		.describe("Type of chemical identifier"),
	search_type: z
		.enum(["identity", "substructure", "superstructure", "similarity"])
		.optional()
		.describe("Structure search type"),
	structure: z
		.string()
		.optional()
		.describe("Chemical structure (SMILES, InChI, SDF, MOL)"),
	structure_type: z
		.enum(["smiles", "inchi", "sdf", "mol"])
		.optional()
		.describe("Structure input format"),
	threshold: z
		.number()
		.optional()
		.default(90)
		.describe("Similarity threshold (0-100)"),

	// PMC parameters
	ids: z
		.string()
		.optional()
		.describe("PMC/PMID/DOI identifiers (comma-separated, up to 200)"),
	id: z.string().optional().describe("Single PMC/PMID/DOI identifier"),
	citation_format: z
		.enum(["ris", "nbib", "medline", "bibtex"])
		.optional()
		.describe("Citation export format"),

	// Common parameters
	output_format: z
		.enum(["json", "xml", "csv", "txt", "sdf", "png"])
		.optional()
		.default("json")
		.describe("Response format"),
	max_records: z
		.number()
		.optional()
		.default(1000)
		.describe("Maximum records to return"),
	versions: z
		.enum(["yes", "no"])
		.optional()
		.default("no")
		.describe("Include version information (PMC)"),
};

const ExternalParamsSchema = z.object(ExternalParamsShape);
type ExternalParams = z.infer<typeof ExternalParamsSchema>;

export class ExternalAPIsTool extends BaseTool {
	register(): void {
		this.registerTool(
			"entrez_external",
			"Access PubChem chemistry and PMC article utilities from one entry point.",
			ExternalParamsShape,
			async (params: ExternalParams) => {
				try {
					const { service, operation } = params;

					// Validate service-operation combinations
					this.validateServiceOperation(service, operation);

					// Route to appropriate service handler
					switch (service) {
						case "pubchem":
							return await this.handlePubChem(operation, params);
						case "pmc":
							return await this.handlePMC(operation, params);
						default:
							throw new Error(`Unknown service: ${service}`);
					}
				} catch (error) {
					return this.textResult(
						`Error in External APIs (${params.service}/${params.operation}): ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			},
			{ aliases: ["entrez-external"] },
		);
	}

	override getCapabilities() {
		return {
			tool: "entrez_external",
			summary:
				"Access PubChem chemistry datasets and PMC full-text utilities via one surface.",
			operations: [
				{
					name: "pubchem.compound",
					summary:
						"Fetch compound records by CID, name, or structure identifiers.",
					required: [
						{
							name: "identifier",
							type: "string",
							description: "Compound identifier value",
						},
						{
							name: "identifier_type",
							type: "string",
							description: "Identifier type such as cid, name, inchikey",
						},
					],
					optional: [
						{
							name: "output_format",
							type: "string",
							description: "Response format (json, xml, sdf)",
							defaultValue: "json",
						},
					],
				},
				{
					name: "pubchem.substance",
					summary: "Retrieve substance records by SID or source identifiers.",
					required: [
						{
							name: "identifier",
							type: "string",
							description: "Substance identifier",
						},
						{
							name: "identifier_type",
							type: "string",
							description: "Type such as sid or sourceid",
						},
					],
					optional: [
						{
							name: "output_format",
							type: "string",
							description: "Response format",
							defaultValue: "json",
						},
					],
				},
				{
					name: "pubchem.bioassay",
					summary: "Retrieve bioassay records for activity analysis.",
					required: [
						{
							name: "identifier",
							type: "string",
							description: "Assay identifier",
						},
						{
							name: "identifier_type",
							type: "string",
							description: "Assay identifier type such as aid",
						},
					],
					optional: [
						{
							name: "output_format",
							type: "string",
							description: "Response format",
							defaultValue: "json",
						},
					],
				},
				{
					name: "pubchem.structure_search",
					summary:
						"Run similarity, identity, or substructure searches from structure inputs.",
					required: [
						{
							name: "structure",
							type: "string",
							description: "Structure specification",
						},
						{
							name: "structure_type",
							type: "string",
							description: "Format such as smiles, inchi, mol",
						},
						{
							name: "search_type",
							type: "string",
							description: "Search mode identity/substructure/similarity",
						},
					],
					optional: [
						{
							name: "threshold",
							type: "number",
							description: "Similarity threshold percentage",
							defaultValue: 90,
						},
						{
							name: "max_records",
							type: "number",
							description: "Result limit",
							defaultValue: 1000,
						},
					],
					remarks: ["Use max_records <= 500 for chatty sessions"],
				},
				{
					name: "pmc.id_convert",
					summary: "Convert identifiers between PMC, PMID, and DOI.",
					required: [
						{
							name: "ids",
							type: "string",
							description: "Comma separated identifiers",
						},
					],
					optional: [
						{
							name: "versions",
							type: "string",
							description: "Include version metadata",
							defaultValue: "no",
						},
					],
				},
				{
					name: "pmc.oa_service",
					summary: "Request Open Access full-text packages from PMC.",
					required: [
						{ name: "id", type: "string", description: "PMC ID or DOI" },
					],
					optional: [
						{
							name: "output_format",
							type: "string",
							description: "Package format (xml, pdf, tgz)",
							defaultValue: "xml",
						},
					],
					remarks: ["Large packages may be streamed via staging"],
				},
				{
					name: "pmc.citation_export",
					summary: "Export citation metadata in RIS, NBIB, Medline, or BibTeX.",
					required: [
						{
							name: "ids",
							type: "string",
							description: "Comma separated identifiers",
						},
					],
					optional: [
						{
							name: "citation_format",
							type: "string",
							description: "Citation file format",
							defaultValue: "ris",
						},
					],
					remarks: ["Use when generating bibliographies"],
				},
			],
			contexts: ["chemistry", "full_text", "citation"],
			requiresApiKey: false,
			tokenProfile: { typical: 220, upper: 9000 },
			metadata: {
				services: ["pubchem", "pmc"],
				aliases: ["entrez-external"],
			},
		};
	}

	private validateServiceOperation(service: string, operation: string) {
		const validCombinations: Record<string, string[]> = {
			pubchem: ["compound", "substance", "bioassay", "structure_search"],
			pmc: ["id_convert", "oa_service", "citation_export"],
		};

		if (!validCombinations[service]?.includes(operation)) {
			throw new Error(
				`Invalid operation '${operation}' for service '${service}'. Valid operations: ${validCombinations[service]?.join(", ") || "none"}`,
			);
		}
	}

	// biome-ignore lint/suspicious/noExplicitAny: dynamic payload validated via zod schema
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

	// biome-ignore lint/suspicious/noExplicitAny: dynamic payload validated via zod schema
	private async pubchemCompound(params: any) {
		const { identifier, identifier_type, output_format } = params;

		if (!identifier || !identifier_type) {
			throw new Error(
				"PubChem compound requires: identifier and identifier_type",
			);
		}

		const url = `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/${identifier_type}/${encodeURIComponent(identifier)}/record/${output_format}`;

		const response = await fetch(url);
		const data = await this.parseResponse(response, "PubChem Compound");

		// Extract key information for summary
		const summary = this.extractPubchemSummary(data);
		const dataSize =
			typeof data === "string" ? data.length : JSON.stringify(data).length;

		return this.textResult(
			`🧪 **PubChem Compound Data** (${(dataSize / 1024).toFixed(1)} KB)\n\n${summary}\n\n**Full Data:**\n\`\`\`json\n${typeof data === "string" ? data : JSON.stringify(data, null, 2)}\n\`\`\``,
		);
	}

	// biome-ignore lint/suspicious/noExplicitAny: dynamic payload validated via zod schema
	private async pubchemSubstance(params: any) {
		const { identifier, identifier_type, output_format } = params;

		if (!identifier || !identifier_type) {
			throw new Error(
				"PubChem substance requires: identifier and identifier_type",
			);
		}

		const url = `https://pubchem.ncbi.nlm.nih.gov/rest/pug/substance/${identifier_type}/${encodeURIComponent(identifier)}/record/${output_format}`;

		const response = await fetch(url);
		const data = await this.parseResponse(response, "PubChem Substance");

		return this.textResult(
			`🧪 **PubChem Substance Data**\n\n\`\`\`json\n${typeof data === "string" ? data : JSON.stringify(data, null, 2)}\n\`\`\``,
		);
	}

	// biome-ignore lint/suspicious/noExplicitAny: dynamic payload validated via zod schema
	private async pubchemBioAssay(params: any) {
		const { identifier, identifier_type, output_format } = params;

		if (!identifier || !identifier_type) {
			throw new Error(
				"PubChem bioassay requires: identifier and identifier_type",
			);
		}

		const url = `https://pubchem.ncbi.nlm.nih.gov/rest/pug/assay/${identifier_type}/${encodeURIComponent(identifier)}/record/${output_format}`;

		const response = await fetch(url);
		const data = await this.parseResponse(response, "PubChem BioAssay");

		return this.textResult(
			`🔬 **PubChem BioAssay Data**\n\n\`\`\`json\n${typeof data === "string" ? data : JSON.stringify(data, null, 2)}\n\`\`\``,
		);
	}

	// biome-ignore lint/suspicious/noExplicitAny: dynamic payload validated via zod schema
	private async pubchemStructureSearch(params: any) {
		const {
			structure,
			structure_type,
			search_type,
			threshold,
			max_records,
			output_format,
		} = params;

		if (!structure || !structure_type || !search_type) {
			throw new Error(
				"PubChem structure search requires: structure, structure_type, and search_type",
			);
		}

		// This is a simplified version - real implementation would be more complex
		const searchUrl = `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/structure/${search_type}/${structure_type}/${output_format}`;

		const response = await fetch(searchUrl, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: `structure=${encodeURIComponent(structure)}&threshold=${threshold}&max_records=${max_records}`,
		});

		const data = await this.parseResponse(response, "PubChem Structure Search");

		return this.textResult(
			`🔍 **PubChem Structure Search Results**\n\n\`\`\`json\n${typeof data === "string" ? data : JSON.stringify(data, null, 2)}\n\`\`\``,
		);
	}

	// biome-ignore lint/suspicious/noExplicitAny: dynamic payload validated via zod schema
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

	// biome-ignore lint/suspicious/noExplicitAny: dynamic payload validated via zod schema
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
			email: this.context.defaultEmail,
		});

		const url = `https://www.ncbi.nlm.nih.gov/pmc/utils/idconv/v1.0/?${convertParams}`;
		const response = await fetch(url);
		const data = await this.parseResponse(response, "PMC ID Converter");

		return this.textResult(
			`🔄 **PMC ID Conversion Results**\n\n\`\`\`json\n${typeof data === "string" ? data : JSON.stringify(data, null, 2)}\n\`\`\``,
		);
	}

	// biome-ignore lint/suspicious/noExplicitAny: dynamic payload validated via zod schema
	private async pmcOAService(params: any) {
		const { id, output_format } = params;

		if (!id) {
			throw new Error("PMC oa_service requires: id");
		}

		const oaParams = new URLSearchParams({
			id,
			format: output_format || "xml",
		});

		const url = `https://www.ncbi.nlm.nih.gov/pmc/utils/oa/oa.fcgi?${oaParams}`;
		const response = await fetch(url);
		const data = await this.parseResponse(response, "PMC OA Service");

		return this.textResult(
			`📖 **PMC Open Access Info**\n\n\`\`\`xml\n${typeof data === "string" ? data : JSON.stringify(data)}\n\`\`\``,
		);
	}

	// biome-ignore lint/suspicious/noExplicitAny: dynamic payload validated via zod schema
	private async pmcCitationExport(params: any) {
		const { id, citation_format } = params;

		if (!id || !citation_format) {
			throw new Error("PMC citation_export requires: id and citation_format");
		}

		const citeParams = new URLSearchParams({
			id,
			format: citation_format,
		});

		const url = `https://www.ncbi.nlm.nih.gov/pmc/utils/ctxp/ctxp.cgi?${citeParams}`;
		const response = await fetch(url);
		const data = await this.parseResponse(response, "PMC Citation Export");

		return this.textResult(
			`📝 **Citation Export (${citation_format.toUpperCase()})**\n\n\`\`\`\n${typeof data === "string" ? data : JSON.stringify(data)}\n\`\`\``,
		);
	}

	// Helper method to extract key information from PubChem compound data
	// biome-ignore lint/suspicious/noExplicitAny: accepts heterogeneous PubChem responses
	private extractPubchemSummary(data: any): string {
		try {
			let parsedData = data;

			// If it's a string, try to parse it as JSON
			if (typeof data === "string") {
				try {
					parsedData = JSON.parse(data);
				} catch {
					return "**Summary:** Could not parse JSON data\n";
				}
			}

			if (parsedData?.PC_Compounds?.[0]) {
				const compound = parsedData.PC_Compounds[0];
				const cid = compound.id?.id?.cid;
				const atomCount = compound.atoms?.aid?.length;
				const bondCount = compound.bonds?.aid1?.length;

				let summary = "**Key Information:**\n";
				if (cid) summary += `- **CID:** ${cid}\n`;
				if (atomCount) summary += `- **Atoms:** ${atomCount}\n`;
				if (bondCount) summary += `- **Bonds:** ${bondCount}\n`;

				// Extract molecular properties if available
				if (compound.props) {
					// biome-ignore lint/suspicious/noExplicitAny: PubChem properties are heterogeneously typed
					compound.props.forEach((prop: any) => {
						if (prop.urn && prop.value) {
							const label = prop.urn.label;
							const value =
								prop.value.sval || prop.value.fval || prop.value.ival;
							if (label && value) {
								summary += `- **${label}:** ${value}\n`;
							}
						}
					});
				}

				return summary;
			}

			return "**Summary:** Compound data structure not recognized\n";
		} catch (_error) {
			return "**Summary:** Error parsing compound data\n";
		}
	}
}
