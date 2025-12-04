# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

### Core Development
- **Start dev server**: `npm start` or `npm run dev` (runs Wrangler dev server on port 8787)
- **Build**: `npm run build` (creates production build)
- **Deploy**: `npm run deploy` (deploys to Cloudflare Workers)
- **Type check**: `npm run type-check` (TypeScript type checking)

### Code Quality
- **Format**: `npm run format` (Biome formatter with 4-space indentation, 100-char line width)
- **Lint & fix**: `npm run lint:fix` (Biome linter with custom rules)

### Testing & Verification
- **Test API setup**: `npm run test` or `npm run test-api-key` (verifies NCBI API key configuration)
- **Test MCP transports**: `npm run test-mcp` (tests both Streamable HTTP and SSE transports)
- **Test all functionality**: `npm run test-all` (comprehensive test suite)
- **Check setup**: `npm run check-setup` (displays environment variable status)
- **Generate types**: `npm run cf-typegen` (generates Cloudflare Worker types)
- **Quick start helper**: `npm run quick-start` (guided setup process)
- **Setup help**: `npm run setup-help` (displays API key setup instructions)

## Architecture Overview

This is a **Cloudflare Workers-based MCP (Model Context Protocol) server** that provides comprehensive access to NCBI APIs including E-utilities, PubChem, PMC, and BLAST services.

## Agent Prompts & Capability Discovery

- **Tool Introspection**: Call `entrez_capabilities` to inspect the available tools, operations, token footprints, and authentication hints. Pass `{ "tool": "entrez_query", "format": "detailed" }` to drill into a single surface, or `format: "json"` for structured output.
- **Reusable MCP Prompts**: `prompts/` contains workflow blueprints that keep the tool list compact while guiding agents through multi-step tasks.
  - `pubmed-literature-review.prompt.json`: focused on rapid PubMed evidence scans using `entrez_query`, staged summaries, and optional SQL follow-ups.
  - `staged-sql-analysis.prompt.json`: outlines the durable-object staging + SQL exploration loop using `entrez_data`.
- **Guided Onboarding**: When onboarding a new agent, first run `entrez_capabilities` (summary mode) followed by an appropriate prompt file to seed its scratchpad with best practices without inflating tool surface area.

### Core Components

- **Main Entry Point**: `src/index.ts`
- `EntrezMCP` class extends `McpAgent` from the MCP SDK
- Implements rate limiting (3/sec default, 10/sec with API key)
- **Dual Transport Support**: 
  - `/mcp` - Streamable HTTP transport (recommended, MCP 2025-11-25 spec)
- Protocol version header support (`MCP-Protocol-Version`)
- Session management with auto-generated session IDs
- CORS support for browser compatibility

**Durable Objects**: `src/do.ts`
- `JsonToSqlDO`: Advanced SQL staging for complex datasets using SQLite
- Provides intelligent data staging with schema inference

**Tool Architecture**: `src/tools/`
- **Consolidated approach**: 4 main tools replace 19+ individual tools
- `EntrezQueryTool` (`entrez_query`): Unified E-utilities (ESearch, EFetch, ESummary, EInfo, ELink, EPost, ESpell, EGquery)
- `ExternalAPIsTool` (`entrez_external`): PubChem, PMC, BLAST services
- `DataManagerTool` (`entrez_data`): Advanced data staging and SQL query capabilities
- `ApiKeyStatusTool` (`system_api_key_status`): Environment and API key validation

**Data Processing**: `src/lib/`
- `parsers.ts`: Smart parsers for PubMed, Gene, Protein, Nucleotide databases
- `response-formatter.ts`: Optimized response formatting to reduce token usage
- `ChunkingEngine.ts`, `DataInsertionEngine.ts`, `SchemaInferenceEngine.ts`: Advanced SQL staging
- `smart-query-generator.ts`: Query optimization and suggestions

### Key Features

**Intelligent Response Handling**:
- XML optimization removes DTDs, processing instructions, empty elements
- Tool-specific optimizations for EInfo, ESummary, ESearch
- Automatic staging for large/complex datasets (>5k tokens or high structural complexity)

**Advanced Query Processing**:
- Query validation with helpful suggestions
- Boolean operator improvements
- Field-specific search recommendations
- Smart retmode selection based on intended use

**Rate Limiting & Performance**:
- Built-in NCBI rate limit compliance
- 3.3x performance boost with optional API key
- Automatic API key detection from environment (`NCBI_API_KEY`)

## Environment Configuration

**Required Environment Variables**: None (works out of the box)

**Optional Performance Enhancement**:
- `NCBI_API_KEY`: Get free key from NCBI for 3.3x better rate limits
- Configure via: `export NCBI_API_KEY="your_key_here"`
- Verify with: `npm run test-api-key`

