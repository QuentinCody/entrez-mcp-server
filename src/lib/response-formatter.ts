/**
 * Token-efficient response formatter for NCBI API responses
 * Provides context-aware, compact formatting to optimize LLM token usage
 */

export interface FormattingOptions {
	maxTokens?: number;
	intendedUse?: 'search' | 'analysis' | 'citation' | 'full';
	includeMetadata?: boolean;
	compactMode?: boolean;
}

export class ResponseFormatter {
	private static readonly DEFAULT_MAX_TOKENS = 500;
	private static readonly COMPACT_MAX_TOKENS = 200;

	/**
	 * Format ESummary responses efficiently based on intended use and database
	 */
	static formatESummary(data: any, options: FormattingOptions = {}, database?: string): string {
		const { intendedUse = 'analysis', maxTokens = this.DEFAULT_MAX_TOKENS, compactMode = false } = options;
		
		if (typeof data === 'string') return data;
		if (!data?.result) return JSON.stringify(data);

		const results = Object.keys(data.result)
			.filter(key => key !== 'uids')
			.map(uid => data.result[uid])
			.filter(item => item && typeof item === 'object');

		if (results.length === 0) return 'No results found';

		// Route to database-specific formatters
		switch (database) {
			case 'gene':
				return this.formatGeneSummary(results, intendedUse, compactMode);
			case 'protein':
				return this.formatProteinSummary(results, intendedUse, compactMode);
			case 'nucleotide':
			case 'nuccore':
				return this.formatNucleotideSummary(results, intendedUse, compactMode);
			case 'pubmed':
			default:
				// Default to PubMed formatting
				switch (intendedUse) {
					case 'search':
						return this.formatSearchSummary(results, compactMode);
					case 'citation':
						return this.formatCitationSummary(results, compactMode);
					case 'analysis':
						return this.formatAnalysisSummary(results, maxTokens);
					default:
						return this.formatCompactSummary(results, maxTokens);
				}
		}
	}

	/**
	 * Format search results for quick scanning
	 */
	private static formatSearchSummary(results: any[], compact: boolean): string {
		return results.map((item, idx) => {
			const authors = this.getAuthors(item, compact ? 1 : 3);
			const title = item.title || 'No title';
			const journal = item.source || item.fulljournalname || 'Unknown journal';
			const year = this.extractYear(item.pubdate || item.sortpubdate);
			
			if (compact) {
				return `${idx + 1}. ${authors} (${year}). ${this.truncateText(title, 60)}. ${journal}`;
			}
			return `**${item.uid}**: ${authors} (${year})\n📄 ${title}\n📚 ${journal}\n`;
		}).join(compact ? '\n' : '\n');
	}

	/**
	 * Format for citation purposes  
	 */
	private static formatCitationSummary(results: any[], compact: boolean): string {
		return results.map(item => {
			const authors = this.getAuthors(item, compact ? 2 : 5);
			const title = item.title || 'No title';
			const journal = item.source || item.fulljournalname || 'Unknown journal';
			const year = this.extractYear(item.pubdate || item.sortpubdate);
			const volume = item.volume;
			const pages = item.pages;
			const pmid = item.uid;

			let citation = `${authors} ${title} ${journal}. ${year}`;
			if (volume) citation += `;${volume}`;
			if (pages) citation += `:${pages}`;
			citation += `. PMID: ${pmid}`;
			
			return citation;
		}).join('\n\n');
	}

	/**
	 * Format for analysis with key metadata
	 */
	private static formatAnalysisSummary(results: any[], maxTokens: number): string {
		const estimatedTokensPerItem = Math.floor(maxTokens / results.length);
		
		return results.map(item => {
			const authors = this.getAuthors(item, 3);
			const title = item.title || 'No title';
			const journal = item.source || item.fulljournalname || 'Unknown journal';
			const year = this.extractYear(item.pubdate || item.sortpubdate);
			const pmid = item.uid;
			
			// Include abstract if available and space allows
			const hasAbstract = item.attributes?.includes('Has Abstract');
			const pubTypes = Array.isArray(item.pubtype) ? item.pubtype.join(', ') : item.pubtype || '';
			
			let summary = `**PMID ${pmid}** (${year})\n${this.truncateText(title, 100)}\n${authors} | ${journal}`;
			
			if (estimatedTokensPerItem > 50) {
				if (pubTypes) summary += `\n📑 ${pubTypes}`;
				if (hasAbstract) summary += '\n✅ Has Abstract';
			}
			
			return summary;
		}).join('\n\n');
	}

	/**
	 * Ultra-compact format for large result sets
	 */
	private static formatCompactSummary(results: any[], maxTokens: number): string {
		const tokensPerItem = Math.min(50, Math.floor(maxTokens / results.length));
		
		return results.map((item, idx) => {
			const firstAuthor = item.authors?.[0]?.name || item.sortfirstauthor || 'Unknown';
			const year = this.extractYear(item.pubdate || item.sortpubdate);
			const title = this.truncateText(item.title || 'No title', tokensPerItem > 30 ? 80 : 40);
			
			return `${idx + 1}. ${firstAuthor} (${year}): ${title} [PMID: ${item.uid}]`;
		}).join('\n');
	}

