# Code Mode Examples

This document shows how to use the entrez-mcp-server with the new Code Mode compatible structured responses.

## Example 1: Basic Search with Structured Response

```javascript
// Search for articles about brain cancer
const result = await helpers.entrez.invoke('entrez_query', {
  operation: 'search',
  database: 'pubmed',
  term: 'brain cancer',
  retmax: 5
});

// Access structured data directly
console.log(`Total results: ${result.count}`);
console.log(`IDs returned: ${result.idlist.length}`);
console.log(`First 5 IDs: ${result.idlist.join(', ')}`);

// Check for warnings
if (result.warnings && result.warnings.length > 0) {
  console.log('Warnings:', result.warnings);
}

// Get suggestions for next steps
if (result.suggestions && result.suggestions.length > 0) {
  console.log('Next steps:', result.suggestions);
}
```

**Example Output:**
```javascript
{
  success: true,
  operation: "search",
  database: "pubmed",
  query: "brain cancer",
  count: 282970,
  retmax: 5,
  retstart: 0,
  idlist: ["41337800", "41337574", "41337434", "41337398", "41337217"],
  queryTranslation: "brain cancer[All Fields]",
  warnings: ["Large result set; consider adding filters or narrowing the query"],
  suggestions: [
    "Use summary operation for article metadata",
    "Use fetch operation with rettype='abstract' for full abstracts",
    "Increase retmax (currently 5) to retrieve more results"
  ]
}
```

## Example 2: Filtering Results by Date

```javascript
// Search for recent articles (last 30 days)
const result = await helpers.entrez.invoke('entrez_query', {
  operation: 'search',
  database: 'pubmed',
  term: 'CRISPR gene editing',
  retmax: 10,
  reldate: 30  // Last 30 days
});

// Process the results
const recentArticles = result.idlist;
console.log(`Found ${recentArticles.length} recent articles`);

// Use the IDs for follow-up queries
const summaries = await helpers.entrez.invoke('entrez_query', {
  operation: 'summary',
  database: 'pubmed',
  ids: recentArticles.join(',')
});
```

## Example 3: Multi-Step Analysis

```javascript
// Step 1: Search for articles
const searchResult = await helpers.entrez.invoke('entrez_query', {
  operation: 'search',
  database: 'pubmed',
  term: 'alzheimer disease[MeSH] AND drug therapy[MeSH]',
  retmax: 20
});

console.log(`Step 1: Found ${searchResult.count} total articles`);

// Step 2: Get detailed information for top results
const ids = searchResult.idlist.slice(0, 10); // Top 10 results
const abstracts = await helpers.entrez.invoke('entrez_query', {
  operation: 'fetch',
  database: 'pubmed',
  ids: ids.join(','),
  rettype: 'abstract'
});

// Step 3: Analyze the abstracts (structured data makes this easy)
console.log(`Step 2: Retrieved ${ids.length} abstracts for analysis`);
```

## Example 4: Error Handling with Structured Responses

```javascript
try {
  const result = await helpers.entrez.invoke('entrez_query', {
    operation: 'search',
    database: 'pubmed',
    term: 'cancer'
  });

  // Check for warnings (not errors, just informational)
  if (result.warnings) {
    console.log('Warnings:', result.warnings);
    // Example: ["Large result set; consider adding filters or narrowing the query"]
  }

  // Process results
  const ids = result.idlist;

} catch (error) {
  // Error messages are now parseable (no emojis)
  console.error('Search failed:', error.message);
  // Example: "Error in search: Invalid database 'pubme'"
  //          "Suggestion: Did you mean: pubmed?"
}
```

## Example 5: Comparing Structured vs Human Format

### Structured Format (Default - Code Mode Friendly)
```javascript
const structured = await helpers.entrez.invoke('entrez_query', {
  operation: 'search',
  database: 'pubmed',
  term: 'diabetes',
  retmax: 3
});

console.log(structured);
// Output:
// {
//   success: true,
//   operation: "search",
//   database: "pubmed",
//   query: "diabetes",
//   count: 485623,
//   retmax: 3,
//   retstart: 0,
//   idlist: ["41337800", "41337574", "41337434"],
//   suggestions: [...]
// }
```

### Human Format (Backward Compatible)
```javascript
const human = await helpers.entrez.invoke('entrez_query', {
  operation: 'search',
  database: 'pubmed',
  term: 'diabetes',
  retmax: 3,
  format: 'human'  // Request human-readable format
});

console.log(human);
// Output:
// 📊 **Search Results**: 485623 total, 3 returned
// 🆔 **IDs**: 41337800, 41337574, 41337434
// 📋 **Next Steps**:
// • Use `summary` for article metadata previews
// • Use `fetch` with `rettype="abstract"` for full abstracts
```

## Example 6: Using Both Old and New Parameter Names

```javascript
// New parameter name (recommended)
const result1 = await helpers.entrez.invoke('entrez_query', {
  operation: 'search',
  database: 'pubmed',  // New parameter name
  term: 'cancer'
});

// Old parameter name (still works)
const result2 = await helpers.entrez.invoke('entrez_query', {
  operation: 'search',
  db: 'pubmed',  // Old parameter name (deprecated but functional)
  term: 'cancer'
});

// Both return the same structured result
console.log(result1.count === result2.count); // true
```

## Example 7: Pagination with Structured Data

```javascript
// Get first page of results
const page1 = await helpers.entrez.invoke('entrez_query', {
  operation: 'search',
  database: 'pubmed',
  term: 'machine learning',
  retmax: 100,
  retstart: 0
});

console.log(`Total results: ${page1.count}`);
console.log(`Showing results ${page1.retstart + 1} to ${page1.retstart + page1.idlist.length}`);

// Get second page
const page2 = await helpers.entrez.invoke('entrez_query', {
  operation: 'search',
  database: 'pubmed',
  term: 'machine learning',
  retmax: 100,
  retstart: 100  // Start at result 101
});

console.log(`Showing results ${page2.retstart + 1} to ${page2.retstart + page2.idlist.length}`);

// Combine results
const allIds = [...page1.idlist, ...page2.idlist];
console.log(`Retrieved ${allIds.length} IDs total`);
```

## Example 8: Conditional Processing Based on Result Count

```javascript
const result = await helpers.entrez.invoke('entrez_query', {
  operation: 'search',
  database: 'pubmed',
  term: 'rare disease XYZ',
  retmax: 50
});

// Use structured data to make decisions
if (result.count === 0) {
  console.log('No results found. Try broader search terms.');

} else if (result.count < 10) {
  console.log(`Found ${result.count} results - small dataset`);
  // Fetch all abstracts
  const abstracts = await helpers.entrez.invoke('entrez_query', {
    operation: 'fetch',
    database: 'pubmed',
    ids: result.idlist.join(','),
    rettype: 'abstract'
  });

} else if (result.count > 1000) {
  console.log(`Found ${result.count} results - large dataset`);
  console.log('Consider narrowing your search with MeSH terms or date filters');
  console.log('Suggestions:', result.suggestions);

} else {
  console.log(`Found ${result.count} results - moderate dataset`);
  // Process top 20 results
  const topIds = result.idlist.slice(0, 20);
  // ... continue processing
}
```

## Benefits Summary

1. **No Text Parsing Required**: Direct access to `result.count`, `result.idlist`, etc.
2. **Type Safety**: Structured fields with predictable types
3. **Better Error Handling**: Parseable error messages without emojis
4. **Programmatic Access**: Easy to chain operations using structured data
5. **Warnings & Suggestions**: Machine-readable arrays instead of text
6. **Backward Compatible**: Human format still available when needed
