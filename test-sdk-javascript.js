/**
 * Integration tests for JavaScript SDK
 *
 * Run with: node test-sdk-javascript.js
 */

import { EntrezSDK } from "./sdk/javascript/entrez-sdk.js";

// ANSI color codes for pretty output
const colors = {
	reset: "\x1b[0m",
	green: "\x1b[32m",
	red: "\x1b[31m",
	yellow: "\x1b[33m",
	blue: "\x1b[34m",
	cyan: "\x1b[36m",
};

function log(message, color = "reset") {
	console.log(`${colors[color]}${message}${colors.reset}`);
}

function logSection(title) {
	console.log("\n" + "=".repeat(60));
	log(title, "cyan");
	console.log("=".repeat(60) + "\n");
}

function logTest(name) {
	log(`Testing: ${name}`, "blue");
}

function logSuccess(message) {
	log(`✅ ${message}`, "green");
}

function logError(message) {
	log(`❌ ${message}`, "red");
}

function logWarning(message) {
	log(`⚠️  ${message}`, "yellow");
}

async function testBasicConnection(sdk) {
	logTest("Basic connection and API key status");
	try {
		const status = await sdk.getApiKeyStatus();
		logSuccess(`Connected! Rate limit: ${status}`);
		return true;
	} catch (error) {
		logError(`Connection failed: ${error.message}`);
		return false;
	}
}

async function testCapabilities(sdk) {
	logTest("Get capabilities");
	try {
		const capabilities = await sdk.getCapabilities({ format: "summary" });
		logSuccess("Capabilities retrieved successfully");
		return true;
	} catch (error) {
		logError(`Capabilities failed: ${error.message}`);
		return false;
	}
}

async function testSearch(sdk) {
	logTest("Search PubMed");
	try {
		const results = await sdk.search("pubmed", "CRISPR gene editing", {
			retmax: 3,
		});
		if (results.success && results.idlist && results.idlist.length > 0) {
			logSuccess(
				`Search successful: Found ${results.total_results} results, returned ${results.idlist.length} IDs`,
			);
			log(`  First ID: ${results.idlist[0]}`, "blue");
			return results.idlist;
		} else {
			logError("Search returned no results");
			return null;
		}
	} catch (error) {
		logError(`Search failed: ${error.message}`);
		return null;
	}
}

async function testSummary(sdk, ids) {
	logTest("Get summaries");
	try {
		const summary = await sdk.summary("pubmed", ids[0], {
			detailLevel: "brief",
		});
		logSuccess("Summary retrieved successfully");
		return true;
	} catch (error) {
		logError(`Summary failed: ${error.message}`);
		return false;
	}
}

async function testFetch(sdk, ids) {
	logTest("Fetch abstract");
	try {
		const article = await sdk.fetch("pubmed", ids[0], {
			rettype: "abstract",
			detailLevel: "brief",
		});
		logSuccess("Fetch successful");
		return true;
	} catch (error) {
		logError(`Fetch failed: ${error.message}`);
		return false;
	}
}

async function testDataStaging(sdk, ids) {
	logTest("Data staging and SQL queries");
	try {
		// Stage data
		const staging = await sdk.fetchAndStage("pubmed", ids.slice(0, 2));

		if (!staging.dataAccessId) {
			logError("Staging failed: No data_access_id returned");
			return false;
		}

		logSuccess(
			`Data staged with ID: ${staging.dataAccessId.substring(0, 16)}...`,
		);

		// Get schema
		const schema = await staging.getSchema();
		logSuccess(`Schema retrieved: ${schema.table_names?.join(", ")}`);

		// Query data
		const queryResult = await staging.query(
			"SELECT pmid, title FROM article LIMIT 2",
		);

		if (queryResult.success && queryResult.row_count > 0) {
			logSuccess(
				`SQL query successful: ${queryResult.row_count} rows returned`,
			);
			log(
				`  First title: ${queryResult.results[0]?.title?.substring(0, 60)}...`,
				"blue",
			);
			return true;
		} else {
			logError("SQL query returned no results");
			return false;
		}
	} catch (error) {
		logError(`Data staging failed: ${error.message}`);
		return false;
	}
}

