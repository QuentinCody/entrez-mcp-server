#!/usr/bin/env node

/**
 * NCBI API Rate Limit Testing Script
 *
 * This script tests the NCBI E-utilities rate limits:
 * - Without API key: 3 requests per second maximum
 * - With API key: 10 requests per second maximum
 *
 * The script uses the MCP tools directly to make requests and measure response times.
 */

// Set up environment
const TEST_WITHOUT_API_KEY = true;
const TEST_WITH_API_KEY = true;

// NCBI API key for testing (set this to your actual API key)
const NCBI_API_KEY = process.env.NCBI_API_KEY || null;

class NCBIRateLimitTester {
	constructor() {
		this.baseUrl = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/";
		this.defaultEmail = "entrez-mcp-server@example.com";
		this.defaultTool = "entrez-mcp-server";
		this.results = [];
	}

	/**
	 * Build URL with optional API key
	 */
	buildUrl(endpoint, params, includeApiKey) {
		const cleanParams = new URLSearchParams();
		params.forEach((value, key) => {
			if (value && value.trim() !== "") {
				cleanParams.append(key, value.trim());
			}
		});

		if (includeApiKey && NCBI_API_KEY) {
			cleanParams.append("api_key", NCBI_API_KEY);
		}

		return `${this.baseUrl}${endpoint}?${cleanParams}`;
	}

	/**
	 * Make a single ESearch request
	 */
	async makeRequest(query, includeApiKey = false) {
		const params = new URLSearchParams({
			db: "pubmed",
			term: query,
			retmax: "1",
			tool: this.defaultTool,
			email: this.defaultEmail,
			retmode: "json",
		});

		const url = this.buildUrl("esearch.fcgi", params, includeApiKey);
		const startTime = Date.now();

		try {
			const response = await fetch(url);
			const endTime = Date.now();
			const responseTime = endTime - startTime;

			const data = await response.text();

			// Check for rate limiting errors
			const isRateLimited =
				response.status === 429 ||
				data.includes("too many requests") ||
				data.includes("rate limit") ||
				data.includes("Too Many Requests") ||
				data.includes("Retry-After");

			return {
				status: response.status,
				responseTime,
				isRateLimited,
				success: response.ok && !isRateLimited,
				timestamp: startTime,
				hasApiKey: includeApiKey && !!NCBI_API_KEY,
			};
		} catch (error) {
			const endTime = Date.now();
			return {
				status: "ERROR",
				responseTime: endTime - startTime,
				isRateLimited: false,
				success: false,
				error: error.message,
				timestamp: startTime,
				hasApiKey: includeApiKey && !!NCBI_API_KEY,
			};
		}
	}

	/**
	 * Test rate limiting at a specific rate
	 */
	async testRate(requestsPerSecond, duration, includeApiKey = false) {
		const intervalMs = 1000 / requestsPerSecond;
		const totalRequests = Math.floor(duration * requestsPerSecond);

		console.log(
			`\n🧪 Testing ${requestsPerSecond} requests/second for ${duration} seconds`,
		);
		console.log(
			`   API Key: ${includeApiKey && NCBI_API_KEY ? "✅ Enabled" : "❌ Disabled"}`,
		);
		console.log(`   Interval: ${intervalMs}ms between requests`);
		console.log(`   Total requests: ${totalRequests}`);

		const results = [];
		const testQueries = [
			"covid-19",
			"diabetes",
			"cancer research",
			"alzheimer",
			"heart disease",
			"machine learning",
			"artificial intelligence",
			"genomics",
			"proteomics",
			"bioinformatics",
		];

		for (let i = 0; i < totalRequests; i++) {
			const query = testQueries[i % testQueries.length] + ` test ${i}`;

			const requestPromise = this.makeRequest(query, includeApiKey);
			results.push(requestPromise);

			// Progress indicator
			if (i > 0 && i % 5 === 0) {
				process.stdout.write(`📡 ${i}/${totalRequests} requests sent...\r`);
			}

			// Wait for the interval (except for the last request)
			if (i < totalRequests - 1) {
				await new Promise((resolve) => setTimeout(resolve, intervalMs));
			}
		}

		console.log(`\n⏳ Waiting for all ${totalRequests} responses...`);

		const responses = await Promise.all(results);

		// Analyze results
		const successful = responses.filter((r) => r.success).length;
		const rateLimited = responses.filter((r) => r.isRateLimited).length;
		const errors = responses.filter((r) => r.status === "ERROR").length;
		const avgResponseTime =
			responses.reduce((sum, r) => sum + r.responseTime, 0) / responses.length;

		const testResult = {
			requestsPerSecond,
			duration,
			totalRequests,
			successful,
			rateLimited,
			errors,
			successRate: (successful / totalRequests) * 100,
			avgResponseTime: Math.round(avgResponseTime),
			includeApiKey: includeApiKey && !!NCBI_API_KEY,
			responses,
		};

		this.results.push(testResult);

		console.log(`\n📊 Results:`);
		console.log(
			`   ✅ Successful: ${successful}/${totalRequests} (${testResult.successRate.toFixed(1)}%)`,
		);
		console.log(`   🚫 Rate Limited: ${rateLimited}`);
		console.log(`   ❌ Errors: ${errors}`);
		console.log(`   ⏱️  Avg Response Time: ${testResult.avgResponseTime}ms`);

		return testResult;
	}

