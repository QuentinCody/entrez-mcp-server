/**
 * Intelligent SQL query generation for staged relational data
 * Replaces verbose JSON dumps with targeted, context-aware SQL queries
 */

export interface QueryContext {
	operation: string;
	database: string;
	intendedUse?: "search" | "analysis" | "citation" | "full";
	maxTokens?: number;
	userQuery?: string;
}

export interface SmartQueryResult {
	summary: string;
	keyFindings: string[];
	suggestedQueries: string[];
	tokenEstimate: number;
}

export type SchemaSummary = {
	tables?: Record<string, unknown>;
};

export type QueryRows = Record<string, unknown>[];

type QueryExecutor = (sql: string) => Promise<QueryRows>;

function identifyMainTable(tables: string[], _database: string): string {
	const candidates = ["articles", "pubmed_articles", "main_data", tables[0]];
	return (
		tables.find((t) => candidates.includes(t)) || tables[0] || "main_table"
	);
}

function extractSearchTerms(query: string): string[] {
	return query
		.toLowerCase()
		.split(/\s+/)
		.filter(
			(term) =>
				term.length > 2 && !["and", "or", "the", "for", "with"].includes(term),
		)
		.slice(0, 3);
}

function humanizeColumn(column: string): string {
	return column
		.replace(/_/g, " ")
		.replace(/\b\w/g, (letter) => letter.toUpperCase())
		.replace(/Pmid/g, "PMID")
		.replace(/Doi/g, "DOI");
}

function generateSearchQueries(
	mainTable: string,
	_schema: SchemaSummary,
	userQuery?: string,
): string[] {
	const queries: string[] = [];

	queries.push(
		`
		SELECT 
			uid,
			title,
			first_author,
			pub_year,
			journal,
			publication_type
		FROM ${mainTable} 
		ORDER BY pub_year DESC 
		LIMIT 20
	`.trim(),
	);

	if (userQuery) {
		const searchTerms = extractSearchTerms(userQuery);
		if (searchTerms.length > 0) {
			queries.push(
				`
				SELECT 
					uid,
					title,
					first_author, 
					pub_year,
					journal,
					CASE 
						WHEN title LIKE '%${searchTerms[0]}%' THEN 3
						WHEN abstract LIKE '%${searchTerms[0]}%' THEN 2  
						ELSE 1
					END as relevance_score
				FROM ${mainTable}
				WHERE ${searchTerms
					.map(
						(term) => `(
					title LIKE '%${term}%' OR abstract LIKE '%${term}%'
				)`,
					)
					.join(" OR ")}
				ORDER BY relevance_score DESC, pub_year DESC
				LIMIT 15
			`.trim(),
			);
		}
	}

	return queries;
}

function generateCitationQueries(
	mainTable: string,
	_schema: SchemaSummary,
): string[] {
	return [
		`
		SELECT 
			uid as pmid,
			title,
			authors_formatted,
			journal,
			pub_year,
			volume,
			issue,
			pages,
			doi,
			authors_formatted || '. ' || title || '. ' || journal || '. ' || pub_year ||
			CASE WHEN volume IS NOT NULL THEN ';' || volume ELSE '' END ||
			CASE WHEN pages IS NOT NULL THEN ':' || pages ELSE '' END ||
			'. PMID: ' || uid as citation
		FROM ${mainTable}
		WHERE title IS NOT NULL
		ORDER BY pub_year DESC
		LIMIT 25
	`.trim(),
	];
}

function generateAnalysisQueries(
	mainTable: string,
	schema: SchemaSummary,
): string[] {
	const queries: string[] = [];

	queries.push(
		`
		SELECT 
			pub_year,
			COUNT(*) as article_count,
			COUNT(DISTINCT journal) as unique_journals,
			GROUP_CONCAT(DISTINCT publication_type) as pub_types
		FROM ${mainTable}
		WHERE pub_year IS NOT NULL
		GROUP BY pub_year
		ORDER BY pub_year DESC
		LIMIT 10
	`.trim(),
	);

	queries.push(
		`
		SELECT 
			journal,
			COUNT(*) as article_count,
			MIN(pub_year) as earliest_year,
			MAX(pub_year) as latest_year,
			AVG(CAST(pub_year as FLOAT)) as avg_year
		FROM ${mainTable}
		WHERE journal IS NOT NULL
		GROUP BY journal
		ORDER BY article_count DESC
		LIMIT 15
	`.trim(),
	);

	if (schema.tables?.authors || schema.tables?.article_authors) {
		queries.push(
			`
			SELECT 
				author_name,
				COUNT(*) as article_count,
				MIN(pub_year) as first_publication,
				MAX(pub_year) as latest_publication
			FROM ${mainTable} a
			JOIN authors au ON a.uid = au.article_uid
			GROUP BY author_name
			ORDER BY article_count DESC
			LIMIT 12
		`.trim(),
		);
	}

	return queries;
}

