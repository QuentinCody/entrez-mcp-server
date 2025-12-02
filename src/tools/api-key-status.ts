import { BaseTool } from "./base.js";

export class ApiKeyStatusTool extends BaseTool {
	register(): void {
		this.registerTool(
			"system_api_key_status",
			"Report NCBI API key presence and summarise the effective rate limits.",
			this.emptySchema(), // Per MCP spec: use proper empty schema for tools with no parameters
			async () => {
				try {
					const status = this.getApiKeyStatus();

					const helpMessage = status.hasKey
						? `Your NCBI API key is properly configured and active! You can make up to ${status.rateLimit}.`
						: `No API key configured. You're limited to ${status.rateLimit}.

To get 3x better performance:
1. Get your free API key: https://ncbiinsights.ncbi.nlm.nih.gov/2017/11/02/new-api-keys-for-the-e-utilities/
2. Set environment variable: NCBI_API_KEY="your_key_here"
3. Restart the server
4. Run this tool again to verify

See API_KEY_SETUP.md for detailed instructions.`;

					const report = `NCBI API Key Status Report
================================

${status.message}
Rate Limit: ${status.rateLimit}

${helpMessage}

Need help? Run the rate limit tester:
node test-rate-limits.js`;

					// Return structured result with both text and structured content
					return this.structuredResult(
						{
							hasKey: status.hasKey,
							rateLimit: status.rateLimit,
							message: status.message,
						},
						report,
					);
				} catch (error) {
					// Return tool execution error per MCP spec
					return this.errorResult(
						`Failed to check API key status: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			},
			{
				title: "NCBI API Key Status Reporter",
				outputSchema: {
					type: "object",
					properties: {
						hasKey: {
							type: "boolean",
							description: "Whether an API key is configured",
						},
						rateLimit: {
							type: "string",
							description: "Current rate limit (requests per second)",
						},
						message: {
							type: "string",
							description: "Human-readable status message",
						},
					},
					required: ["hasKey", "rateLimit", "message"],
				},
			},
		);
	}

	override getCapabilities() {
		return {
			tool: "system_api_key_status",
			summary:
				"Report on configured NCBI API key, rate limits, and setup guidance.",
			contexts: ["diagnostics", "environment_setup"],
			requiresApiKey: false,
			tokenProfile: { typical: 80 },
		};
	}

	private getApiKeyStatus(): {
		hasKey: boolean;
		message: string;
		rateLimit: string;
	} {
		const apiKey = this.getApiKey();
		if (apiKey) {
			return {
				hasKey: true,
				message: `✅ NCBI API Key configured (${apiKey.substring(0, 8)}...)`,
				rateLimit: "10 requests/second",
			};
		} else {
			return {
				hasKey: false,
				message: "⚠️  No NCBI API Key found - using default rate limits",
				rateLimit: "3 requests/second",
			};
		}
	}
}
