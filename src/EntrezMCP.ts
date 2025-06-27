import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SERVER_CONFIG } from "./constants";
import { registerEutilsTools } from "./tools/eutils";
import { registerBlastTools } from "./tools/blast";
import { registerPubChemTools } from "./tools/pubchem";
import { registerPmcTools } from "./tools/pmc";

// Define our MCP agent for NCBI Entrez E-utilities
export class EntrezMCP extends McpAgent {
	server = new McpServer({
		name: SERVER_CONFIG.name,
		version: SERVER_CONFIG.version,
	});

	// Optional Entrez API key pulled from the Workers `env` vars (set in wrangler.toml/json).
	// Cloudflare exposes them on `globalThis` inside the worker runtime.
	private readonly apiKey: string | undefined = (globalThis as any)
		?.NCBI_API_KEY as string | undefined;

	async init() {
		// Register all E-utilities tools
		registerEutilsTools(this.server, this.apiKey);

		// Register BLAST tools
		registerBlastTools(this.server);

		// Register PubChem tools
		registerPubChemTools(this.server);

		// Register PMC tools
		registerPmcTools(this.server);
	}
}
