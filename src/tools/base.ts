import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

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
	// biome-ignore lint/suspicious/noExplicitAny: shared context needs to accommodate heterogeneous tool responses
	parseResponse(
		response: Response,
		toolName: string,
		requestedRetmode?: string,
	): Promise<string | any>;
	// biome-ignore lint/suspicious/noExplicitAny: shared context needs to accommodate heterogeneous tool responses
	formatResponseData(data: any): string;
	buildUrl(endpoint: string, params: URLSearchParams): string;
	// biome-ignore lint/suspicious/noExplicitAny: shared context needs to accommodate heterogeneous tool responses
	shouldBypassStaging(
		processedData: any[],
		diagnostics: any,
		payloadSize: number,
	): { bypass: boolean; reason: string };
	getOptimalRetmode(
		tool: string,
		database: string,
		intendedUse?: string,
	): string;
	shouldStageResponse(
		data: string,
		toolName: string,
	): { shouldStage: boolean; reason: string; estimatedTokens: number };
	validateQuery(
		query: string,
		database: string,
	): { valid: boolean; message?: string; suggestion?: string };
	suggestQueryImprovements(query: string, database: string): string[];
}

// MCP 2025-11-25 Specification-compliant content types

/**
 * Annotations for content items per MCP spec
 * Used to provide metadata about audience, priority, and modification times
 */
export interface Annotations {
	audience?: ("user" | "assistant")[];
	priority?: number; // 0-1 scale
	lastModified?: string; // ISO 8601 timestamp
}

/**
 * Text content type
 */
export interface TextContent {
	type: "text";
	text: string;
	annotations?: Annotations;
}

/**
 * Image content type
 */
export interface ImageContent {
	type: "image";
	data: string; // base64-encoded
	mimeType: string;
	annotations?: Annotations;
}

/**
 * Audio content type
 */
export interface AudioContent {
	type: "audio";
	data: string; // base64-encoded
	mimeType: string;
	annotations?: Annotations;
}

/**
 * Resource link type - references a resource that can be fetched
 */
export interface ResourceLinkContent {
	type: "resource_link";
	uri: string;
	name?: string;
	description?: string;
	mimeType?: string;
	annotations?: Annotations;
}

/**
 * Embedded resource type - includes the full resource content
 */
export interface EmbeddedResourceContent {
	type: "resource";
	resource: {
		uri: string;
		mimeType?: string;
		text?: string;
		blob?: string; // base64-encoded
		annotations?: Annotations;
	};
}

/**
 * Union type of all supported content types
 */
export type ToolContent =
	| TextContent
	| ImageContent
	| AudioContent
	| ResourceLinkContent
	| EmbeddedResourceContent;

/**
 * Tool result structure per MCP spec
 */
export interface ToolResult {
	content: ToolContent[];
	isError?: boolean; // Flag for tool execution errors
	_meta?: Record<string, unknown>; // Internal metadata (not part of MCP spec)
	structuredContent?: Record<string, unknown>; // For structured responses
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

	/**
	 * Create a basic tool result with content
	 */
	protected result(content: ToolContent[], isError = false): ToolResult {
		return { content, isError };
	}

	/**
	 * Create text content with optional annotations
	 */
	protected textContent(text: string, annotations?: Annotations): TextContent {
		return annotations
			? { type: "text", text, annotations }
			: { type: "text", text };
	}

	/**
	 * Create image content with base64-encoded data
	 */
	protected imageContent(
		data: string,
		mimeType: string,
		annotations?: Annotations,
	): ImageContent {
		return annotations
			? { type: "image", data, mimeType, annotations }
			: { type: "image", data, mimeType };
	}

	/**
	 * Create audio content with base64-encoded data
	 */
	protected audioContent(
		data: string,
		mimeType: string,
		annotations?: Annotations,
	): AudioContent {
		return annotations
			? { type: "audio", data, mimeType, annotations }
			: { type: "audio", data, mimeType };
	}

	/**
	 * Create a resource link
	 */
	protected resourceLink(
		uri: string,
		options?: {
			name?: string;
			description?: string;
			mimeType?: string;
			annotations?: Annotations;
		},
	): ResourceLinkContent {
		return {
			type: "resource_link",
			uri,
			...options,
		};
	}

