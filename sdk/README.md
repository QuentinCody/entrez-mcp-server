# Entrez MCP Server - SDK Documentation

This directory contains SDKs for calling the Entrez MCP Server via code execution, enabling LLMs and applications to interact with NCBI databases using familiar programming paradigms.

## Available SDKs

### JavaScript/TypeScript SDK
**Location**: `javascript/entrez-sdk.js` (with type definitions in `entrez-sdk.d.ts`)

**Features**:
- Full TypeScript support with comprehensive type definitions
- Works in Node.js and modern browsers
- Promise-based async/await API
- Automatic session management
- Helper classes for data staging

**Installation**:
```javascript
import { EntrezSDK } from './sdk/javascript/entrez-sdk.js';
```

### Python SDK
**Location**: `python/entrez_sdk.py`

**Features**:
- Full async/await support with asyncio
- Type hints for IDE autocomplete
- Async context manager for resource cleanup
- Custom exception classes
- Flexible ID handling (lists or strings)

**Installation**:
```bash
cd sdk/python
pip install -r requirements.txt
```

```python
from entrez_sdk import EntrezSDK
```

## Why Use SDKs?

### Problem: Direct Tool Calling Issues

When LLMs use code execution to call MCP tools directly, they encounter several issues:

1. **Identifier Syntax**: Hyphens in tool names (`entrez-query`) cause `SyntaxError` in JavaScript/Python
2. **Parameter Format**: MCP expects individual parameters, code expects dictionaries/objects
3. **Error Handling**: MCP errors vs exceptions have different handling patterns
4. **Session State**: Manual session ID tracking is error-prone
5. **Data Staging**: `data_access_id` values must be preserved across calls

### Solution: Language-Native SDKs

The SDKs solve these issues by:

- ✅ Using underscore naming (`entrez_query`) for valid identifiers
- ✅ Accepting dictionaries/objects for parameters
- ✅ Throwing proper exceptions with context
- ✅ Automatically tracking session IDs
- ✅ Providing `DataStaging` helper classes to manage IDs

## Quick Start Examples

### JavaScript Example

```javascript
import { EntrezSDK } from './sdk/javascript/entrez-sdk.js';

async function searchAndAnalyze() {
    const sdk = new EntrezSDK('http://localhost:8787');

    try {
        // Search for articles
        const searchResults = await sdk.search(
            'pubmed',
            'CRISPR gene editing therapy',
            { retmax: 20 }
        );

        console.log(`Found ${searchResults.total_results} articles`);

        // Fetch and stage data for analysis
        const staging = await sdk.fetchAndStage(
            'pubmed',
            searchResults.idlist.slice(0, 10)
        );

        // Get schema
        const schema = await staging.getSchema();
        console.log(`Tables: ${schema.table_names.join(', ')}`);

        // Run SQL queries
        const recentArticles = await staging.query(`
            SELECT pmid, title, year, journal
            FROM article
            WHERE year >= 2023
            ORDER BY year DESC
        `);

        console.log(`Recent articles: ${recentArticles.row_count}`);
        recentArticles.results.forEach(article => {
            console.log(`- [${article.year}] ${article.title}`);
        });

        // Get articles by MeSH term
        const meshAnalysis = await staging.query(`
            SELECT m.descriptorname, COUNT(*) as article_count
            FROM meshterm m
            JOIN article_meshterm am ON m.uid = am.meshterm_uid
            GROUP BY m.descriptorname
            ORDER BY article_count DESC
            LIMIT 10
        `);

        console.log('\nTop MeSH terms:');
        meshAnalysis.results.forEach(term => {
            console.log(`- ${term.descriptorname}: ${term.article_count} articles`);
        });

    } catch (error) {
        console.error(`Error: ${error.message}`);
    }
}

searchAndAnalyze();
```

### Python Example

