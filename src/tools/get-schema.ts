import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createGetSchemaHandler } from "@bio-mcp/shared/staging/utils";

export function registerGetSchema(server: McpServer, env: Record<string, unknown>) {
	const handler = createGetSchemaHandler("ENTREZ_DATA_DO", "entrez");
	server.registerTool(
		"entrez_get_schema",
		{
			title: "Get Staged Entrez Data Schema",
			description:
				"Retrieve the schema (table names, columns, types, row counts) of previously staged Entrez data. " +
				"Use data_access_id from a prior tool response that indicated data was staged.",
			inputSchema: {
				data_access_id: z.string().describe("The data_access_id from a prior staged response"),
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
