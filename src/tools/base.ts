import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

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
}

export abstract class BaseTool {
	protected context: ToolContext;

	constructor(context: ToolContext) {
		this.context = context;
	}

	abstract register(): void;

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