```python
import asyncio
from entrez_sdk import EntrezSDK

async def search_and_analyze():
    async with EntrezSDK('http://localhost:8787') as sdk:
        try:
            # Search for articles
            search_results = await sdk.search(
                'pubmed',
                'CRISPR gene editing therapy',
                retmax=20
            )

            print(f"Found {search_results['total_results']} articles")

            # Fetch and stage data for analysis
            staging = await sdk.fetch_and_stage(
                'pubmed',
                search_results['idlist'][:10]
            )

            # Get schema
            schema = await staging.get_schema()
            print(f"Tables: {', '.join(schema['table_names'])}")

            # Run SQL queries
            recent_articles = await staging.query("""
                SELECT pmid, title, year, journal
                FROM article
                WHERE year >= 2023
                ORDER BY year DESC
            """)

            print(f"Recent articles: {recent_articles['row_count']}")
            for article in recent_articles['results']:
                print(f"- [{article['year']}] {article['title']}")

            # Get articles by MeSH term
            mesh_analysis = await staging.query("""
                SELECT m.descriptorname, COUNT(*) as article_count
                FROM meshterm m
                JOIN article_meshterm am ON m.uid = am.meshterm_uid
                GROUP BY m.descriptorname
                ORDER BY article_count DESC
                LIMIT 10
            """)

            print('\nTop MeSH terms:')
            for term in mesh_analysis['results']:
                print(f"- {term['descriptorname']}: {term['article_count']} articles")

        except Exception as e:
            print(f"Error: {e}")

# Run the async function
asyncio.run(search_and_analyze())
```

## API Reference

### Core Methods

#### System Tools

- **`getApiKeyStatus()`** / **`get_api_key_status()`**
  - Check NCBI API key status and rate limits
  - Returns: API key info and rate limit details

- **`getCapabilities(options)`** / **`get_capabilities(format, tool, include_metadata)`**
  - Get available tools and their capabilities
  - Returns: Tool metadata and operation details

- **`getToolInfo(toolName, format)`** / **`get_tool_info(tool_name, format)`**
  - Get detailed information about a specific tool
  - Returns: Tool capabilities, operations, and parameters

#### Entrez Query Tools

- **`search(database, term, options)`**
  - Search an NCBI database
  - Parameters:
    - `database`: Database name (e.g., 'pubmed', 'protein')
    - `term`: Search query
    - `options`: Optional { retmax, retstart, sort, field, intendedUse }
  - Returns: Search results with IDs and metadata

- **`summary(database, ids, options)`**
  - Get document summaries for specific IDs
  - Parameters:
    - `database`: Database name
    - `ids`: Single ID, array/list of IDs, or comma-separated string
    - `options`: Optional { retmax, compactMode, detailLevel, maxTokens }
  - Returns: Summary data

- **`fetch(database, ids, options)`**
  - Fetch detailed records
  - Parameters:
    - `database`: Database name
    - `ids`: ID(s) to fetch
    - `options`: Optional { rettype, intendedUse, detailLevel }
  - Returns: Full record data

- **`info(database)`**
  - Get database information and available fields
  - Returns: Database metadata

- **`link(database, ids, options)`**
  - Find links between databases
  - Parameters:
    - `database`: Target database
    - `ids`: Source ID(s)
    - `options`: Optional { dbfrom, linkname }
  - Returns: Link data

- **`post(database, ids, options)`** / **`post(database, ids, usehistory)`**
  - Post IDs to Entrez history server
  - Returns: WebEnv and QueryKey for batch operations

- **`globalQuery(term)`** / **`global_query(term)`**
  - Search across all NCBI databases
  - Returns: Cross-database results

- **`spell(term, database)`**
  - Get spelling suggestions
  - Returns: Corrected query suggestions

#### Data Staging Tools

- **`fetchAndStage(database, ids, options)`** / **`fetch_and_stage(database, ids, ...)`**
  - Fetch records and stage them in SQL database
  - Returns: `DataStaging` object with query methods
  - The `DataStaging` object provides:
    - `query(sql, options)`: Execute SQL queries
    - `getSmartSummary(options)` / `get_smart_summary(options)`: Get AI-generated summary
    - `getSchema()` / `get_schema()`: Get database schema
    - `dataAccessId` / `data_access_id`: Access ID for later queries

