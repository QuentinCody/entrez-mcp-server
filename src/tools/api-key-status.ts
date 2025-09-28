import { z } from "zod";
import { BaseTool } from "./base.js";

export class ApiKeyStatusTool extends BaseTool {
	register(): void {
		this.context.server.tool(
			"system.api-key-status",
			"Report NCBI API key presence and summarise the effective rate limits.",
			{},
			async () => {
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

				return {
					content: [
						{
							type: "text",
							text: `NCBI API Key Status Report
================================

${status.message}
Rate Limit: ${status.rateLimit}

${helpMessage}

Need help? Run the rate limit tester:
node test-rate-limits.js`
						}
					]
				};
			}
		);
	}

	override getCapabilities() {
		return {
			ool: "system.api-key-status",
			summary: "Report on configured NCBI API key, rate limits, and setup guidance.",
			contexts: ["diagnostics", "environment_setup"],
			requiresApiKey: false,
			tokenProfile: { typical: 80 },
		};
	}

	private getApiKeyStatus(): { hasKey: boolean; message: string; rateLimit: string } {
		const apiKey = this.getApiKey();
		if (apiKey) {
			return {
				hasKey: true,
				message: `✅ NCBI API Key configured (${apiKey.substring(0, 8)}...)`,
				rateLimit: "10 requests/second"
			};
		} else {
			return {
				hasKey: false,
				message: "⚠️  No NCBI API Key found - using default rate limits",
				rateLimit: "3 requests/second"
			};
		}
	}
}