**Cloudflare Workers Configuration**:
- Uses `wrangler.jsonc` for deployment config
- Durable Objects enabled for data staging (`EntrezMCP`, `JsonToSqlDO`)
- Node.js compatibility flags enabled
- Default dev port: 8787
- SQLite migrations configured for data persistence

## Data Staging System

**When Data Gets Staged**:
- Responses >5k estimated tokens
- High structural complexity (>20 fields, >10 summaries, >50 links)
- Complex multi-entity datasets

**Bypass Logic**:
- Small datasets (<1KB or <10 entities) returned directly
- Simple structures with ≤2 entity types
- Poor parsing results

**Query Recommendations**:
- Automatic schema inference with column descriptions
- Common join patterns and example queries
- Data quality metrics and parsing diagnostics

## Development Patterns

**Code Style**: 
- Uses Biome (not ESLint/Prettier)
- 4-space indentation, 100-character line width
- TypeScript strict mode enabled

**Tool Registration**:
- All tools register through `ToolRegistry` in `src/tools/index.ts`
- Consolidated tools pattern reduces MCP server complexity

**Error Handling**:
- NCBI-specific error pattern detection
- Comprehensive validation with helpful suggestions
- Rate limit awareness and API key guidance

**Response Optimization**:
- Token-conscious XML/JSON processing
- Intelligent staging decisions
- User-friendly formatting for complex query results

## MCP Transport Usage

**Recommended: Streamable HTTP Transport**
```bash
# Test with curl
curl -X POST http://localhost:8787/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "MCP-Protocol-Version: 2025-11-25" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{"tools":{}},"clientInfo":{"name":"test-client","version":"1.0.0"}}}'
```

**Key Features**:
- **Session Management**: Automatic session ID generation for stateful connections
- **Protocol Negotiation**: Supports multiple MCP protocol versions
- **Error Handling**: Comprehensive error responses with context
- **Transport Detection**: Automatically detects preferred transport method
- **CORS Support**: Full cross-origin support for browser clients

## Remote MCP Client Integration

**Cloudflare AI Playground**:
- Connect via: `https://playground.ai.cloudflare.com/`
- Use deployed endpoint: `<your-account>.workers.dev/mcp`

**Claude Desktop Integration**:
- Use `mcp-remote` proxy for remote connections
- Configure in Claude Desktop settings with endpoint: `http://localhost:8787/mcp`
- Supports both local development and deployed Workers

## Code Execution via SDKs

The server provides **JavaScript/TypeScript and Python SDKs** for calling tools via code execution. This enables LLMs to interact with the MCP server through familiar programming interfaces instead of direct tool calls.

### JavaScript/TypeScript SDK

**Location**: `sdk/javascript/entrez-sdk.js` (with TypeScript definitions in `entrez-sdk.d.ts`)

**Installation**:
```javascript
import { EntrezSDK } from './sdk/javascript/entrez-sdk.js';

const sdk = new EntrezSDK('http://localhost:8787');
```

**Basic Usage**:
```javascript
// Search PubMed
const results = await sdk.search('pubmed', 'CRISPR gene editing', { retmax: 5 });
console.log(`Found ${results.total_results} articles`);

// Get summaries
const summaries = await sdk.summary('pubmed', results.idlist, {
    detailLevel: 'brief'
});

// Fetch full records
const article = await sdk.fetch('pubmed', results.idlist[0], {
    rettype: 'abstract'
});

// Data staging with SQL
const staging = await sdk.fetchAndStage('pubmed', results.idlist.slice(0, 10));
const schema = await staging.getSchema();
const queryResult = await staging.query(
    'SELECT pmid, title, year FROM article WHERE year > 2020'
);

// PubChem lookup
const compound = await sdk.getCompound('aspirin', 'name');
console.log(`Molecular formula: ${compound.PC_Compounds[0].props.find(p => p.urn.label === 'Molecular Formula').value.sval}`);
```

**Testing**:
```bash
npm run test-sdk-js
```

### Python SDK

**Location**: `sdk/python/entrez_sdk.py`

**Installation**:
```bash
cd sdk/python
pip install -r requirements.txt
```

**Basic Usage**:
```python
from entrez_sdk import EntrezSDK
import asyncio

async def main():
    async with EntrezSDK('http://localhost:8787') as sdk:
        # Search PubMed
        results = await sdk.search('pubmed', 'CRISPR gene editing', retmax=5)
        print(f"Found {results['total_results']} articles")

        # Get summaries
        summaries = await sdk.summary('pubmed', results['idlist'], detail_level='brief')

        # Fetch full records
        article = await sdk.fetch('pubmed', results['idlist'][0], rettype='abstract')

        # Data staging with SQL
        staging = await sdk.fetch_and_stage('pubmed', results['idlist'][:10])
        schema = await staging.get_schema()
        query_result = await staging.query(
            'SELECT pmid, title, year FROM article WHERE year > 2020'
        )

        # PubChem lookup
        compound = await sdk.get_compound('aspirin', 'name')
        print(f"Molecular weight: {compound['PC_Compounds'][0]['props'][17]['value']['sval']}")

asyncio.run(main())
```

