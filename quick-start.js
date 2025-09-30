#!/usr/bin/env node

/**
 * NCBI Entrez MCP Server - Quick Start Guide
 *
 * This script helps you get started with the NCBI MCP Server and test your setup.
 */

const NCBIRateLimitTester = require("./test-rate-limits.js");

class QuickStartGuide {
	constructor() {
		this.apiKey = process.env.NCBI_API_KEY;
	}

	async run() {
		console.log("🚀 NCBI Entrez MCP Server - Quick Start");
		console.log("=======================================\n");

		// Step 1: Check current setup
		await this.checkSetup();

		// Step 2: Offer to run tests
		await this.offerTesting();

		// Step 3: Next steps
		this.showNextSteps();
	}

	async checkSetup() {
		console.log("📋 Checking Your Setup");
		console.log("----------------------");

		// Check API key
		if (this.apiKey) {
			console.log(`✅ NCBI API Key: Found (${this.apiKey.substring(0, 8)}...)`);
			console.log(`   Rate Limit: 10 requests/second`);
		} else {
			console.log("⚠️  NCBI API Key: Not found");
			console.log("   Rate Limit: 3 requests/second (default)");
		}

		// Check Node.js version
		const nodeVersion = process.version;
		console.log(`✅ Node.js: ${nodeVersion}`);

		// Check if test file exists
		const fs = require("node:fs");
		if (fs.existsSync("./test-rate-limits.js")) {
			console.log("✅ Rate limit tester: Available");
		} else {
			console.log("❌ Rate limit tester: Missing");
		}

		console.log();
	}

	async offerTesting() {
		console.log("🧪 Testing Options");
		console.log("------------------");

		if (!this.apiKey) {
			console.log(
				"Since no API key is configured, we'll test the default rate limits.",
			);
			console.log("This helps verify the server is working correctly.\n");

			console.log("Running basic rate limit test...\n");

			try {
				const tester = new NCBIRateLimitTester();
				// Run a quick test without API key
				await tester.testRate(2, 3, false); // Conservative test

				console.log("\n✅ Basic functionality test passed!");
				console.log("   The server is working correctly without an API key.");
			} catch (error) {
				console.log("\n❌ Test failed:", error.message);
				console.log("   There may be a network issue or NCBI service is down.");
			}
		} else {
			console.log(
				"API key detected! Running comprehensive rate limit tests...\n",
			);

			try {
				const tester = new NCBIRateLimitTester();

				// Test without API key first
				console.log("Testing baseline (without API key):");
				const baselineResult = await tester.testRate(2, 2, false);

				// Test with API key
				console.log("\nTesting with API key:");
				const apiKeyResult = await tester.testRate(8, 2, true);

				// Compare results
				if (apiKeyResult.successRate > baselineResult.successRate) {
					console.log("\n✅ API Key is working correctly!");
					console.log(
						`   Improvement: ${(apiKeyResult.successRate - baselineResult.successRate).toFixed(1)}% better success rate`,
					);
				} else {
					console.log("\n⚠️  API Key may not be working properly");
					console.log("   Check that your API key is valid and correctly set");
				}
			} catch (error) {
				console.log("\n❌ Test failed:", error.message);
			}
		}
	}

	showNextSteps() {
		console.log("\n🎯 Next Steps");
		console.log("-------------");

		if (!this.apiKey) {
			console.log("To get 3x better performance, set up your free API key:");
			console.log(
				"1. Visit: https://ncbiinsights.ncbi.nlm.nih.gov/2017/11/02/new-api-keys-for-the-e-utilities/",
			);
			console.log("2. Get your API key (takes 30 seconds)");
			console.log('3. Set it: export NCBI_API_KEY="your_key_here"');
			console.log("4. Restart and run: node quick-start.js");
			console.log("5. Read API_KEY_SETUP.md for detailed instructions");
		} else {
			console.log("Your setup is optimized! You can now:");
			console.log("1. Start the server: npm start");
			console.log("2. Connect to Claude Desktop or AI Playground");
			console.log("3. Use the NCBI tools at full speed");
		}

		console.log("\n📚 Available Commands:");
		console.log("  npm start          - Start the MCP server");
		console.log("  npm run test       - Run comprehensive rate limit tests");
		console.log("  npm run check-setup - Quick setup check");
		console.log("  npm run setup-help - Show setup instructions");

		console.log("\n🔍 Available NCBI Tools:");
		console.log(
			"  - entrez-query        - Unified E-utilities surface (search, summary, fetch, link)",
		);
		console.log(
			"  - entrez-data         - Stage datasets and run SQL or smart summaries",
		);
		console.log(
			"  - entrez-external     - PubChem + PMC helpers in one interface",
		);
		console.log(
			"  - entrez-capabilities - Inspect tool signatures and token profiles",
		);
		console.log("  - system-api-key-status - Check API key configuration");

		console.log("\n🎉 You're ready to go! Happy researching! 🧬");
	}
}

// Run the quick start guide
if (require.main === module) {
	const guide = new QuickStartGuide();
	guide.run().catch(console.error);
}

module.exports = QuickStartGuide;