	/**
	 * Format EFetch results based on return type
	 */
	static formatEFetch(data: any, rettype?: string, options: FormattingOptions = {}): string {
		const { intendedUse = 'analysis', compactMode = false } = options;
		
		if (typeof data === 'string') {
			// Handle XML/text formats
			if (rettype === 'abstract' || data.includes('<Abstract>')) {
				return this.formatAbstractXML(data, compactMode);
			}
			if (rettype === 'fasta' || data.startsWith('>')) {
				return this.formatFasta(data, compactMode);
			}
			
			// Clean up XML by removing redundant tags and formatting
			if (data.includes('<') && data.includes('>')) {
				return this.cleanXmlResponse(data, compactMode);
			}
			
			// Truncate very long raw responses  
			return data.length > 2000 && compactMode ? 
				data.substring(0, 2000) + '\n\n[...truncated...]' : data;
		}
		
		return JSON.stringify(data);
	}

	/**
	 * Extract and format abstract from XML
	 */
	private static formatAbstractXML(xml: string, compact: boolean): string {
		try {
			// Extract title
			const titleMatch = xml.match(/<ArticleTitle>(.*?)<\/ArticleTitle>/s);
			const title = titleMatch?.[1]?.replace(/<[^>]*>/g, '') || 'No title';
			
			// Extract abstract sections
			const abstractMatch = xml.match(/<Abstract>(.*?)<\/Abstract>/s);
			if (!abstractMatch) return xml;
			
			const abstractContent = abstractMatch[1];
			const sections = abstractContent.match(/<AbstractText[^>]*Label="([^"]*)"[^>]*>(.*?)<\/AbstractText>/gs) || [];
			
			if (sections.length === 0) {
				// No labeled sections, get plain text
				const plainText = abstractContent.replace(/<[^>]*>/g, '').trim();
				return compact ? 
					`${this.truncateText(title, 80)}\n\n${this.truncateText(plainText, 300)}` :
					`**${title}**\n\n${plainText}`;
			}
			
			// Format labeled sections
			const formattedSections = sections.map(section => {
				const labelMatch = section.match(/Label="([^"]*)"/);
				const label = labelMatch?.[1] || '';
				const content = section.replace(/<[^>]*>/g, '').trim();
				
				return compact ? 
					`**${label}**: ${this.truncateText(content, 150)}` :
					`**${label.toUpperCase()}**: ${content}`;
			});
			
			const titleSection = compact ? 
				this.truncateText(title, 60) : 
				`**${title}**`;
				