- **`queryStagedData(dataAccessId, sql, options)`** / **`query_staged_data(data_access_id, sql, ...)`**
  - Query previously staged data
  - Returns: Query results

- **`getSmartSummary(dataAccessId, options)`** / **`get_smart_summary(data_access_id, ...)`**
  - Get intelligent summary of staged data
  - Returns: AI-generated insights

- **`getSchema(dataAccessId)`** / **`get_schema(data_access_id)`**
  - Get schema for staged data
  - Returns: Table definitions, column descriptions, recommended queries

- **`listDatasets()`** / **`list_datasets()`**
  - List all active staged datasets
  - Returns: Dataset metadata

#### External API Tools

- **`getCompound(identifier, identifierType, outputFormat)`** / **`get_compound(...)`**
  - Get PubChem compound data
  - Parameters:
    - `identifier`: Compound identifier (name, CID, etc.)
    - `identifierType`: 'name', 'cid', 'inchi', 'smiles', etc.
    - `outputFormat`: 'json' or 'xml'
  - Returns: Compound data

- **`getSubstance(identifier, identifierType, outputFormat)`** / **`get_substance(...)`**
  - Get PubChem substance data
  - Returns: Substance data

- **`getBioassay(identifier, identifierType, outputFormat)`** / **`get_bioassay(...)`**
  - Get PubChem bioassay data
  - Returns: Bioassay data

- **`structureSearch(structure, structureType, searchType, options)`** / **`structure_search(...)`**
  - Search PubChem by chemical structure
  - Parameters:
    - `structure`: Structure specification
    - `structureType`: 'smiles', 'inchi', 'sdf', 'mol'
    - `searchType`: 'identity', 'substructure', 'superstructure', 'similarity'
    - `options`: Optional { threshold, maxRecords }
  - Returns: Matching compounds

- **`convertPmcIds(ids, options)`** / **`convert_pmc_ids(ids, ...)`**
  - Convert between PMC, PMID, and DOI identifiers
  - Returns: ID conversion results

- **`getPmcArticle(id, outputFormat)`** / **`get_pmc_article(id, ...)`**
  - Get PMC Open Access full-text article
  - Returns: Article content

- **`exportCitations(ids, citationFormat)`** / **`export_citations(ids, ...)`**
  - Export citations in various formats
  - Parameters:
    - `ids`: Article ID(s)
    - `citationFormat`: 'ris', 'nbib', 'medline', 'bibtex'
  - Returns: Formatted citations

## Common Workflows

### Literature Review Workflow

```javascript
// 1. Search for relevant articles
const searchResults = await sdk.search('pubmed', 'machine learning healthcare', {
    retmax: 50
});

// 2. Stage data for analysis
const staging = await sdk.fetchAndStage('pubmed', searchResults.idlist);

// 3. Analyze by year
const yearlyTrend = await staging.query(`
    SELECT year, COUNT(*) as count
    FROM article
    WHERE year IS NOT NULL
    GROUP BY year
    ORDER BY year DESC
`);

// 4. Find top journals
const topJournals = await staging.query(`
    SELECT journal, COUNT(*) as article_count
    FROM article
    WHERE journal IS NOT NULL
    GROUP BY journal
    ORDER BY article_count DESC
    LIMIT 10
`);

// 5. Analyze MeSH terms
const meshTerms = await staging.query(`
    SELECT m.descriptorname, COUNT(DISTINCT a.pmid) as article_count
    FROM meshterm m
    JOIN article_meshterm am ON m.uid = am.meshterm_uid
    JOIN article a ON am.article_uid = a.uid
    GROUP BY m.descriptorname
    ORDER BY article_count DESC
    LIMIT 20
`);
```

### Chemical Structure Analysis

