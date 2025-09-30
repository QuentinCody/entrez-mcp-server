import { z } from "zod";
import {
	BaseTool,
	type ToolCapabilityDescriptor,
	type ToolOperationDescriptor,
	type ToolContext,
} from "./base.js";

type DescribeFn = () => ToolCapabilityDescriptor[];

export class CapabilitiesTool extends BaseTool {
	private describe: DescribeFn;

	constructor(context: ToolContext, describe: DescribeFn) {
		super(context);
		this.describe = describe;
	}

	override register(): void {
		this.context.server.tool(
			"entrez-capabilities",
			"List the available tools, their operations, and guidance for usage.",
			{
				tool: z
					.string()
					.optional()
					.describe("Filter results to a single tool name"),
				format: z
					.enum(["summary", "detailed", "json"])
					.default("summary")
					.describe("Response style"),
				include_metadata: z
					.boolean()
					.optional()
					.describe("Include extended metadata when available"),
			},
			async (params) => {
				const { tool, format, include_metadata } = params;
				const capabilities = this.describe();

				const filtered = tool
					? capabilities.filter((cap) => {
							const id = cap.tool.toLowerCase();
							const query = tool.toLowerCase();
							return id === query || id.endsWith(query);
						})
					: capabilities;

				if (filtered.length === 0) {
					return {
						content: [
							{
								type: "text" as const,
								text: `No tool metadata found for '${tool}'. Use 'entrez-capabilities' with no arguments to list all tools.`,
							},
						],
					};
				}

				switch (format) {
					case "json":
						return this.respondWithJson(filtered, include_metadata);
					case "detailed":
						return this.respondDetailed(filtered, include_metadata);
					default:
						return this.respondSummary(filtered);
				}
			},
		);
	}

	override getCapabilities(): ToolCapabilityDescriptor {
		return {
			tool: "entrez-capabilities",
			summary:
				"Inspect available tools, operations, token profiles, and auth requirements.",
			contexts: ["capability_discovery", "debugging", "self_reflection"],
			metadata: {
				encouragesSelfDiscovery: true,
			},
		};
	}

	private respondSummary(descriptors: ToolCapabilityDescriptor[]) {
		const lines = descriptors
			.map((cap) => {
				const operations = (cap.operations ?? [])
					.map((op) => op.name)
					.join(", ");
				const summary = cap.summary;
				return `• ${cap.tool}: ${summary}${operations ? ` — operations: ${operations}` : ""}`;
			})
			.join("\n");

		return this.textResult(`**Registered Tools**\n${lines}`);
	}

	private respondDetailed(
		descriptors: ToolCapabilityDescriptor[],
		includeMetadata?: boolean,
	) {
		const sections = descriptors
			.map((cap) => {
				const header = `### ${cap.tool}\n${cap.summary}`;
				const operations = (cap.operations ?? [])
					.map((op) => this.formatOperation(op))
					.join("\n\n");

				const metaLines: string[] = [];
				if (cap.requiresApiKey)
					metaLines.push("- Requires API key for optimal throughput");
				if (cap.stageable)
					metaLines.push("- Supports durable staging for large responses");
				if (cap.tokenProfile) {
					const tokenBits = cap.tokenProfile.upper
						? `${cap.tokenProfile.typical} typical / ${cap.tokenProfile.upper} upper estimate`
						: `${cap.tokenProfile.typical} typical`;
					metaLines.push(`- Token profile: ${tokenBits}`);
				}
				if (includeMetadata && cap.metadata) {
					metaLines.push(`- Metadata: ${JSON.stringify(cap.metadata)}`);
				}
				const meta = metaLines.length > 0 ? `\n${metaLines.join("\n")}` : "";

				return [header, operations, meta].filter(Boolean).join("\n\n");
			})
			.join("\n\n---\n\n");

		return this.textResult(`**Tool Capability Guide**\n\n${sections}`);
	}

	private respondWithJson(
		descriptors: ToolCapabilityDescriptor[],
		includeMetadata?: boolean,
	) {
		const sanitized = descriptors.map((cap) => {
			if (includeMetadata) return cap;
			const { metadata: _metadata, ...rest } = cap;
			return rest;
		});
		const json = JSON.stringify({ tools: sanitized }, null, 2);
		return this.textResult(`\`\`\`json\n${json}\n\`\`\``);
	}

	private formatOperation(operation: ToolOperationDescriptor): string {
		const requiredParams =
			operation.required.length > 0
				? `Required: ${operation.required.map((param) => this.formatParam(param)).join(", ")}`
				: "Required: none";
		const optionalParams =
			operation.optional.length > 0
				? `Optional: ${operation.optional.map((param) => this.formatParam(param)).join(", ")}`
				: "Optional: none";
		const remarks = operation.remarks?.map((note) => `- ${note}`).join("\n");
		return [
			`**${operation.name}** — ${operation.summary}`,
			requiredParams,
			optionalParams,
			remarks,
		]
			.filter(Boolean)
			.join("\n");
	}

	private formatParam(param: {
		name: string;
		type: string;
		description: string;
		defaultValue?: unknown;
		values?: string[];
	}): string {
		const defaultSuffix =
			param.defaultValue !== undefined
				? ` (default: ${param.defaultValue})`
				: "";
		const valuesSuffix =
			param.values && param.values.length > 0
				? ` [${param.values.join(", ")}]`
				: "";
		return `${param.name}: ${param.type}${defaultSuffix}${valuesSuffix} — ${param.description}`;
	}
}
