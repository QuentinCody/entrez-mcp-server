import { z } from "zod";

const tokenProfileSchema = z.object({
	typical: z.number(),
	upper: z.number().optional(),
});

const operationDescriptorSchema = z.object({
	name: z.string(),
	summary: z.string().optional(),
	required: z.array(z.any()).optional(),
	optional: z.array(z.any()).optional(),
	remarks: z.array(z.string()).optional(),
});

export const capabilityDescriptorSchema = z.object({
	tool: z.string(),
	summary: z.string(),
	operations: z.array(operationDescriptorSchema).optional(),
	contexts: z.array(z.string()).optional(),
	requiresApiKey: z.boolean().optional(),
	stageable: z.boolean().optional(),
	tokenProfile: tokenProfileSchema.optional(),
	metadata: z.record(z.unknown()).optional(),
	aliases: z.array(z.string()).optional(),
});

export const capabilitiesOutputSchema = z
	.object({
		success: z.boolean().optional(),
		tools: z.array(capabilityDescriptorSchema),
	})
	.passthrough();

export const toolInfoOutputSchema = z
	.object({
		success: z.boolean().optional(),
		tool: capabilityDescriptorSchema,
	})
	.passthrough();