function generateSummaryQueries(
	mainTable: string,
	_schema: SchemaSummary,
): string[] {
	return [
		`
		SELECT 
			COUNT(*) as total_articles,
			COUNT(DISTINCT journal) as unique_journals,
			COUNT(DISTINCT pub_year) as year_span,
			MIN(pub_year) as earliest_year,
			MAX(pub_year) as latest_year,
			COUNT(CASE WHEN abstract IS NOT NULL THEN 1 END) as articles_with_abstracts,
			COUNT(CASE WHEN doi IS NOT NULL THEN 1 END) as articles_with_doi
		FROM ${mainTable}
	`.trim(),
		`
		SELECT 
			publication_type,
			COUNT(*) as count,
			ROUND(COUNT(*) * 100.0 / (SELECT COUNT(*) FROM ${mainTable}), 1) as percentage
		FROM ${mainTable}
		WHERE publication_type IS NOT NULL
		GROUP BY publication_type
		ORDER BY count DESC
		LIMIT 8
	`.trim(),
	];
}

function generateContextualQueries(
	schema: SchemaSummary,
	context: QueryContext,
): string[] {
	const { database, intendedUse = "analysis", userQuery } = context;
	const tables = Object.keys(schema.tables || {});
	const mainTable = identifyMainTable(tables, database);

	switch (intendedUse) {
		case "search":
			return generateSearchQueries(mainTable, schema, userQuery);
		case "citation":
			return generateCitationQueries(mainTable, schema);
		case "analysis":
			return generateAnalysisQueries(mainTable, schema);
		default:
			return generateSummaryQueries(mainTable, schema);
	}
}

function formatQueryResult(rows: QueryRows, context: QueryContext): string {
	if (!rows || rows.length === 0) return "No results found";

	const { intendedUse = "analysis" } = context;

	if (intendedUse === "citation" && rows[0].citation) {
		return rows.map((row) => String(row.citation)).join("\n\n");
	}

	if (intendedUse === "search" && rows[0].title) {
		return rows
			.map((row, idx) => {
				const title = String(row.title ?? "");
				const pubYear = String(row.pub_year ?? "");
				const author = String(row.first_author ?? "");
				const journal = String(row.journal ?? "");
				const uid = String(row.uid ?? "");
				return `${idx + 1}. **${title}** (${pubYear})\n   ${author} | ${journal} | PMID: ${uid}`;
			})
			.join("\n\n");
	}

	const firstRow = rows[0];
	if (rows.length === 1 && typeof firstRow === "object") {
		return Object.entries(firstRow)
			.map(([key, value]) => `**${humanizeColumn(key)}**: ${value}`)
			.join("\n");
	}

	const headers = Object.keys(firstRow);
	const maxRows = context.maxTokens && context.maxTokens < 300 ? 5 : 10;
	const displayRows = rows.slice(0, maxRows);

	const rendered = displayRows
		.map((row) =>
			headers
				.map((header) => `${humanizeColumn(header)}: ${row[header]}`)
				.join(" | "),
		)
		.join("\n");

	return rows.length > maxRows
		? `${rendered}\n... and ${rows.length - maxRows} more`
		: rendered;
}

function generateSummary(results: string[], context: QueryContext): string {
	const operation = context.operation || "data analysis";
	const count = results.length;
	return `📊 **${operation} Summary**: Generated ${count} analytical insights from staged relational data`;
}

function extractKeyFindings(results: string[]): string[] {
	const findings: string[] = [];
	results.forEach((result) => {
		if (result.includes("Total Articles:"))
			findings.push("Dataset size and coverage metrics available");
		if (result.includes("PMID:"))
			findings.push("Individual article details retrieved");
		if (result.includes("Year:"))
			findings.push("Temporal publication patterns identified");
	});
	return findings.slice(0, 5);
}

function generateFollowUpQueries(): string[] {
	return [
		"Filter by specific publication years or date ranges",
		"Analyze author collaboration patterns",
		"Group by journal or publication type",
		"Search for specific keywords in titles/abstracts",
	];
}

function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

async function executeAndFormat(
	queries: string[],
	executor: QueryExecutor,
	context: QueryContext,
): Promise<SmartQueryResult> {
	const results: string[] = [];
	let totalTokens = 0;

	for (const query of queries) {
		try {
			const queryResult = await executor(query);
			const formatted = formatQueryResult(queryResult, context);
			results.push(formatted);
			totalTokens += estimateTokens(formatted);

			if (context.maxTokens && totalTokens > context.maxTokens * 0.8) {
				break;
			}
		} catch (error) {
			console.warn("Query execution failed:", query, error);
		}
	}

	return {
		summary: generateSummary(results, context),
		keyFindings: extractKeyFindings(results),
		suggestedQueries: generateFollowUpQueries(),
		tokenEstimate: totalTokens,
	};
}

export const SmartQueryGenerator = {
	generateContextualQueries,
	executeAndFormat,
	formatQueryResult,
	estimateTokens,
	extractKeyFindings,
	generateFollowUpQueries,
};
