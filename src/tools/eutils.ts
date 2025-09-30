import { z } from "zod";
import { BaseTool } from "./base.js";

export class ELinkTool extends BaseTool {
	register(): void {
		this.context.server.tool(
			"elink",
			"Find UIDs linked between Entrez databases (e.g., SNP records linked to Nucleotide, Domain records linked to Protein). Essential for discovering related data across NCBI's interconnected databases and creating data pipelines.",
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
					if (db && !this.isValidDatabase(db)) {
						throw new Error(`Invalid target database name: ${db}`);
					}
					if (dbfrom && !this.isValidDatabase(dbfrom)) {
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

					const params = new URLSearchParams({
						db: db || "pubmed",
						dbfrom: dbfrom || "pubmed",
						id: cleanIds.join(","),
						tool: this.context.defaultTool,
						email: this.context.defaultEmail,
						retmode: retmode || "xml",
					});

					if (cmd) params.append("cmd", cmd);
					if (linkname) params.append("linkname", linkname);
					if (term) params.append("term", term);
					if (holding) params.append("holding", holding);
					if (datetype) params.append("datetype", datetype);
					if (reldate !== undefined)
						params.append("reldate", reldate.toString());
					if (mindate) params.append("mindate", mindate);
					if (maxdate) params.append("maxdate", maxdate);

					const url = this.buildUrl("elink.fcgi", params);
					const response = await fetch(url);
					const data = await this.parseResponse(response, "ELink", retmode);

					return {
						content: [
							{
								type: "text",
								text: `ELink Results:\n\n${this.formatResponseData(data)}`,
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
	}
}

export class EPostTool extends BaseTool {
	register(): void {
		this.context.server.tool(
			"epost",
			"Upload UIDs to the Entrez History server for efficient batch processing. Essential for large datasets - upload thousands of IDs once, then use with other E-utilities. Returns query_key and WebEnv for pipeline workflows.",
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
					if (db && !this.isValidDatabase(db)) {
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

					const params = new URLSearchParams({
						db: db || "pubmed",
						id: cleanIds.join(","),
						tool: this.context.defaultTool,
						email: this.context.defaultEmail,
					});

					if (WebEnv) params.append("WebEnv", WebEnv);

					const url = this.buildUrl("epost.fcgi", params);
					const response = await fetch(url);
					const data = await this.parseResponse(response, "EPost");

					return {
						content: [
							{
								type: "text",
								text: `EPost Results:\n\n${this.formatResponseData(data)}`,
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
	}
}

export class EGQueryTool extends BaseTool {
	register(): void {
		this.context.server.tool(
			"egquery",
			"Search across all 38+ Entrez databases simultaneously to see hit counts for your query in each database. Global version of ESearch that helps identify which databases contain relevant data before focused searches.",
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
						new URLSearchParams({
							term: cleanTerm,
							tool: this.context.defaultTool,
							email: this.context.defaultEmail,
							retmode: "xml",
						}),
						// Alternative with simpler parameters
						new URLSearchParams({
							term: cleanTerm,
							tool: this.context.defaultTool,
							email: this.context.defaultEmail,
						}),
						// Try with URL encoding
						new URLSearchParams({
							term: encodeURIComponent(cleanTerm),
							tool: this.context.defaultTool,
							email: this.context.defaultEmail,
							retmode: "xml",
						}),
					];

					let diagnosticInfo = `EGQuery Diagnostic Information:\n`;
					diagnosticInfo += `Original term: "${term}"\n`;
					diagnosticInfo += `Cleaned term: "${cleanTerm}"\n`;
					diagnosticInfo += `Attempting ${paramSets.length} different parameter combinations...\n\n`;

					for (
						let paramIndex = 0;
						paramIndex < paramSets.length;
						paramIndex++
					) {
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
									data.includes("<e>") ||
									data.includes('"ERROR"') ||
									data.includes("error") ||
									data.includes("Error") ||
									data.includes("internal error") ||
									data.includes("reference =")
								) {
									const errorMatch =
										data.match(/<e>(.*?)<\/ERROR>/) ||
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
								const searchParams = new URLSearchParams({
									db: db,
									term: cleanTerm,
									retmax: "0", // Just get counts
									tool: this.context.defaultTool,
									email: this.context.defaultEmail,
									retmode: "json",
								});

								const searchUrl = this.buildUrl("esearch.fcgi", searchParams);
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
	}
}

export class ESpellTool extends BaseTool {
	register(): void {
		this.context.server.tool(
			"espell",
			"Get spelling suggestions for search terms in Entrez databases. Helps optimize queries by suggesting correct spellings for biomedical terms, gene names, and scientific terminology before running searches.",
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
					if (db && !this.isValidDatabase(db)) {
						throw new Error(`Invalid database name: ${db}`);
					}

					const params = new URLSearchParams({
						db: db || "pubmed",
						term: term.trim(),
						tool: this.context.defaultTool,
						email: this.context.defaultEmail,
					});

					const url = this.buildUrl("espell.fcgi", params);
					const response = await fetch(url);
					const data = await this.parseResponse(response, "ESpell");

					return {
						content: [
							{
								type: "text",
								text: `ESpell Results:\n\n${this.formatResponseData(data)}`,
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
}
