#!/usr/bin/env node

const baseUrl = (process.env.ENTREZ_MCP_URL || "http://localhost:8787").replace(/\/$/, "");
const mcpUrl = `${baseUrl}/mcp`;
const protocolVersion = "2025-11-25";

async function testMcpTransport() {
	console.log(`Testing Streamable HTTP transport at ${mcpUrl}`);
	const response = await fetch(mcpUrl, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
			"MCP-Protocol-Version": protocolVersion,
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				protocolVersion,
				capabilities: { tools: {} },
				clientInfo: { name: "test-mcp-transports", version: "1.0" },
			},
		}),
	});

	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`HTTP ${response.status} ${response.statusText} - ${text}`);
	}

	const payload = await parseStreamableResponse(response);
	if (payload.error) {
		throw new Error(`MCP initialize failed: ${JSON.stringify(payload.error)}`);
	}

	if (!payload.result || payload.result.isError) {
		throw new Error(`Unexpected MCP payload: ${JSON.stringify(payload.result)}`);
	}

	console.log("  → HTTP initialize succeeded");
}

async function parseStreamableResponse(response) {
	if (!response.body) {
		throw new Error("Empty response body for streamable payload");
	}

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	while (true) {
		const { value, done } = await reader.read();
		if (done) {
			break;
		}
		buffer += decoder.decode(value, { stream: true });
		const parsed = parseSsePayload(buffer);
		if (parsed) {
			await reader.cancel();
			return parsed;
		}
	}

	throw new Error("No JSON payload found in SSE stream");
}

function parseSsePayload(text) {
	const events = text
		.split(/\r?\n\r?\n/)
		.map((segment) => segment.trim())
		.filter(Boolean);
	for (const event of events) {
		const dataLines = event
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter((line) => line.toLowerCase().startsWith("data:"))
			.map((line) => line.replace(/^data:\s?/, ""));

		if (dataLines.length === 0) {
			continue;
		}

		const payload = dataLines.join("\n");
		try {
			return JSON.parse(payload);
		} catch (error) {
			continue;
		}
	}
	return null;
}

async function main() {
	console.log("MCP Transport Smoke Test");
	console.log("===========================\n");
	await testMcpTransport();
	console.log("\n✅ MCP transport checks completed successfully");
}

main().catch((error) => {
	console.error("\n❌ MCP transport check failed:", error.message || error);
	process.exitCode = 1;
});
