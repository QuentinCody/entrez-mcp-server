/**
 * NCBI Entrez E-utilities API catalog.
 *
 * Describes the core E-utility endpoints for Code Mode discovery.
 * Base URL: https://eutils.ncbi.nlm.nih.gov/entrez/eutils
 *
 * All endpoints return XML by default; add retmode=json for JSON responses.
 * The adapter automatically appends `tool` and `email` params for API compliance.
 */

import type { ApiCatalog } from "@bio-mcp/shared/codemode/catalog";

export const entrezCatalog: ApiCatalog = {
	name: "NCBI Entrez E-utilities",
	baseUrl: "https://eutils.ncbi.nlm.nih.gov/entrez/eutils",
	version: "2.0",
	auth: "optional_api_key",
	endpointCount: 8,
	notes:
		"- All endpoints return XML by default; use retmode=json for JSON (recommended)\n" +
		"- Common databases: pubmed, protein, nuccore, gene, clinvar, snp, omim, mesh, biosample, sra, taxonomy, pmc\n" +
		"- esearch returns IDs; use efetch or esummary to get full records\n" +
		"- For PubMed: rettype=abstract returns abstracts, rettype=medline returns MEDLINE format\n" +
		"- Date format: YYYY/MM/DD; use datetype=pdat for publication date\n" +
		"- The adapter auto-adds tool and email params for NCBI API compliance\n" +
		"- If NCBI_API_KEY is configured, it is also auto-added (raises rate limit from 3 to 10 req/sec)\n" +
		"- Use usehistory=y with esearch to store results on the NCBI History server, then retrieve with WebEnv/query_key\n" +
		"- PubMed field tags: [Title], [Author], [MeSH Terms], [Journal], [Date], [Title/Abstract], [All Fields]\n" +
		"- Boolean operators must be uppercase: AND, OR, NOT\n\n" +
		"Example multi-step workflow:\n" +
		"  // 1. Search for IDs\n" +
		"  const search = await api.get('/esearch.fcgi', { db: 'pubmed', term: 'CRISPR AND gene therapy', retmode: 'json', retmax: 5 });\n" +
		"  const ids = search.esearchresult.idlist.join(',');\n" +
		"  // 2. Get summaries for those IDs\n" +
		"  const summaries = await api.get('/esummary.fcgi', { db: 'pubmed', id: ids, retmode: 'json' });\n" +
		"  return summaries;",
	endpoints: [
		// === Search ===
		{
			method: "GET",
			path: "/esearch.fcgi",
			summary: "Search any NCBI database and return matching record IDs.",
			description:
				"Text search against any of 40+ NCBI databases. Returns a list of UIDs matching the query. " +
				"Supports Boolean operators (AND, OR, NOT), field-qualified terms (e.g. cancer[Title]), " +
				"date ranges (mindate/maxdate with datetype), and pagination (retstart/retmax). " +
				"Use retmode=json for structured JSON output. " +
				"Add usehistory=y to cache results on NCBI servers for subsequent efetch/esummary calls via WebEnv/query_key.",
			category: "search",
			coveredByTool: "entrez_query",
			queryParams: [
				{ name: "db", type: "string", required: true, description: "NCBI database name (e.g. pubmed, gene, protein, nuccore, clinvar, snp, omim)" },
				{ name: "term", type: "string", required: true, description: "Entrez search query. Supports Boolean (AND, OR, NOT), field tags ([Title], [MeSH]), date ranges." },
				{ name: "retmax", type: "number", required: false, description: "Maximum number of IDs to return (default 20, max 100000)", default: 20 },
				{ name: "retstart", type: "number", required: false, description: "Index of first ID to return (for pagination)", default: 0 },
				{ name: "rettype", type: "string", required: false, description: "Retrieval type (e.g. 'uilist' for ID list)" },
				{ name: "retmode", type: "string", required: false, description: "Output format: 'json' or 'xml' (default xml)", default: "xml" },
				{ name: "sort", type: "string", required: false, description: "Sort order (e.g. 'relevance', 'pub_date', 'Author', 'JournalName' for PubMed)" },
				{ name: "datetype", type: "string", required: false, description: "Date type for filtering: 'pdat' (publication), 'edat' (Entrez), 'mdat' (modification)" },
				{ name: "reldate", type: "number", required: false, description: "Results from last N days" },
				{ name: "mindate", type: "string", required: false, description: "Start date (YYYY/MM/DD)" },
				{ name: "maxdate", type: "string", required: false, description: "End date (YYYY/MM/DD)" },
				{ name: "usehistory", type: "string", required: false, description: "Set to 'y' to store results on History server (returns WebEnv and query_key)" },
			],
		},

		// === Fetch ===
		{
			method: "GET",
			path: "/efetch.fcgi",
			summary: "Fetch full records by UID from any NCBI database.",
			description:
				"Retrieve complete data records for a list of UIDs. The format and content depend on the database and rettype/retmode. " +
				"For PubMed: rettype=abstract returns formatted abstracts, rettype=medline returns MEDLINE format. " +
				"For sequences (nuccore, protein): rettype=fasta for FASTA, rettype=gb for GenBank, rettype=gp for GenPept. " +
				"For gene: rettype=gene_table for tabular format. " +
				"NOTE: efetch does NOT support retmode=json for most databases. Use esummary for JSON output.",
			category: "fetch",
			coveredByTool: "entrez_query",
			queryParams: [
				{ name: "db", type: "string", required: true, description: "NCBI database name" },
				{ name: "id", type: "string", required: true, description: "Comma-separated UIDs (e.g. '12345,67890') or use WebEnv+query_key" },
				{ name: "rettype", type: "string", required: false, description: "Format: 'abstract', 'medline', 'fasta', 'gb', 'gp', 'gene_table', 'xml', etc." },
				{ name: "retmode", type: "string", required: false, description: "Output mode: 'xml' or 'text' (json NOT supported for most databases)" },
				{ name: "retstart", type: "number", required: false, description: "Index of first record to retrieve (for batching)" },
				{ name: "retmax", type: "number", required: false, description: "Number of records to retrieve (max 10000)" },
			],
		},

		// === Summary ===
		{
			method: "GET",
			path: "/esummary.fcgi",
			summary: "Get document summaries (DocSums) for a list of UIDs. Supports JSON output.",
			description:
				"Returns condensed document summaries for each UID. Lighter-weight than efetch and supports retmode=json. " +
				"For PubMed, DocSums include title, authors, journal, pubdate, DOI, etc. " +
				"For Gene, includes symbol, description, organism, chromosome, map location. " +
				"Recommended for getting structured metadata when you don't need full records.",
			category: "fetch",
			coveredByTool: "entrez_query",
			queryParams: [
				{ name: "db", type: "string", required: true, description: "NCBI database name" },
				{ name: "id", type: "string", required: true, description: "Comma-separated UIDs" },
				{ name: "retmode", type: "string", required: false, description: "Output format: 'json' (recommended) or 'xml'", default: "xml" },
				{ name: "retstart", type: "number", required: false, description: "Index of first DocSum to return" },
				{ name: "retmax", type: "number", required: false, description: "Number of DocSums to return" },
			],
		},

		// === Link ===
		{
			method: "GET",
			path: "/elink.fcgi",
			summary: "Find related or linked records across NCBI databases.",
			description:
				"Discover relationships between records across databases. Examples: " +
				"PubMed article -> Gene records, Gene -> Protein sequences, SNP -> ClinVar entries. " +
				"Use cmd=neighbor for related records in same db, cmd=neighbor_score for scored results, " +
				"cmd=acheck to list all available links. The linkname parameter can filter specific link types " +
				"(e.g. pubmed_gene for PubMed-to-Gene links).",
			category: "link",
			coveredByTool: "entrez_query",
			queryParams: [
				{ name: "dbfrom", type: "string", required: true, description: "Source database (e.g. pubmed, gene)" },
				{ name: "db", type: "string", required: false, description: "Target database (if different from source). Omit to get links in all databases." },
				{ name: "id", type: "string", required: true, description: "Comma-separated UIDs from the source database" },
				{ name: "cmd", type: "string", required: false, description: "Link command: 'neighbor' (default), 'neighbor_score', 'acheck', 'ncheck', 'lcheck', 'llinks', 'prlinks'" },
				{ name: "linkname", type: "string", required: false, description: "Specific link type (e.g. 'pubmed_gene', 'gene_protein', 'snp_clinvar')" },
			],
		},

		// === Info ===
		{
			method: "GET",
			path: "/einfo.fcgi",
			summary: "Get database metadata — field list, link names, and record count.",
			description:
				"Without db param: returns list of all 40+ NCBI databases. " +
				"With db param: returns detailed metadata for that database including searchable fields, " +
				"available links to other databases, field descriptions, and total record count. " +
				"Useful for discovering valid field tags and link names before constructing queries.",
			category: "info",
			coveredByTool: "entrez_query",
			queryParams: [
				{ name: "db", type: "string", required: false, description: "Database name. If omitted, returns list of all available databases." },
				{ name: "retmode", type: "string", required: false, description: "Output format: 'json' or 'xml' (default xml)" },
			],
		},

		// === Global Query ===
		{
			method: "GET",
			path: "/egquery.fcgi",
			summary: "Search all NCBI databases at once and return hit counts per database.",
			description:
				"Performs a global search across all Entrez databases simultaneously. " +
				"Returns the number of hits in each database for the given query term. " +
				"Useful for discovery — find which databases contain relevant records before targeted searches.",
			category: "search",
			queryParams: [
				{ name: "term", type: "string", required: true, description: "Search query to run across all databases" },
			],
		},

		// === Spell ===
		{
			method: "GET",
			path: "/espell.fcgi",
			summary: "Get spelling suggestions for search terms.",
			description:
				"Returns suggested spelling corrections for query terms. " +
				"Useful for validating user input or auto-correcting search terms before running a search.",
			category: "utility",
			queryParams: [
				{ name: "db", type: "string", required: false, description: "Database context for spelling (default: pubmed)" },
				{ name: "term", type: "string", required: true, description: "Term to check for spelling suggestions" },
			],
		},

		// === Citation Match ===
		{
			method: "GET",
			path: "/ecitmatch.fcgi",
			summary: "Match citation strings to PubMed IDs (batch citation lookup).",
			description:
				"Given citation details (journal, year, volume, page, author), returns matching PubMed IDs. " +
				"The bdata parameter uses pipe-delimited format: journal_title|year|volume|first_page|author_name|your_key| " +
				"Multiple citations separated by \\r (carriage return). " +
				"Useful for resolving references from bibliographies to PubMed records.",
			category: "utility",
			queryParams: [
				{ name: "db", type: "string", required: true, description: "Must be 'pubmed'" },
				{ name: "rettype", type: "string", required: true, description: "Must be 'xml'" },
				{ name: "bdata", type: "string", required: true, description: "Pipe-delimited citation data: journal|year|volume|page|author|key| (separate multiple with \\r)" },
			],
		},
	],
};
