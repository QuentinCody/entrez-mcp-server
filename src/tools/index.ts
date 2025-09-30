import type { ToolContext, ToolCapabilityDescriptor } from "./base.js";
import { ApiKeyStatusTool } from "./api-key-status.js";
import { EntrezQueryTool } from "./consolidated-entrez.js";
import { DataManagerTool } from "./consolidated-data.js";
import { ExternalAPIsTool } from "./consolidated-external.js";
import { CapabilitiesTool } from "./capabilities.js";

type ToolInstance = {
	instance: {
		register: () => void;
		getCapabilities: () => ToolCapabilityDescriptor;
	};
};

export class ToolRegistry {
	private tools: ToolInstance[] = [];

	constructor(context: ToolContext) {
		const coreTools = [
			new ApiKeyStatusTool(context),
			new EntrezQueryTool(context),
			new DataManagerTool(context),
			new ExternalAPIsTool(context),
		];

		this.tools = coreTools.map((instance) => ({ instance }));

		// Introspection tool needs access to registry view, so inject callback
		const capabilitiesTool = new CapabilitiesTool(context, () =>
			this.getCapabilities(),
		);
		this.tools.push({ instance: capabilitiesTool });
	}

	registerAll(): void {
		this.tools.forEach(({ instance }) => instance.register());
	}

	getCapabilities(): ToolCapabilityDescriptor[] {
		return this.tools.map(({ instance }) => instance.getCapabilities());
	}
}

// Export types and consolidated tool classes
export type { ToolContext };
export {
	ApiKeyStatusTool,
	EntrezQueryTool,
	DataManagerTool,
	ExternalAPIsTool,
	CapabilitiesTool,
};
