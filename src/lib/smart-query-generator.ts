/**
 * Intelligent SQL query generation for staged relational data
 * Replaces verbose JSON dumps with targeted, context-aware SQL queries
 */

export interface QueryContext {
	operation: string;
	database: string;
	intendedUse?: 'search' | 'analysis' | 'citation' | 'full';
	maxTokens?: number;
	userQuery?: string;
}

export interface SmartQueryResult {
	summary: string;
	keyFindings: string[];
	suggestedQueries: string[];
	tokenEstimate: number;
}

export class SmartQueryGenerator {
	
	/**
	 * Generate intelligent SQL queries based on staged data schema and context
	 */
	static generateContextualQueries(schema: any, context: QueryContext): string[] {
		const { operation, database, intendedUse = 'analysis', userQuery } = context;
		
		// Base table identification
		const tables = Object.keys(schema.tables || {});
		const mainTable = this.identifyMainTable(tables, database);
		
		// Generate queries based on intended use
		switch (intendedUse) {
			case 'search':
				return this.generateSearchQueries(mainTable, schema, userQuery);
			case 'citation':
				return this.generateCitationQueries(mainTable, schema);
			case 'analysis':
				return this.generateAnalysisQueries(mainTable, schema);
			default:
				return this.generateSummaryQueries(mainTable, schema);
		}
	}

	/**
	 * Generate search-focused queries for quick scanning
	 */
	private static generateSearchQueries(mainTable: string, schema: any, userQuery?: string): string[] {
		const queries = [];
		
		// Basic article listing with key metadata
		queries.push(`
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
		`.trim());

		// If user provided search context, filter accordingly
		if (userQuery) {
			const searchTerms = this.extractSearchTerms(userQuery);
			if (searchTerms.length > 0) {
				queries.push(`
					SELECT 
						uid,
						title,
						first_author, 
						pub_year,
						journal,
						-- Relevance scoring
						CASE 
							WHEN title LIKE '%${searchTerms[0]}%' THEN 3
							WHEN abstract LIKE '%${searchTerms[0]}%' THEN 2  
							ELSE 1
						END as relevance_score
					FROM ${mainTable}
					WHERE ${searchTerms.map(term => 
						`(title LIKE '%${term}%' OR abstract LIKE '%${term}%')`
					).join(' OR ')}
					ORDER BY relevance_score DESC, pub_year DESC
					LIMIT 15
				`.trim());
			}
		}

		return queries;
	}

	/**
	 * Generate citation-ready queries
	 */
	private static generateCitationQueries(mainTable: string, schema: any): string[] {
		return [`
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
				-- Citation format
				authors_formatted || '. ' || title || '. ' || journal || '. ' || pub_year ||
				CASE WHEN volume IS NOT NULL THEN ';' || volume ELSE '' END ||
				CASE WHEN pages IS NOT NULL THEN ':' || pages ELSE '' END ||
				'. PMID: ' || uid as citation
			FROM ${mainTable}
			WHERE title IS NOT NULL
			ORDER BY pub_year DESC
			LIMIT 25
		`.trim()];
	}

	/**
	 * Generate analytical queries for research insights
	 */
	private static generateAnalysisQueries(mainTable: string, schema: any): string[] {
		const queries = [];
		
		// Publication trends
		queries.push(`
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
		`.trim());

		// Journal analysis
		queries.push(`
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
		`.trim());

		// Author productivity (if authors table exists)
		if (schema.tables?.authors || schema.tables?.article_authors) {
			queries.push(`
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
			`.trim());
		}

		return queries;
	}

	/**
	 * Generate summary queries for overview
	 */
	private static generateSummaryQueries(mainTable: string, schema: any): string[] {
		return [`
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
		`.trim()];
	}