```python
# 1. Look up a compound
compound = await sdk.get_compound('aspirin', 'name')
cid = compound['PC_Compounds'][0]['id']['id']['cid']

# 2. Find similar compounds
similar = await sdk.structure_search(
    'CC(=O)Oc1ccccc1C(=O)O',  # Aspirin SMILES
    'smiles',
    'similarity',
    threshold=90,
    max_records=10
)

# 3. Get bioassay data
bioassays = await sdk.get_bioassay(str(cid), 'cid')
```

### Cross-Database Integration

```javascript
// 1. Search PubMed for gene
const geneArticles = await sdk.search('pubmed', 'BRCA1[Gene]', { retmax: 5 });

// 2. Find related gene records
const geneLinks = await sdk.link('gene', geneArticles.idlist[0], {
    dbfrom: 'pubmed'
});

// 3. Get protein sequences
const proteinInfo = await sdk.fetch('protein', geneLinks.linksets[0].ids, {
    rettype: 'fasta'
});

// 4. Get compound interactions
const compounds = await sdk.search('pccompound', 'BRCA1', { retmax: 10 });
```

## Testing

Both SDKs include comprehensive integration tests.

### Run JavaScript Tests
```bash
npm run test-sdk-js
```

### Run Python Tests
```bash
npm run test-sdk-py
```

### Run All SDK Tests
```bash
npm run test-sdk-all
```

## Error Handling

### JavaScript
```javascript
try {
    const results = await sdk.search('invalid_db', 'test');
} catch (error) {
    console.error(`Error: ${error.message}`);
    // Handle specific error types
    if (error.message.includes('Invalid database')) {
        // Suggest valid databases
    }
}
```

### Python
```python
from entrez_sdk import EntrezSDKError

try:
    results = await sdk.search('invalid_db', 'test')
except EntrezSDKError as e:
    print(f"Error: {e}")
    # Handle specific error types
    if 'Invalid database' in str(e):
        # Suggest valid databases
```

## Best Practices

1. **Use Async Context Managers** (Python)
   ```python
   async with EntrezSDK(base_url) as sdk:
       # SDK automatically cleans up resources
   ```

2. **Preserve Data Access IDs**
   ```javascript
   const staging = await sdk.fetchAndStage('pubmed', ids);
   // Use staging.dataAccessId in subsequent calls
   const results = await staging.query('SELECT * FROM article');
   ```

3. **Handle Rate Limits**
   ```python
   # Check API key status first
   status = await sdk.get_api_key_status()
   # Adjust request frequency based on rate limits
   ```

4. **Use Type Safety**
   ```typescript
   // TypeScript provides autocomplete and type checking
   const results: SearchResult = await sdk.search('pubmed', 'test');
   ```

5. **Batch Operations**
   ```javascript
   // Use fetchAndStage for analyzing multiple articles
   const staging = await sdk.fetchAndStage('pubmed', idList);
   // Then run multiple SQL queries efficiently
   ```

## Troubleshooting

### Issue: `SyntaxError: Unexpected token '-'`
**Solution**: Use underscore versions (`entrez_query`, not `entrez-query`)

### Issue: Lost `data_access_id`
**Solution**: Use `DataStaging` helper class or store the ID:
```javascript
const staging = await sdk.fetchAndStage('pubmed', ids);
// staging.dataAccessId is preserved
await staging.query('SELECT ...');
```

### Issue: Connection refused
**Solution**: Ensure MCP server is running:
```bash
npm run dev  # Start server on http://localhost:8787
```

### Issue: Missing await
**Solution**: All SDK methods are async:
```javascript
// ❌ Wrong
const results = sdk.search('pubmed', 'test');

// ✅ Correct
const results = await sdk.search('pubmed', 'test');
```

## Contributing

To add new features to the SDKs:

1. Update `javascript/entrez-sdk.js` and `javascript/entrez-sdk.d.ts`
2. Update `python/entrez_sdk.py`
3. Add tests to `test-sdk-javascript.js` and `test-sdk-python.py`
4. Update this README with examples
5. Run `npm run test-sdk-all` to verify

## License

MIT License - see main project LICENSE file