**Testing**:
```bash
npm run test-sdk-py
```

### Key SDK Features

**1. Underscore Naming Convention**
- All tools use underscore names (`entrez_query`, not `entrez-query`) for valid identifiers
- Hyphenated names cause `SyntaxError` in JavaScript/Python
- Both SDKs use Python-style underscore naming (e.g., `fetch_and_stage`, `get_compound`)

**2. Parameter Handling**
- Flexible ID input: accepts both arrays/lists and comma-separated strings
- Automatic parameter cleaning (removes `None`/`undefined` values)
- Type safety with TypeScript definitions (JavaScript) and type hints (Python)

**3. Error Handling**
- Custom `EntrezSDKError` exception class
- Context-aware error messages include tool name
- Proper async/await support

**4. Session Management**
- Automatic session ID tracking across requests
- Session persistence for rate limiting compliance
- Proper cleanup with async context managers (Python) or manual `close()` (JavaScript)

**5. DataStaging Helper Class**
- Convenience wrapper for staged datasets
- Methods: `query()`, `getSmartSummary()`, `getSchema()`
- Automatically tracks `data_access_id`

### SDK vs Direct Tool Calling

| Aspect | Direct Tool Calls | SDK (Code Execution) |
|--------|------------------|---------------------|
| **Naming** | Uses underscores (`entrez_query`) | Uses underscores (`entrez_query`) |
| **Parameters** | Individual parameters | Dictionary/object of parameters |
| **Error Format** | MCP error objects | Exceptions/thrown errors |
| **Session Management** | Automatic via MCP protocol | Manual tracking (handled by SDK) |
| **Type Safety** | MCP schema validation | TypeScript definitions / Python type hints |
| **Async Handling** | MCP protocol handles | Explicit `async`/`await` required |
| **ID Formats** | Comma-separated strings | Arrays/lists or strings (SDK converts) |

### Common Pitfalls & Solutions

**❌ Problem: Invalid Identifier**
```javascript
// WRONG: Hyphens cause SyntaxError
await entrez-query({ operation: "search", ... })
```
```javascript
// ✅ CORRECT: Use underscores
await entrez_query({ operation: "search", ... })
```

**❌ Problem: Missing data_access_id**
```python
# WRONG: Losing track of staging ID
staging = await sdk.fetch_and_stage('pubmed', ids)
# ... other code ...
result = await sdk.query_staged_data("wrong_id", "SELECT ...")
```
```python
# ✅ CORRECT: Use DataStaging helper or preserve ID
staging = await sdk.fetch_and_stage('pubmed', ids)
result = await staging.query("SELECT * FROM article")
```

**❌ Problem: Missing await**
```python
# WRONG: Returns coroutine, not results
results = sdk.search('pubmed', 'test')
```
```python
# ✅ CORRECT: Use await
results = await sdk.search('pubmed', 'test')
```

**❌ Problem: Session not closed**
```python
# WRONG: Resource leak
sdk = EntrezSDK('http://localhost:8787')
results = await sdk.search('pubmed', 'test')
# Session never closed!
```
```python
# ✅ CORRECT: Use context manager
async with EntrezSDK('http://localhost:8787') as sdk:
    results = await sdk.search('pubmed', 'test')
# Session automatically closed
```

### Integration Testing

Both SDKs include comprehensive integration tests:

**JavaScript**: `test-sdk-javascript.js`
- Tests connection, search, fetch, summary, data staging, PubChem, error handling
- Validates array vs string ID handling
- Confirms proper error messages

**Python**: `test-sdk-python.py`
- Tests all SDK methods with real MCP server
- Validates async context manager
- Tests list vs string ID conversions
- Confirms exception handling

**Run All Tests**:
```bash
npm run test-sdk-all
```

This runs:
1. `npm run test-sdk-js` - JavaScript SDK tests
2. `npm run test-sdk-py` - Python SDK tests
3. Provides combined success/failure report

### When to Use SDKs vs Direct Tool Calls

**Use Direct Tool Calls when:**
- Working with MCP-native clients (Claude Desktop, etc.)
- Tool chaining with MCP protocol features
- No code execution environment available

**Use SDKs when:**
- LLM has code execution capabilities
- Building standalone scripts/applications
- Need type safety and IDE autocomplete
- Want familiar programming paradigms (async/await, exceptions, etc.)
