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

- **Tool Introspection**: Call `entrez-capabilities` to inspect the available tools, operations, token footprints, and authentication hints. Pass `{ "tool": "entrez-query", "format": "detailed" }` to drill into a single surface, or `format: "json"` for structured output.
- **Reusable MCP Prompts**: `prompts/` contains workflow blueprints that keep the tool list compact while guiding agents through multi-step tasks.
  - `pubmed-literature-review.prompt.json`: focused on rapid PubMed evidence scans using `entrez-query`, staged summaries, and optional SQL follow-ups.
  - `staged-sql-analysis.prompt.json`: outlines the durable-object staging + SQL exploration loop using `entrez-data`.
- **Guided Onboarding**: When onboarding a new agent, first run `entrez-capabilities` (summary mode) followed by an appropriate prompt file to seed its scratchpad with best practices without inflating tool surface area.

### Core Components

**Main Entry Point**: `src/index.ts`
- `EntrezMCP` class extends `McpAgent` from the MCP SDK
- Implements rate limiting (3/sec default, 10/sec with API key)
- **Dual Transport Support**: 
  - `/mcp` - Streamable HTTP transport (recommended, MCP 2024-11-05 spec)
  - `/sse` - SSE transport (legacy support)
- Protocol version header support (`MCP-Protocol-Version`)
- Session management with auto-generated session IDs
- CORS support for browser compatibility

**Durable Objects**: `src/do.ts`
- `JsonToSqlDO`: Advanced SQL staging for complex datasets using SQLite
- Provides intelligent data staging with schema inference

**Tool Architecture**: `src/tools/`
- **Consolidated approach**: 4 main tools replace 19+ individual tools
- `EntrezQueryTool` (`entrez-query`): Unified E-utilities (ESearch, EFetch, ESummary, EInfo, ELink, EPost, ESpell, EGquery)
- `ExternalAPIsTool` (`entrez-external`): PubChem, PMC, BLAST services
- `DataManagerTool` (`entrez-data`): Advanced data staging and SQL query capabilities
- `ApiKeyStatusTool` (`system-api-key-status`): Environment and API key validation

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
  -H "MCP-Protocol-Version: 2024-11-05" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{"tools":{}},"clientInfo":{"name":"test-client","version":"1.0.0"}}}'
```

**Legacy: SSE Transport**
```bash
# Connect to SSE endpoint
curl -H "Accept: text/event-stream" http://localhost:8787/sse
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
- Use deployed endpoint: `<your-account>.workers.dev/sse`

**Claude Desktop Integration**:
- Use `mcp-remote` proxy for remote connections
- Configure in Claude Desktop settings with endpoint: `http://localhost:8787/sse`
- Supports both local development and deployed Workers
