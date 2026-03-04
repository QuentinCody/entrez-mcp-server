import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createQueryDataHandler } from "@bio-mcp/shared/staging/utils";

export function registerQueryData(server: McpServer, env: Record<string, unknown>) {
	const handler = createQueryDataHandler("ENTREZ_DATA_DO", "entrez");
	server.registerTool(
		"entrez_query_data",
		{
			title: "Query Staged Entrez Data",
			description:
				"Run SQL SELECT queries against previously staged Entrez data. " +
				"Use data_access_id from a prior tool response that indicated data was staged.",
			inputSchema: {
				data_access_id: z.string().describe("The data_access_id from a prior staged response"),
				sql: z.string().describe("SQL SELECT query to execute against the staged data"),
				limit: z.number().int().min(1).max(1000).default(100).optional()
					.describe("Maximum rows to return (default 100, max 1000)"),
			},
		},
		async (args) => {
			const result = await handler(args as Record<string, unknown>, env);
			return {
				content: [{ type: "text" as const, text: JSON.stringify(result) }],
				structuredContent: result,
			};
		},
	);
}
