import { z } from "zod";
import {
	BaseTool,
	type ToolCapabilityDescriptor,
	type ToolContext,
} from "./base.js";
import { toolInfoOutputSchema } from "./tool-schemas.js";

const ToolInfoParamsShape = {
	tool: z.string().describe("Tool identifier or alias you want to inspect"),
	format: z
		.enum(["summary", "json"])
		.default("json")
		.describe("Response style; use json for structured metadata"),
	include_metadata: z
		.boolean()
		.optional()
		.describe("Include metadata digest (aliases, token estimates, etc.)"),
};

const ToolInfoParamsSchema = z.object(ToolInfoParamsShape);
type ToolInfoParams = z.infer<typeof ToolInfoParamsSchema>;

export class ToolInfoTool extends BaseTool {
	private describe: () => ToolCapabilityDescriptor[];

	constructor(
		context: ToolContext,
		describe: () => ToolCapabilityDescriptor[],
	) {
		super(context);
		this.describe = describe;
	}

	register(): void {
		this.registerTool(
			"entrez_tool_info",
			"Retrieve structured capability metadata for a specific tool.",
			ToolInfoParamsShape,
			async (params: ToolInfoParams) => {
				const descriptors = this.describe();
				const query = params.tool.toLowerCase();
				const match = descriptors.find((cap) => {
					const id = cap.tool.toLowerCase();
					const aliasList =
						(cap.metadata as { aliases?: string[] } | undefined)?.aliases ?? [];
					return (
						id === query ||
						aliasList.map((alias) => alias.toLowerCase()).includes(query)
					);
				});

				if (!match) {
					return this.errorResult(
						`No tool metadata found for '${params.tool}'`,
						[
							"Use 'entrez_capabilities' to list all tools",
							"Check tool name spelling or try an alias",
						],
					);
				}

				if (params.format === "json") {
					const payload = params.include_metadata
						? match
						: { ...match, metadata: undefined };
					return this.structuredResult(
						{ tool: payload },
						`Structured metadata for ${match.tool} (JSON)`,
					);
				}

		const operations = (match.operations ?? [])
			.map((op) => op.name)
			.join(", ");
		const summary = [
			`**${match.tool}**`,
			match.summary,
			operations
				? `Operations: ${operations}`
				: "No documented operations.",
		].join("\n");
		const toolPayload = params.include_metadata
			? match
			: { ...match, metadata: undefined };
		return this.structuredResult({ tool: toolPayload }, summary);
	},
			{
				title: "Tool Metadata Inspector",
				outputSchema: toolInfoOutputSchema,
			},
		);
	}

	override getCapabilities(): ToolCapabilityDescriptor {
		return {
			tool: "entrez_tool_info",
			summary:
				"Get per-tool metadata in structured JSON or human-readable form.",
			contexts: ["capability_discovery", "debugging"],
			metadata: {},
		};
	}
}
