import { z } from "zod";
import { BaseTool } from "./base.js";

export class BlastSubmitTool extends BaseTool {
	register(): void {
		this.context.server.tool(
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
						EMAIL: this.context.defaultEmail,
						TOOL: this.context.defaultTool,
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
	}
}

export class BlastGetTool extends BaseTool {
	register(): void {
		this.context.server.tool(
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
	}
}