	/**
	 * Create an embedded resource
	 */
	protected embeddedResource(
		uri: string,
		content: { text?: string; blob?: string },
		options?: {
			mimeType?: string;
			annotations?: Annotations;
		},
	): EmbeddedResourceContent {
		return {
			type: "resource",
			resource: {
				uri,
				...content,
				...options,
			},
		};
	}

	/**
	 * Create a simple text result from one or more messages
	 */
	// biome-ignore lint/suspicious/noExplicitAny: helper returns MCP-compatible payload without rigid typing
	protected textResult(...messages: string[]): ToolResult {
		return this.result(messages.map((message) => this.textContent(message)));
	}

	/**
	 * Create an error result with tool execution error flag
	 * Per MCP spec, tool execution errors should have isError: true
	 */
	protected errorResult(
		errorMessage: string,
		additionalContext?: string[],
	): ToolResult {
		const content: ToolContent[] = [this.textContent(errorMessage)];
		if (additionalContext) {
			content.push(...additionalContext.map((ctx) => this.textContent(ctx)));
		}
		return { content, isError: true };
	}

	/**
	 * Create a structured result with both human-readable and machine-readable content
	 * Per MCP spec, should include both text content and structuredContent for backwards compatibility
	 */
	protected structuredResult(
		payload: Record<string, unknown>,
		summary?: string | string[],
		annotations?: Annotations,
	): ToolResult {
		// Always include text serialization for backwards compatibility
		const textSummary = summary
			? Array.isArray(summary)
				? summary
				: [summary]
			: [JSON.stringify(payload, null, 2)];

		const content = textSummary.map((text) =>
			this.textContent(text, annotations),
		);

		return {
			content,
			structuredContent: {
				...payload,
				success: payload.success ?? true,
			},
		};
	}

	protected buildUrl(endpoint: string, params: URLSearchParams): string {
		return this.context.buildUrl(endpoint, params);
	}

	protected async parseResponse(
		response: Response,
		toolName: string,
		requestedRetmode?: string,
	): Promise<string | any> {
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

	/**
	 * Helper to create a proper empty input schema per MCP spec
	 * For tools with no parameters, use { type: "object", additionalProperties: false }
	 */
	protected emptySchema() {
		return z.object({});
	}

	/**
	 * Register a tool with the MCP server
	 * Supports title, outputSchema, and aliases per MCP 2025-11-25 spec
	 */
	protected registerTool(
		name: string,
		description: string,
		// biome-ignore lint/suspicious/noExplicitAny: MCP server accepts heterogeneous schemas
		schema: any,
		// biome-ignore lint/suspicious/noExplicitAny: MCP server accepts heterogeneous handlers
		handler: any,
		options?: {
			aliases?: string[];
			title?: string;
			// biome-ignore lint/suspicious/noExplicitAny: outputSchema accepts any valid JSON Schema
			outputSchema?: any;
			annotations?: Record<string, unknown>;
		},
	): void {
		// Validate tool name per MCP spec (1-128 chars, specific character set)
		if (name.length < 1 || name.length > 128) {
			throw new Error(
				`Tool name "${name}" must be between 1 and 128 characters`,
			);
		}
		if (!/^[A-Za-z0-9_.-]+$/.test(name)) {
			throw new Error(
				`Tool name "${name}" contains invalid characters. Only A-Z, a-z, 0-9, _, -, and . are allowed`,
			);
		}

		// Register the main tool using SDK's registerTool() method for full support
		// biome-ignore lint/suspicious/noExplicitAny: config object accepts various schema types
		const config: any = {
			description,
			inputSchema: schema,
		};

		if (options?.title) {
			config.title = options.title;
		}

		if (options?.outputSchema) {
			config.outputSchema = options.outputSchema;
		}

		if (options?.annotations) {
			config.annotations = options.annotations;
		}

		this.context.server.registerTool(name, config, handler);

		// Register aliases if provided (using simpler tool() method for aliases)
		if (options?.aliases) {
			for (const alias of options.aliases) {
				this.context.server.tool(
					alias,
					`${description} (alias for ${name})`,
					schema,
					handler,
				);
			}
		}
	}
}
