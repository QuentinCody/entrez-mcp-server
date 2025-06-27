import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { parseResponse } from "../utils/helpers";
import { DEFAULT_EMAIL, DEFAULT_TOOL } from "../constants";

export function registerPubChemTools(server: McpServer) {
	// PubChem Compound Lookup - Get compound information
	server.tool(
		"pubchem_compound",
		{
			identifier_type: z
				.enum(["cid", "name", "smiles", "inchi", "inchikey", "formula"])
				.describe("Type of identifier"),
			identifier: z.string().describe("Compound identifier"),
			operation: z
				.enum([
					"record",
					"property",
					"synonyms",
					"classification",
					"conformers",
				])
				.default("record")
				.describe("Type of data to retrieve"),
			property_list: z
				.string()
				.optional()
				.describe(
					"Comma-separated list of properties (for property operation)",
				),
			output_format: z
				.enum(["json", "xml", "sdf", "csv", "png", "txt"])
				.default("json")
				.describe("Output format"),
		},
		async ({
			identifier_type,
			identifier,
			operation,
			property_list,
			output_format,
		}) => {
			try {
				if (!identifier || identifier.trim() === "") {
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
					tool: DEFAULT_TOOL,
					email: DEFAULT_EMAIL,
				});
				url += `?${params}`;

				const response = await fetch(url);
				const data = await parseResponse(response, "PubChem Compound");

				return {
					content: [
						{
							type: "text",
							text: `PubChem Compound Results:\n\n${data}`,
						},
					],
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: `Error in PubChem Compound: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
				};
			}
		},
	);

	// PubChem Substance Lookup - Get substance information
	server.tool(
		"pubchem_substance",
		{
			identifier_type: z
				.enum(["sid", "sourceid", "name", "xref"])
				.describe("Type of identifier"),
			identifier: z.string().describe("Substance identifier"),
			operation: z
				.enum(["record", "synonyms", "classification", "xrefs"])
				.default("record")
				.describe("Type of data to retrieve"),
			output_format: z
				.enum(["json", "xml", "sdf", "csv", "txt"])
				.default("json")
				.describe("Output format"),
		},
		async ({ identifier_type, identifier, operation, output_format }) => {
			try {
				if (!identifier || identifier.trim() === "") {
					throw new Error("Identifier cannot be empty");
				}

				let url = `https://pubchem.ncbi.nlm.nih.gov/rest/pug/substance/${identifier_type}/${encodeURIComponent(identifier.trim())}`;

				if (operation !== "record") {
					url += `/${operation}`;
				}

				url += `/${output_format.toUpperCase()}`;

				// Add tool and email parameters
				const params = new URLSearchParams({
					tool: DEFAULT_TOOL,
					email: DEFAULT_EMAIL,
				});
				url += `?${params}`;

				const response = await fetch(url);
				const data = await parseResponse(response, "PubChem Substance");

				return {
					content: [
						{
							type: "text",
							text: `PubChem Substance Results:\n\n${data}`,
						},
					],
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: `Error in PubChem Substance: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
				};
			}
		},
	);

	// PubChem BioAssay Lookup - Get bioassay information
	server.tool(
		"pubchem_bioassay",
		{
			identifier_type: z
				.enum(["aid", "listkey", "target", "activity"])
				.describe("Type of identifier"),
			identifier: z.string().describe("BioAssay identifier"),
			operation: z
				.enum(["record", "summary", "description", "targets", "aids"])
				.default("record")
				.describe("Type of data to retrieve"),
			output_format: z
				.enum(["json", "xml", "csv", "txt"])
				.default("json")
				.describe("Output format"),
		},
		async ({ identifier_type, identifier, operation, output_format }) => {
			try {
				if (!identifier || identifier.trim() === "") {
					throw new Error("Identifier cannot be empty");
				}

				let url = `https://pubchem.ncbi.nlm.nih.gov/rest/pug/assay/${identifier_type}/${encodeURIComponent(identifier.trim())}`;

				if (operation !== "record") {
					url += `/${operation}`;
				}

				url += `/${output_format.toUpperCase()}`;

				// Add tool and email parameters
				const params = new URLSearchParams({
					tool: DEFAULT_TOOL,
					email: DEFAULT_EMAIL,
				});
				url += `?${params}`;

				const response = await fetch(url);
				const data = await parseResponse(response, "PubChem BioAssay");

				return {
					content: [
						{
							type: "text",
							text: `PubChem BioAssay Results:\n\n${data}`,
						},
					],
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: `Error in PubChem BioAssay: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
				};
			}
		},
	);

	// PubChem Structure Search - Search by chemical structure
	server.tool(
		"pubchem_structure_search",
		{
			structure_type: z
				.enum(["smiles", "inchi", "sdf", "mol"])
				.describe("Type of structure input"),
			structure: z.string().describe("Chemical structure representation"),
			search_type: z
				.enum(["identity", "substructure", "superstructure", "similarity"])
				.describe("Type of structure search"),
			threshold: z
				.number()
				.optional()
				.default(90)
				.describe("Similarity threshold (for similarity searches, 0-100)"),
			max_records: z
				.number()
				.optional()
				.default(1000)
				.describe("Maximum number of records to return"),
			output_format: z
				.enum(["json", "xml", "sdf", "csv", "txt"])
				.default("json")
				.describe("Output format"),
		},
		async ({
			structure_type,
			structure,
			search_type,
			threshold,
			max_records,
			output_format,
		}) => {
			try {
				if (!structure || structure.trim() === "") {
					throw new Error("Structure cannot be empty");
				}

				// Build the correct PubChem structure search URL
				const baseUrl = `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound`;
				let url: string;

				const params = new URLSearchParams({
					tool: DEFAULT_TOOL,
					email: DEFAULT_EMAIL,
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

					if (search_type === "similarity" && threshold !== undefined) {
						params.append("Threshold", threshold.toString());
					}
					if (max_records !== undefined) {
						params.append("MaxRecords", max_records.toString());
					}

					url += `?${params}`;

					response = await fetch(url, {
						method: "POST",
						headers: { "Content-Type": "text/plain" },
						body: structure.trim(),
					});
				}

				if (!response.ok) {
					const errorText = await response.text();
					throw new Error(
						`PubChem search failed: ${response.status} ${response.statusText}. Response: ${errorText}`,
					);
				}

				const responseData = await response.text();

				// Check if this is a waiting response or direct results
				if (
					responseData.includes('"Waiting"') ||
					responseData.includes('"Running"')
				) {
					return {
						content: [
							{
								type: "text",
								text: `PubChem Structure Search Submitted:\n\nSearch is running. Please wait and try again with the returned key to get results.\n\n${responseData}`,
							},
						],
					};
				}

				return {
					content: [
						{
							type: "text",
							text: `PubChem Structure Search Results:\n\n${responseData}`,
						},
					],
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: `Error in PubChem Structure Search: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
				};
			}
		},
	);
}