			return `${titleSection}\n\n${formattedSections.join('\n\n')}`;
			
		} catch (error) {
			return xml;
		}
	}

	/**
	 * Format FASTA sequences
	 */
	private static formatFasta(fasta: string, compact: boolean): string {
		const sequences = fasta.split('\n>').map(seq => seq.startsWith('>') ? seq : '>' + seq);
		
		if (compact && sequences.length > 1) {
			return sequences.map((seq, idx) => {
				const lines = seq.split('\n');
				const header = lines[0];
				const seqLength = lines.slice(1).join('').length;
				return `${idx + 1}. ${header} (${seqLength} bp/aa)`;
			}).join('\n');
		}
		
		return fasta;
	}

	/**
	 * Helper methods
	 */
	private static getAuthors(item: any, maxCount: number): string {
		if (!item.authors || !Array.isArray(item.authors)) {
			return item.sortfirstauthor || 'Unknown authors';
		}
		
		const authors = item.authors.slice(0, maxCount).map((a: any) => a.name || a);
		if (item.authors.length > maxCount) {
			authors.push('et al.');
		}
		
		return authors.join(', ');
	}

	private static extractYear(dateStr: string): string {
		if (!dateStr) return 'Unknown';
		const yearMatch = dateStr.match(/(\d{4})/);
		return yearMatch?.[1] || dateStr.substring(0, 4) || 'Unknown';
	}

	private static truncateText(text: string, maxLength: number): string {
		if (!text || text.length <= maxLength) return text;
		return text.substring(0, maxLength - 3) + '...';
	}

	/**
	 * Format gene database summaries
	 */
	private static formatGeneSummary(results: any[], intendedUse: string, compact: boolean): string {
		return results.map((item, idx) => {
			const geneId = item.uid;
			const name = item.name || 'Unknown gene';
			const description = item.description || 'No description available';
			const organism = item.organism || 'Unknown organism';
			const chromosome = item.chromosome || 'Unknown';
			const maplocation = item.maplocation || 'Unknown location';
			const geneType = item.genetype || 'Unknown type';
			
			if (compact) {
				return `${idx + 1}. **${name}** (ID: ${geneId}) - ${this.truncateText(description, 80)} [${organism}]`;
			}
			
			return `**Gene ID ${geneId}** - ${name}
📋 ${description}
🧬 **Organism**: ${organism}
🧭 **Location**: Chromosome ${chromosome}, ${maplocation}
🔬 **Type**: ${geneType}`;
		}).join(compact ? '\n' : '\n\n');
	}

	/**
	 * Format protein database summaries
	 */
	private static formatProteinSummary(results: any[], intendedUse: string, compact: boolean): string {
		return results.map((item, idx) => {
			const proteinId = item.uid;
			const title = item.title || 'Unknown protein';
			const organism = item.organism || 'Unknown organism';
			const length = item.slen || 'Unknown';
			const accession = item.caption || item.accessionversion || proteinId;
			
			if (compact) {
				return `${idx + 1}. **${accession}** - ${this.truncateText(title, 60)} [${organism}]`;
			}
			
			return `**Protein ID ${proteinId}** - ${accession}
📋 ${title}
🧬 **Organism**: ${organism}
📏 **Length**: ${length} amino acids`;
		}).join(compact ? '\n' : '\n\n');
	}

	/**
	 * Format nucleotide database summaries
	 */
	private static formatNucleotideSummary(results: any[], intendedUse: string, compact: boolean): string {
		return results.map((item, idx) => {
			const seqId = item.uid;
			const title = item.title || 'Unknown sequence';
			const organism = item.organism || 'Unknown organism';
			const length = item.slen || 'Unknown';
			const accession = item.caption || item.accessionversion || seqId;
			const moltype = item.moltype || 'Unknown';
			
			if (compact) {
				return `${idx + 1}. **${accession}** - ${this.truncateText(title, 60)} [${organism}]`;
			}
			
			return `**Sequence ID ${seqId}** - ${accession}
📋 ${title}
🧬 **Organism**: ${organism}
🧪 **Molecule Type**: ${moltype}
📏 **Length**: ${length} nucleotides`;
		}).join(compact ? '\n' : '\n\n');
	}

	/**
	 * Clean XML responses by removing redundant tags and improving readability
	 */
	private static cleanXmlResponse(xml: string, compact: boolean): string {
		let cleaned = xml;
		
		// Remove XML declaration and DOCTYPE
		cleaned = cleaned.replace(/<\?xml[^>]*\?>/g, '');
		cleaned = cleaned.replace(/<!DOCTYPE[^>]*>/g, '');
		
		// Remove common redundant wrapper tags but preserve content
		const redundantWrappers = [
			'PubmedArticleSet',
			'PubmedArticle', 
			'MedlineCitation',
			'Article',
			'AuthorList',
			'KeywordList',
			'PublicationTypeList',
			'ArticleIdList',
			'History'
		];
		
		redundantWrappers.forEach(tag => {
			const regex = new RegExp(`<${tag}[^>]*>|<\/${tag}>`, 'gi');
			cleaned = cleaned.replace(regex, '');
		});
		
		// Convert important tags to readable format
		const tagReplacements = [
			{ from: /<ArticleTitle>/gi, to: '\n**TITLE**: ' },
			{ from: /<\/ArticleTitle>/gi, to: '' },
			{ from: /<AbstractText[^>]*Label="([^"]*)"[^>]*>/gi, to: '\n**$1**: ' },
			{ from: /<AbstractText[^>]*>/gi, to: '\n**ABSTRACT**: ' },
			{ from: /<\/AbstractText>/gi, to: '' },
			{ from: /<Keyword[^>]*>/gi, to: '• ' },
			{ from: /<\/Keyword>/gi, to: '\n' },
			{ from: /<PMID[^>]*>/gi, to: '\n**PMID**: ' },
			{ from: /<\/PMID>/gi, to: '' },
			{ from: /<LastName>/gi, to: '' },
			{ from: /<\/LastName>/gi, to: ', ' },
			{ from: /<ForeName>/gi, to: '' },
			{ from: /<\/ForeName>/gi, to: ' ' },
			{ from: /<Initials>/gi, to: '' },
			{ from: /<\/Initials>/gi, to: '' }
		];
		
		tagReplacements.forEach(({ from, to }) => {
			cleaned = cleaned.replace(from, to);
		});
		
		// Remove remaining XML tags if in compact mode
		if (compact) {
			cleaned = cleaned.replace(/<[^>]*>/g, ' ');
		}
		
		// Clean up whitespace
		cleaned = cleaned
			.replace(/\n\s*\n\s*\n/g, '\n\n') // Remove excessive line breaks
			.replace(/\s+/g, ' ') // Normalize spaces
			.replace(/\n\s+/g, '\n') // Remove leading spaces after newlines
			.trim();
		
		return cleaned;
	}

	/**
	 * Estimate token count (rough approximation)
	 */
	static estimateTokens(text: string): number {
		// Rough estimate: ~4 characters per token
		return Math.ceil(text.length / 4);
	}
}