	/**
	 * Run comprehensive rate limit tests
	 */
	async runTests() {
		console.log("🚀 Starting NCBI API Rate Limit Tests");
		console.log("=====================================");

		if (!NCBI_API_KEY) {
			console.log("⚠️  No NCBI_API_KEY environment variable found.");
			console.log("   Only testing unauthenticated rate limits.");
			console.log(
				"   To test authenticated limits, set NCBI_API_KEY environment variable.",
			);
		} else {
			console.log(`✅ NCBI API Key found: ${NCBI_API_KEY.substring(0, 8)}...`);
		}

		try {
			// Test 1: Unauthenticated rate limit (should work at 3 req/sec)
			if (TEST_WITHOUT_API_KEY) {
				console.log(
					"\n🔍 Test 1: Unauthenticated Rate Limit (3 req/sec - should succeed)",
				);
				await this.testRate(3, 5, false);

				// Test slightly above unauthenticated limit
				console.log(
					"\n🔍 Test 2: Above Unauthenticated Limit (5 req/sec - may get rate limited)",
				);
				await this.testRate(5, 3, false);
			}

			// Test 2: Authenticated rate limit (should work at 10 req/sec if API key is valid)
			if (TEST_WITH_API_KEY && NCBI_API_KEY) {
				console.log(
					"\n🔍 Test 3: Authenticated Rate Limit (10 req/sec - should succeed with valid API key)",
				);
				await this.testRate(10, 5, true);

				// Test above authenticated limit
				console.log(
					"\n🔍 Test 4: Above Authenticated Limit (15 req/sec - may get rate limited)",
				);
				await this.testRate(15, 3, true);
			}

			// Print summary
			this.printSummary();
		} catch (error) {
			console.error("❌ Error during testing:", error);
		}
	}

	/**
	 * Print test summary
	 */
	printSummary() {
		console.log("\n\n📈 Test Summary");
		console.log("===============");

		this.results.forEach((result, index) => {
			const apiKeyStatus = result.includeApiKey
				? "✅ With API Key"
				: "❌ Without API Key";
			const status =
				result.successRate >= 90
					? "✅ PASS"
					: result.successRate >= 70
						? "⚠️ PARTIAL"
						: "❌ FAIL";

			console.log(
				`\nTest ${index + 1}: ${result.requestsPerSecond} req/sec (${apiKeyStatus})`,
			);
			console.log(`  Status: ${status}`);
			console.log(`  Success Rate: ${result.successRate.toFixed(1)}%`);
			console.log(
				`  Rate Limited: ${result.rateLimited}/${result.totalRequests}`,
			);
			console.log(`  Avg Response: ${result.avgResponseTime}ms`);
		});

		// Recommendations
		console.log("\n💡 Recommendations:");

		const noApiKeyResults = this.results.filter((r) => !r.includeApiKey);
		const withApiKeyResults = this.results.filter((r) => r.includeApiKey);

		if (noApiKeyResults.length > 0) {
			const bestNoApiKey = Math.max(
				...noApiKeyResults
					.filter((r) => r.successRate >= 90)
					.map((r) => r.requestsPerSecond),
			);
			if (bestNoApiKey > 0) {
				console.log(
					`  • Without API key: Keep requests ≤ ${bestNoApiKey}/second`,
				);
			} else {
				console.log(
					`  • Without API key: All tested rates had issues - try lower rates`,
				);
			}
		}

		if (withApiKeyResults.length > 0) {
			const bestWithApiKey = Math.max(
				...withApiKeyResults
					.filter((r) => r.successRate >= 90)
					.map((r) => r.requestsPerSecond),
			);
			if (bestWithApiKey > 0) {
				console.log(
					`  • With API key: Can safely use up to ${bestWithApiKey}/second`,
				);
			} else {
				console.log(`  • With API key: Verify your API key is valid`);
			}
		}
	}
}

// Run the tests
if (require.main === module) {
	const tester = new NCBIRateLimitTester();
	tester.runTests().catch(console.error);
}

module.exports = NCBIRateLimitTester;
