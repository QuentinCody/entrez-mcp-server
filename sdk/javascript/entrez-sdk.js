/**
 * Entrez MCP Server - JavaScript/TypeScript SDK
 *
 * This SDK provides a clean interface for calling MCP tools via code execution.
 * It handles parameter validation, error handling, and response formatting.
 *
 * Usage:
 *   const sdk = new EntrezSDK('http://localhost:8787');
 *   const results = await sdk.search('pubmed', 'CRISPR gene editing');
 */

export class EntrezSDK {
	constructor(baseUrl = "http://localhost:8787") {
		this.baseUrl = baseUrl.replace(/\/$/, ""); // Remove trailing slash
		this.sessionId = null;
		this.protocolVersion = "2025-11-25";
		this.clientInfo = {
			name: "entrez-mcp-sdk",
			version: "1.0.0",
		};
		this.clientCapabilities = {
			tools: {},
		};
	}

	/**
	 * Make a raw MCP tool call
	 * @private
	 */
	async _call(toolName, params) {
		await this._ensureSession();
		return await this._requestPayload(toolName, "tools/call", {
			name: toolName,
			arguments: params,
		});
	}

	_formatContext(context) {
		const trimmed = context.trim();
		if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
			return trimmed;
		}
		return `[${trimmed}]`;
	}

	_buildHeaders() {
		const headers = {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
			"MCP-Protocol-Version": this.protocolVersion,
		};
		if (this.sessionId) {
			headers["Mcp-Session-Id"] = this.sessionId;
		}
		return headers;
	}

	_extractSessionId(response) {
		const newSessionId = response.headers.get("mcp-session-id");
		if (newSessionId) {
			this.sessionId = newSessionId;
		}
	}

	async _requestPayload(context, method, params) {
		const url = `${this.baseUrl}/mcp`;
		const headers = this._buildHeaders();
		const label = this._formatContext(context);

		const response = await fetch(url, {
			method: "POST",
			headers,
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: Date.now(),
				method,
				params,
			}),
		});

		this._extractSessionId(response);

		const responseText = await response.text();

		if (!response.ok) {
			const details = responseText ? ` Response: ${responseText}` : "";
			throw new Error(
				`${label} HTTP ${response.status}: ${response.statusText}.${details}`,
			);
		}

		const result = this._parseResponseText(responseText);

		if (result.error) {
			throw new Error(
				`${label} MCP Error: ${result.error.message || JSON.stringify(result.error)}`,
			);
		}

		const payload = result.result;
		if (!payload) {
			return null;
		}

		if (this._isErrorPayload(payload)) {
			const errorMessage = this._getPayloadErrorMessage(payload);
			throw new Error(`${label} ${errorMessage}`);
		}

		const normalized = payload.structuredContent
			? {
					...payload.structuredContent,
					content: payload.content,
				}
			: payload;

		return normalized;
	}

	_parseResponseText(text) {
		const trimmed = text.trim();
		if (!trimmed) {
			return {};
		}

		try {
			return JSON.parse(trimmed);
		} catch (error) {
			return this._parseSsePayload(trimmed);
		}
	}

	_parseSsePayload(text) {
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
			}
		}

		throw new Error("No JSON payload found in SSE response");
	}

	_isErrorPayload(payload) {
		if (!payload || !Array.isArray(payload.content)) {
			return false;
		}
		return payload.content.some(
			(block) =>
				block &&
				block.type === "text" &&
				typeof block.text === "string" &&
				block.text.trim().startsWith("❌"),
		);
	}

	_getPayloadErrorMessage(payload) {
		if (!payload || !Array.isArray(payload.content)) {
			return "Unknown error";
		}
		const errorBlock = payload.content.find(
			(block) =>
				block &&
				block.type === "text" &&
				typeof block.text === "string" &&
				block.text.trim().startsWith("❌"),
		);
		if (errorBlock && typeof errorBlock.text === "string") {
			return errorBlock.text.trim();
		}
		const combined = payload.content
			.map((block) => (typeof block?.text === "string" ? block.text : ""))
			.filter(Boolean)
			.join(" ");
		return combined || "Unknown error";
	}

	async _initializeSession() {
		await this._requestPayload("initialize", "initialize", {
			protocolVersion: this.protocolVersion,
			capabilities: this.clientCapabilities,
			clientInfo: this.clientInfo,
		});
	}

	async _ensureSession() {
		if (this.sessionId) {
			return;
		}
		await this._initializeSession();
	}

	/**
	 * Check API key status and rate limits
	 */
	async getApiKeyStatus() {
		return await this._call("system_api_key_status", {});
	}

	/**
	 * Get tool capabilities
	 */
	async getCapabilities(options = {}) {
		return await this._call("entrez_capabilities", {
			format: options.format || "summary",
			tool: options.tool,
			include_metadata: options.includeMetadata,
		});
	}

	/**
	 * Get detailed info about a specific tool
	 */
	async getToolInfo(toolName, format = "json") {
		return await this._call("entrez_tool_info", {
			tool: toolName,
			format,
			include_metadata: true,
		});
	}

	// ========================================
	// ENTREZ QUERY TOOLS (entrez_query)
	// ========================================

	/**
	 * Search a database with a query term
	 */
	async search(database, term, options = {}) {
		return await this._call("entrez_query", {
			operation: "search",
			database,
			term,
			retmax: options.retmax || 20,
			retstart: options.retstart,
			sort: options.sort,
			field: options.field,
			intended_use: options.intendedUse,
		});
	}

	/**
	 * Get summaries for specific IDs
	 */
	async summary(database, ids, options = {}) {
		// Ensure ids is a string
		const idsStr = Array.isArray(ids) ? ids.join(",") : String(ids);

		return await this._call("entrez_query", {
			operation: "summary",
			database,
			ids: idsStr,
			retmax: options.retmax,
			compact_mode: options.compactMode,
			detail_level: options.detailLevel,
			max_tokens: options.maxTokens,
		});
	}

	/**
	 * Fetch detailed records for specific IDs
	 */
	async fetch(database, ids, options = {}) {
		const idsStr = Array.isArray(ids) ? ids.join(",") : String(ids);

		return await this._call("entrez_query", {
			operation: "fetch",
			database,
			ids: idsStr,
			rettype: options.rettype,
			intended_use: options.intendedUse,
			detail_level: options.detailLevel,
		});
	}

	/**
	 * Get database information
	 */
	async info(database) {
		return await this._call("entrez_query", {
			operation: "info",
			database,
		});
	}

	/**
	 * Find links between databases
	 */
	async link(database, ids, options = {}) {
		const idsStr = Array.isArray(ids) ? ids.join(",") : String(ids);

		return await this._call("entrez_query", {
			operation: "link",
			database,
			ids: idsStr,
			dbfrom: options.dbfrom,
			linkname: options.linkname,
		});
	}

	/**
	 * Post IDs to history server
	 */
	async post(database, ids, options = {}) {
		const idsStr = Array.isArray(ids) ? ids.join(",") : String(ids);

		return await this._call("entrez_query", {
			operation: "post",
			database,
			ids: idsStr,
			usehistory: options.usehistory || "y",
		});
	}

	/**
	 * Global query across all databases
	 */
	async globalQuery(term) {
		return await this._call("entrez_query", {
			operation: "global_query",
			term,
		});
	}

	/**
	 * Get spelling suggestions
	 */
	async spell(term, database = "pubmed") {
		return await this._call("entrez_query", {
			operation: "spell",
			database,
			term,
		});
	}

	// ========================================
	// DATA STAGING TOOLS (entrez_data)
	// ========================================

	/**
	 * Fetch and stage data into SQL database
	 */
	async fetchAndStage(database, ids, options = {}) {
		const idsStr = Array.isArray(ids) ? ids.join(",") : String(ids);

		const result = await this._call("entrez_data", {
			operation: "fetch_and_stage",
			database,
			ids: idsStr,
			rettype: options.rettype || "xml",
			force_direct: options.forceDirect,
			include_raw: options.includeRaw,
		});

		// Return a DataStaging object for convenience
		if (result.data_access_id) {
			return new DataStaging(this, result.data_access_id, result);
		}

		return result;
	}

	/**
	 * Query staged data with SQL
	 */
	async queryStagedData(dataAccessId, sql, options = {}) {
		return await this._call("entrez_data", {
			operation: "query",
			data_access_id: dataAccessId,
			sql,
			intended_use: options.intendedUse,
			max_tokens: options.maxTokens,
			response_style: options.responseStyle || "text",
		});
	}

	/**
	 * Get smart summary of staged data
	 */
	async getSmartSummary(dataAccessId, options = {}) {
		return await this._call("entrez_data", {
			operation: "query",
			data_access_id: dataAccessId,
			smart_summary: true,
			intended_use: options.intendedUse || "analysis",
			max_tokens: options.maxTokens,
		});
	}

	/**
	 * Get schema for staged data
	 */
	async getSchema(dataAccessId) {
		return await this._call("entrez_data", {
			operation: "schema",
			data_access_id: dataAccessId,
		});
	}

	/**
	 * List all staged datasets
	 */
	async listDatasets() {
		return await this._call("entrez_data", {
			operation: "list_datasets",
		});
	}

	// ========================================
	// EXTERNAL APIS (entrez_external)
	// ========================================

	/**
	 * Get PubChem compound data
	 */
	async getCompound(
		identifier,
		identifierType = "name",
		outputFormat = "json",
	) {
		return await this._call("entrez_external", {
			service: "pubchem",
			operation: "compound",
			identifier,
			identifier_type: identifierType,
			output_format: outputFormat,
		});
	}

	/**
	 * Get PubChem substance data
	 */
	async getSubstance(
		identifier,
		identifierType = "sid",
		outputFormat = "json",
	) {
		return await this._call("entrez_external", {
			service: "pubchem",
			operation: "substance",
			identifier,
			identifier_type: identifierType,
			output_format: outputFormat,
		});
	}

	/**
	 * Get PubChem bioassay data
	 */
	async getBioassay(identifier, identifierType = "aid", outputFormat = "json") {
		return await this._call("entrez_external", {
			service: "pubchem",
			operation: "bioassay",
			identifier,
			identifier_type: identifierType,
			output_format: outputFormat,
		});
	}

	/**
	 * Search PubChem by chemical structure
	 */
	async structureSearch(structure, structureType, searchType, options = {}) {
		return await this._call("entrez_external", {
			service: "pubchem",
			operation: "structure_search",
			structure,
			structure_type: structureType,
			search_type: searchType,
			threshold: options.threshold || 90,
			max_records: options.maxRecords || 1000,
		});
	}

	/**
	 * Convert PMC IDs
	 */
	async convertPmcIds(ids, options = {}) {
		const idsStr = Array.isArray(ids) ? ids.join(",") : String(ids);

		return await this._call("entrez_external", {
			service: "pmc",
			operation: "id_convert",
			ids: idsStr,
			versions: options.versions || "no",
		});
	}

	/**
	 * Get PMC Open Access article
	 */
	async getPmcArticle(id, outputFormat = "xml") {
		return await this._call("entrez_external", {
			service: "pmc",
			operation: "oa_service",
			id,
			output_format: outputFormat,
		});
	}

	/**
	 * Export citations
	 */
	async exportCitations(ids, citationFormat = "ris") {
		const idsStr = Array.isArray(ids) ? ids.join(",") : String(ids);

		return await this._call("entrez_external", {
			service: "pmc",
			operation: "citation_export",
			ids: idsStr,
			citation_format: citationFormat,
		});
	}
}

/**
 * Helper class for working with staged data
 */
class DataStaging {
	constructor(sdk, dataAccessId, stagingResult) {
		this.sdk = sdk;
		this.dataAccessId = dataAccessId;
		this.stagingResult = stagingResult;
	}

	/**
	 * Query this staged dataset
	 */
	async query(sql, options = {}) {
		return await this.sdk.queryStagedData(this.dataAccessId, sql, options);
	}

	/**
	 * Get smart summary
	 */
	async getSmartSummary(options = {}) {
		return await this.sdk.getSmartSummary(this.dataAccessId, options);
	}

	/**
	 * Get schema
	 */
	async getSchema() {
		return await this.sdk.getSchema(this.dataAccessId);
	}

	/**
	 * Get the original staging result
	 */
	getMetadata() {
		return this.stagingResult;
	}
}

// Export for CommonJS compatibility
if (typeof module !== "undefined" && module.exports) {
	module.exports = { EntrezSDK, DataStaging };
}
