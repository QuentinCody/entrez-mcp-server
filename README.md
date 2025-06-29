# NCBI Entrez MCP Server

A comprehensive Model Context Protocol (MCP) server providing access to NCBI's complete suite of APIs including E-utilities, BLAST, PubChem, and PMC services.

## 🚀 Quick Start

**Works out of the box** - no configuration required!

```bash
git clone <this-repo>
cd entrez-mcp-server
npm install
npm start
```

## 🎯 Features

- **Complete NCBI API Coverage**: E-utilities, BLAST, PubChem PUG, PMC APIs
- **No Setup Required**: Works immediately without any configuration
- **Optional Performance Boost**: Add your free NCBI API key for 3x better rate limits
- **Rate Limiting**: Built-in respect for NCBI rate limits (3/sec → 10/sec with API key)
- **User-Friendly**: Designed for both technical and non-technical users

## 📊 Performance

| Configuration | Rate Limit | Performance |
|---------------|------------|-------------|
| **Default (No API Key)** | 3 requests/second | ✅ Works out of the box |
| **With API Key** | 10 requests/second | 🚀 3.3x faster |

## 🔑 Optional API Key Setup

For better performance, add your free NCBI API key:

1. **Get your key**: [NCBI API Key Registration](https://ncbiinsights.ncbi.nlm.nih.gov/2017/11/02/new-api-keys-for-the-e-utilities/) (takes 30 seconds)
2. **Set environment variable**: `export NCBI_API_KEY="your_key_here"`
3. **Test it works**: `node test-rate-limits.js`

See [API_KEY_SETUP.md](API_KEY_SETUP.md) for detailed instructions.

## 🧪 Testing

Test your setup and verify rate limits:
```bash
node test-rate-limits.js
```

This will test both authenticated and unauthenticated scenarios and verify your API key is working correctly.

## Connect to Cloudflare AI Playground

You can connect to your MCP server from the Cloudflare AI Playground, which is a remote MCP client:

1. Go to https://playground.ai.cloudflare.com/
2. Enter your deployed MCP server URL (`remote-mcp-server-authless.<your-account>.workers.dev/sse`)
3. You can now use your MCP tools directly from the playground!

## Connect Claude Desktop to your MCP server

You can also connect to your remote MCP server from local MCP clients, by using the [mcp-remote proxy](https://www.npmjs.com/package/mcp-remote). 

To connect to your MCP server from Claude Desktop, follow [Anthropic's Quickstart](https://modelcontextprotocol.io/quickstart/user) and within Claude Desktop go to Settings > Developer > Edit Config.

Update with this configuration:

```json
{
  "mcpServers": {
    "calculator": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "http://localhost:8787/sse"  // or remote-mcp-server-authless.your-account.workers.dev/sse
      ]
    }
  }
}
```

Restart Claude and you should see the tools become available. 