async function testPubChem(sdk) {
	logTest("PubChem compound lookup");
	try {
		const compound = await sdk.getCompound("aspirin", "name");
		logSuccess("PubChem lookup successful");
		return true;
	} catch (error) {
		logError(`PubChem failed: ${error.message}`);
		return false;
	}
}

async function testErrorHandling(sdk) {
	logTest("Error handling with invalid database");
	try {
		await sdk.search("invalid_database", "test");
		logError("Should have thrown an error for invalid database");
		return false;
	} catch (error) {
		if (
			error.message.includes("Invalid database") ||
			error.message.includes("invalid_database")
		) {
			logSuccess("Error handling works correctly");
			return true;
		} else {
			logError(`Unexpected error: ${error.message}`);
			return false;
		}
	}
}

async function testArrayVsStringIds(sdk, ids) {
	logTest("ID parameter handling (array vs string)");
	try {
		// Test with array
		const result1 = await sdk.summary("pubmed", ids.slice(0, 2), {
			detailLevel: "brief",
		});

		// Test with comma-separated string
		const result2 = await sdk.summary("pubmed", ids.slice(0, 2).join(","), {
			detailLevel: "brief",
		});

		logSuccess("Both array and string ID formats work");
		return true;
	} catch (error) {
		logError(`ID format test failed: ${error.message}`);
		return false;
	}
}

async function runAllTests() {
	logSection("Entrez MCP Server - JavaScript SDK Integration Tests");

	const BASE_URL = process.env.BASE_URL || "http://localhost:8787";
	log(`Testing against: ${BASE_URL}`, "yellow");

	const sdk = new EntrezSDK(BASE_URL);

	const results = {
		passed: 0,
		failed: 0,
		total: 0,
	};

	function recordResult(success) {
		results.total++;
		if (success) {
			results.passed++;
		} else {
			results.failed++;
		}
		console.log("");
	}

	// Test suite
	logSection("1. Connection Tests");
	recordResult(await testBasicConnection(sdk));
	recordResult(await testCapabilities(sdk));

	logSection("2. Core E-utilities Tests");
	const searchIds = await testSearch(sdk);
	recordResult(searchIds !== null);

	if (searchIds && searchIds.length > 0) {
		recordResult(await testSummary(sdk, searchIds));
		recordResult(await testFetch(sdk, searchIds));
		recordResult(await testArrayVsStringIds(sdk, searchIds));
	} else {
		logWarning(
			"Skipping summary, fetch, and ID format tests (no search results)",
		);
		results.total += 3;
		results.failed += 3;
	}

	logSection("3. Data Staging Tests");
	if (searchIds && searchIds.length > 0) {
		recordResult(await testDataStaging(sdk, searchIds));
	} else {
		logWarning("Skipping data staging test (no search results)");
		results.total++;
		results.failed++;
	}

	logSection("4. External API Tests");
	recordResult(await testPubChem(sdk));

	logSection("5. Error Handling Tests");
	recordResult(await testErrorHandling(sdk));

	// Final summary
	logSection("Test Summary");
	log(`Total tests: ${results.total}`, "blue");
	log(`Passed: ${results.passed}`, "green");
	log(`Failed: ${results.failed}`, results.failed > 0 ? "red" : "green");

	const successRate = ((results.passed / results.total) * 100).toFixed(1);
	log(
		`\nSuccess rate: ${successRate}%`,
		successRate === "100.0" ? "green" : "yellow",
	);

	if (results.failed === 0) {
		log("\n🎉 All tests passed!", "green");
		process.exit(0);
	} else {
		log(`\n⚠️  ${results.failed} test(s) failed`, "red");
		process.exit(1);
	}
}

// Run tests
runAllTests().catch((error) => {
	logError(`Fatal error: ${error.message}`);
	console.error(error);
	process.exit(1);
});
