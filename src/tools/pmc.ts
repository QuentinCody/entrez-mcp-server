import { z } from "zod";
import { BaseTool } from "./base.js";

export class PMCIdConverterTool extends BaseTool {
	register(): void {
		this.context.server.tool(
			"pmc_id_converter",
			"Convert between different PMC article identifiers including PMC IDs, PubMed IDs (PMID), DOIs, and Manuscript IDs (MID). Supports up to 200 IDs per request.",
			{
				ids: z
					.string()
					.describe("Comma-separated list of IDs to convert (up to 200)"),
				idtype: z
					.enum(["pmcid", "pmid", "mid", "doi"])
					.optional()
					.describe("Type of input IDs (auto-detected if not specified)"),
				versions: z
					.enum(["yes", "no"])
					.default("no")
					.describe("Show version information"),
				showaiid: z
					.enum(["yes", "no"])
					.default("no")
					.describe("Show Article Instance IDs"),
				format: z
					.enum(["xml", "json", "csv"])
					.default("json")
					.describe("Output format"),
			},
			async ({ ids, idtype, versions, showaiid, format }) => {
				try {
					if (!ids || ids.trim() === "") {
						throw new Error("IDs parameter cannot be empty");
					}

					// Clean and validate IDs
					const cleanIds = ids
						.split(",")
						.map((id) => id.trim())
						.filter((id) => id !== "");
					if (cleanIds.length === 0) {
						throw new Error("No valid IDs provided");
					}
					if (cleanIds.length > 200) {
						throw new Error("Too many IDs provided (maximum 200)");
					}

					const params = new URLSearchParams({
						ids: cleanIds.join(","),
						versions: versions,
						showaiid: showaiid,
						format: format,
						tool: this.context.defaultTool,
						email: this.context.defaultEmail,
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
								text: `PMC ID Converter Results:\n\n${this.formatResponseData(data)}`,
							},
						],
					};
				} catch (error) {
					return {
						content: [
							{
								type: "text",
								text: `Error in PMC ID Converter: ${error instanceof Error ? error.message : String(error)}`,
							},
						],
					};
				}
			},
		);
	}
}

export class PMCOpenAccessServiceTool extends BaseTool {
	register(): void {
		this.context.server.tool(
			"pmc_oa_service",
			"Check if a PMC article is available in the Open Access subset and get download links for full-text content. Works with PMC IDs, PubMed IDs, or DOIs.",
			{
				id: z.string().describe("PMC ID, PMID, or DOI"),
				format: z
					.enum(["xml", "json"])
					.optional()
					.default("xml")
					.describe("Output format"),
			},
			async ({ id, format }) => {
				try {
					if (!id || id.trim() === "") {
						throw new Error("ID cannot be empty");
					}

					// Build the PMC OA service URL - this service only works for articles in PMC Open Access Subset
					const url = `https://www.ncbi.nlm.nih.gov/pmc/utils/oa/oa.fcgi?id=${encodeURIComponent(id.trim())}&tool=entrez-mcp-server&email=entrez-mcp-server%40example.com`;

					const response = await fetch(url, {
						headers: {
							"User-Agent":
								"NCBI Entrez E-utilities MCP Server (entrez-mcp-server@example.com)",
						},
					});

					const data = await this.parseResponse(response, "PMC OA Service");

					// Check if the article is not available in OA
					if (
						data.includes("cannotDisseminateFormat") ||
						data.includes("not available")
					) {
						return {
							content: [
								{
									type: "text",
									text: `PMC Open Access Service Results:\n\nArticle ${id} is not available through the PMC Open Access Service. This may be because:\n1. The article is not in the PMC Open Access Subset\n2. The article has access restrictions\n3. The article is available only to PMC subscribers\n\nResponse: ${data}`,
								},
							],
						};
					}

					return {
						content: [
							{
								type: "text",
								text: `PMC Open Access Service Results:\n\n${this.formatResponseData(data)}`,
							},
						],
					};
				} catch (error) {
					return {
						content: [
							{
								type: "text",
								text: `Error in PMC Open Access Service: ${error instanceof Error ? error.message : String(error)}`,
							},
						],
					};
				}
			},
		);
	}
}

export class PMCCitationExporterTool extends BaseTool {
	register(): void {
		this.context.server.tool(
			"pmc_citation_exporter",
			"Export properly formatted citations for PMC articles in various bibliographic formats including RIS, NBIB, MEDLINE, and BibTeX for use in reference managers.",
			{
				id: z.string().describe("PMC ID or PMID"),
				format: z
					.enum(["ris", "nbib", "medline", "bibtex"])
					.describe("Citation format"),
			},
			async ({ id, format }) => {
				try {
					if (!id || id.trim() === "") {
						throw new Error("ID cannot be empty");
					}

					// Build the PMC citation exporter URL based on documentation examples
					// Format: https://api.ncbi.nlm.nih.gov/lit/ctxp/v1/pmc/{format}?id={id}
					const url = `https://api.ncbi.nlm.nih.gov/lit/ctxp/v1/pmc/${format}?id=${encodeURIComponent(id.trim())}`;

					const response = await fetch(url, {
						headers: {
							"User-Agent": `${this.context.defaultTool} (${this.context.defaultEmail})`,
						},
					});

					if (!response.ok) {
						const errorText = await response.text();
						throw new Error(
							`PMC Citation Exporter request failed: ${response.status} ${response.statusText}. Response: ${errorText}`,
						);
					}

					const data = await response.text();

					return {
						content: [
							{
								type: "text",
								text: `PMC Citation Exporter Results:\n\n${this.formatResponseData(data)}`,
							},
						],
					};
				} catch (error) {
					return {
						content: [
							{
								type: "text",
								text: `Error in PMC Citation Exporter: ${error instanceof Error ? error.message : String(error)}`,
							},
						],
					};
				}
			},
		);
	}
}
