import { EntrezMCP } from "./EntrezMCP";

// Export the EntrezMCP class to satisfy worker configuration
export { EntrezMCP } from "./EntrezMCP";

// Temporary alias for migration
export class MyMCP extends EntrezMCP {}

export default {
	fetch(request: Request, env: any, ctx: ExecutionContext) {
		const url = new URL(request.url);

		if (url.pathname === "/sse" || url.pathname === "/sse/message") {
			return EntrezMCP.serveSSE("/sse").fetch(request, env, ctx);
		}

		if (url.pathname === "/mcp") {
			return EntrezMCP.serve("/mcp").fetch(request, env, ctx);
		}

		return new Response(
			"Complete NCBI APIs MCP Server - Including E-utilities, BLAST, PubChem PUG, and PMC APIs",
			{
				status: 200,
				headers: { "Content-Type": "text/plain" },
			},
		);
	},
};
