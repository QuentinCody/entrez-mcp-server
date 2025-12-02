import { z, type ParseParams, type ZodTypeAny } from "zod";

/**
 * Ensure Zod v3 schemas expose safeParseAsync for compatibility with
 * MCP server helpers that always call safeParseAsync.
 */
export function ensureZodSafeParseAsync(): void {
	const proto = z.ZodType.prototype as ZodTypeAny & {
		safeParseAsync?: (value: unknown, params?: ParseParams) => Promise<unknown>;
	};

	if (!proto.safeParseAsync) {
		proto.safeParseAsync = async function (value: unknown, params?: ParseParams) {
			return this.safeParse(value, params);
		};
	}
}