	/**
	 * Execute queries and format results intelligently
	 */
	static async executeAndFormat(
		queries: string[], 
		executor: (sql: string) => Promise<any[]>,
		context: QueryContext
	): Promise<SmartQueryResult> {
		const results = [];
		let totalTokens = 0;

		for (const query of queries) {
			try {
				const queryResult = await executor(query);
				const formatted = this.formatQueryResult(queryResult, context);
				results.push(formatted);
				totalTokens += this.estimateTokens(formatted);
				
				// Stop if approaching token limit
				if (context.maxTokens && totalTokens > context.maxTokens * 0.8) {
					break;
				}
			} catch (error) {
				console.warn('Query execution failed:', query, error);
			}
		}

		return {
			summary: this.generateSummary(results, context),
			keyFindings: this.extractKeyFindings(results),
			suggestedQueries: this.generateFollowUpQueries(context),
			tokenEstimate: totalTokens
		};
	}

	/**
	 * Format individual query results
	 */
	private static formatQueryResult(rows: any[], context: QueryContext): string {
		if (!rows || rows.length === 0) return 'No results found';
		
		const { intendedUse = 'analysis' } = context;
		
		if (intendedUse === 'citation' && rows[0].citation) {
			return rows.map(row => row.citation).join('\n\n');
		}
		
		if (intendedUse === 'search' && rows[0].title) {
			return rows.map((row, idx) => 
				`${idx + 1}. **${row.title}** (${row.pub_year})\n   ${row.first_author} | ${row.journal} | PMID: ${row.uid}`
			).join('\n\n');
		}
		
		// Default tabular format for analysis
		if (rows.length === 1 && typeof rows[0] === 'object') {
			// Single summary row
			return Object.entries(rows[0])
				.map(([key, value]) => `**${this.humanizeColumn(key)}**: ${value}`)
				.join('\n');
		}
		
		// Multiple rows - create compact table
		const headers = Object.keys(rows[0]);
		const maxRows = context.maxTokens && context.maxTokens < 300 ? 5 : 10;
		const displayRows = rows.slice(0, maxRows);
		
		return displayRows.map(row => 
			headers.map(h => `${this.humanizeColumn(h)}: ${row[h]}`).join(' | ')
		).join('\n') + (rows.length > maxRows ? `\n... and ${rows.length - maxRows} more` : '');
	}

	/**
	 * Helper methods
	 */
	private static identifyMainTable(tables: string[], database: string): string {
		// Logic to identify primary data table
		const candidates = ['articles', 'pubmed_articles', 'main_data', tables[0]];
		return tables.find(t => candidates.includes(t)) || tables[0] || 'main_table';
	}

	private static extractSearchTerms(query: string): string[] {
		// Simple term extraction - could be enhanced with NLP
		return query.toLowerCase()
			.split(/\s+/)
			.filter(term => term.length > 2 && !['and', 'or', 'the', 'for', 'with'].includes(term))
			.slice(0, 3);
	}

	private static humanizeColumn(column: string): string {
		return column.replace(/_/g, ' ')
			.replace(/\b\w/g, l => l.toUpperCase())
			.replace(/Pmid/g, 'PMID')
			.replace(/Doi/g, 'DOI');
	}

	private static generateSummary(results: string[], context: QueryContext): string {
		const operation = context.operation || 'data analysis';
		const count = results.length;
		return `📊 **${operation} Summary**: Generated ${count} analytical insights from staged relational data`;
	}

	private static extractKeyFindings(results: string[]): string[] {
		// Extract notable patterns from results
		const findings = [];
		results.forEach(result => {
			if (result.includes('Total Articles:')) findings.push('Dataset size and coverage metrics available');  
			if (result.includes('PMID:')) findings.push('Individual article details retrieved');
			if (result.includes('Year:')) findings.push('Temporal publication patterns identified');
		});
		return findings.slice(0, 5);
	}

	private static generateFollowUpQueries(context: QueryContext): string[] {
		return [
			'Filter by specific publication years or date ranges',
			'Analyze author collaboration patterns',
			'Group by journal or publication type',
			'Search for specific keywords in titles/abstracts'
		];
	}

	private static estimateTokens(text: string): number {
		return Math.ceil(text.length / 4);
	}
}