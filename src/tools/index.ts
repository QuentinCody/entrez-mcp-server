import { ToolContext } from "./base.js";
import { ApiKeyStatusTool } from "./api-key-status.js";
import { EntrezQueryTool } from "./consolidated-entrez.js";
import { DataManagerTool } from "./consolidated-data.js";
import { ExternalAPIsTool } from "./consolidated-external.js";

export class ToolRegistry {
	private tools: any[] = [];

	constructor(context: ToolContext) {
		// Register consolidated tools (19 → 4 tools)
		this.tools = [
			// System utilities
			new ApiKeyStatusTool(context),
			
			// Unified E-utilities interface (combines 8 tools)
			new EntrezQueryTool(context),
			
			// Unified data management (combines 3 tools)
			new DataManagerTool(context),
			
			// Unified external APIs (combines 9 tools)
			new ExternalAPIsTool(context),
		];
	}

	registerAll(): void {
		this.tools.forEach(tool => tool.register());
	}
}

// Export types and consolidated tool classes
export type { ToolContext };
export {
	ApiKeyStatusTool,
	EntrezQueryTool,
	DataManagerTool,
	ExternalAPIsTool,
};
