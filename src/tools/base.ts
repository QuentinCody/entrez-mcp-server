import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export interface ParameterDescriptor {
	name: string;
	type: string;
	description: string;
	defaultValue?: unknown;
	values?: string[];
}

export interface ToolOperationDescriptor {
	name: string;
	summary: string;
	required: ParameterDescriptor[];
	optional: ParameterDescriptor[];
	remarks?: string[];
}

export interface ToolCapabilityDescriptor {
	tool: string;
	summary: string;
	operations?: ToolOperationDescriptor[];
	contexts?: string[];
	requiresApiKey?: boolean;
	stageable?: boolean;
	tokenProfile?: {
		typical: number;
		upper?: number;
	};
	metadata?: Record<string, unknown>;
}

export interface ToolContext {
	server: McpServer;
	baseUrl: string;
	defaultEmail: string;
	defaultTool: string;
	getApiKey(): string | undefined;
	getEnvironment(): Env | undefined;
	isValidDatabase(db: string): boolean;
	parseResponse(response: Response, toolName: string, requestedRetmode?: string): Promise<string | any>;
	formatResponseData(data: any): string;
	buildUrl(endpoint: string, params: URLSearchParams): string;
	shouldBypassStaging(processedData: any[], diagnostics: any, payloadSize: number): { bypass: boolean; reason: string };
	getOptimalRetmode(tool: string, database: string, intendedUse?: string): string;
	shouldStageResponse(data: string, toolName: string): { shouldStage: boolean; reason: string; estimatedTokens: number };
	validateQuery(query: string, database: string): { valid: boolean; message?: string; suggestion?: string };
	suggestQueryImprovements(query: string, database: string): string[];
}

export abstract class BaseTool {
	protected context: ToolContext;

	constructor(context: ToolContext) {
		this.context = context;
	}

	abstract register(): void;

	// Tools can override to describe capabilities for introspection
	getCapabilities(): ToolCapabilityDescriptor {
		return {
			tool: "unknown",
			summary: "No capability metadata provided.",
		};
	}

	protected buildUrl(endpoint: string, params: URLSearchParams): string {
		return this.context.buildUrl(endpoint, params);
	}

	protected async parseResponse(response: Response, toolName: string, requestedRetmode?: string): Promise<string | any> {
		return this.context.parseResponse(response, toolName, requestedRetmode);
	}

	protected formatResponseData(data: any): string {
		return this.context.formatResponseData(data);
	}

	protected isValidDatabase(db: string): boolean {
		return this.context.isValidDatabase(db);
	}

	protected getApiKey(): string | undefined {
		return this.context.getApiKey();
	}

	protected getEnvironment(): Env | undefined {
		return this.context.getEnvironment();
	}
}
