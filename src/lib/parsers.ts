// src/lib/parsers.ts

import { ParsingDiagnostics } from './types.js';

// Enhanced interface for our parsers that returns typed entities with diagnostics.
export interface IContentParser {
    parse(content: string): { 
        entities: { type: string; data: any }[]; 
        diagnostics: ParsingDiagnostics;
    };
}

// Enhanced parser for PubMed's XML format with fallback strategies and diagnostics.
export class PubMedXMLParser implements IContentParser {
    parse(content: string): { entities: { type: string; data: any }[]; diagnostics: ParsingDiagnostics } {
        const allEntities: { type: string; data: any }[] = [];
        const diagnostics: ParsingDiagnostics = {
            method_used: 'mesh_descriptors',
            terms_found: 0,
            failed_extractions: [],
            warnings: [],
            indexing_status: 'unknown',
            mesh_availability: 'none'
        };

        const articleMatches = content.match(/<PubmedArticle>[\s\S]+?<\/PubmedArticle>/g) || [];
        let totalMeshTerms = 0;
        let articlesWithMesh = 0;

        for (const articleXml of articleMatches) {
            const pmidMatch = articleXml.match(/<PMID[^>]*>(\d+)<\/PMID>/);
            const titleMatch = articleXml.match(/<ArticleTitle>([\s\S]+?)<\/ArticleTitle>/);
            const abstractMatch = articleXml.match(/<AbstractText[^>]*>([\s\S]+?)<\/AbstractText>/i);
            const journalMatch = articleXml.match(/<Title>([\s\S]+?)<\/Title>/);
            const yearMatch = articleXml.match(/<PubDate>[\s\S]*?<Year>(\d{4})<\/Year>/);

            const articleUID = pmidMatch ? pmidMatch[1] : `art_${Math.random()}`;

            // --- ENHANCED AUTHOR PARSING ---
            const authorRegex = /<Author[^>]*>([\s\S]*?)<\/Author>/g;
            const lastNameRegex = /<LastName>([^<]+)<\/LastName>/;
            const foreNameRegex = /<ForeName>([^<]+)<\/ForeName>/;
            const affiliationRegex = /<Affiliation>([^<]+)<\/Affiliation>/;
            
            const authorBlocks = Array.from(articleXml.matchAll(authorRegex));
            
            const authors = authorBlocks.map((authorBlock, index) => {
                const authorContent = authorBlock[1];
                const lastNameMatch = authorContent.match(lastNameRegex);
                const foreNameMatch = authorContent.match(foreNameRegex);
                const affiliations = Array.from(authorContent.matchAll(/<Affiliation>([^<]+)<\/Affiliation>/g)).map(m => m[1].trim());
                
                const authorData = {
                    uid: `${articleUID}_auth_${index}`,
                    lastname: lastNameMatch ? lastNameMatch[1].trim() : null,
                    forename: foreNameMatch ? foreNameMatch[1].trim() : null,
                    affiliation: affiliations.length > 0 ? affiliations.join('; ') : null
                };
                allEntities.push({ type: 'author', data: authorData });
                return authorData;
            });

            // --- ENHANCED MeSH PARSING WITH FALLBACK STRATEGIES ---
            const meshTerms = this.extractMeshTermsWithFallback(articleXml, articleUID, diagnostics);
            
            if (meshTerms.length > 0) {
                articlesWithMesh++;
                totalMeshTerms += meshTerms.length;
            } else {
                // Try fallback extraction from title/abstract
                const fallbackTerms = this.extractFallbackTerms(
                    titleMatch ? titleMatch[1] : '', 
                    abstractMatch ? abstractMatch[1] : '', 
                    articleUID, 
                    diagnostics
                );
                meshTerms.push(...fallbackTerms);
            }

            // Add mesh terms to entities
            meshTerms.forEach(term => allEntities.push({ type: 'meshterm', data: term }));

            // --- CREATE THE FINAL ARTICLE OBJECT ---
            allEntities.push({
                type: 'article',
                data: {
                    uid: articleUID,
                    pmid: articleUID,
                    title: titleMatch ? titleMatch[1].trim() : 'No Title',
                    journal: journalMatch ? journalMatch[1].trim() : null,
                    year: yearMatch ? parseInt(yearMatch[1], 10) : null,
                    abstract: abstractMatch ? abstractMatch[1].trim() : null,
                    authors: authors,
                    meshTerms: meshTerms,
                }
            });
        }

        // Update diagnostics
        diagnostics.terms_found = totalMeshTerms;
        const meshSuccessRate = articleMatches.length > 0 ? (articlesWithMesh / articleMatches.length) * 100 : 0;
        
        if (meshSuccessRate > 75) {
            diagnostics.mesh_availability = 'full';
            diagnostics.indexing_status = 'complete';
        } else if (meshSuccessRate > 25) {
            diagnostics.mesh_availability = 'partial';
            diagnostics.indexing_status = 'in_progress';
        } else {
            diagnostics.mesh_availability = 'none';
            diagnostics.indexing_status = 'not_indexed';
            diagnostics.warnings.push('Low MeSH term availability - articles may be too recent or not yet indexed');
        }

        return { entities: allEntities, diagnostics };
    }

    private extractMeshTermsWithFallback(articleXml: string, articleUID: string, diagnostics: ParsingDiagnostics): any[] {
        const strategies = [
            () => this.extractMeshDescriptors(articleXml, articleUID),
            () => this.extractMeshQualifiers(articleXml, articleUID),
            () => this.extractKeywordsAsMesh(articleXml, articleUID),
        ];

        for (const [index, strategy] of strategies.entries()) {
            try {
                const terms = strategy();
                if (terms.length > 0) {
                    diagnostics.method_used = ['mesh_descriptors', 'mesh_qualifiers', 'keywords_as_mesh'][index];
                    return terms;
                }
            } catch (error) {
                diagnostics.failed_extractions.push(`Strategy ${index + 1}: ${error instanceof Error ? error.message : 'Unknown error'}`);
            }
        }

        return [];
    }

    private extractMeshDescriptors(articleXml: string, articleUID: string): any[] {
        const meshRegex = /<MeshHeading>([\s\S]*?)<\/MeshHeading>/g;
        const descriptorRegex = /<DescriptorName[^>]*>([^<]+)<\/DescriptorName>/;
        
        const meshBlocks = Array.from(articleXml.matchAll(meshRegex));
        
        return meshBlocks.map((meshBlock, index) => {
            const meshContent = meshBlock[1];
            const descriptorMatch = meshContent.match(descriptorRegex);
            
            return {
                uid: `${articleUID}_mesh_${index}`,
                descriptorname: descriptorMatch ? descriptorMatch[1].trim() : null
            };
        }).filter(term => term.descriptorname);
    }

    private extractMeshQualifiers(articleXml: string, articleUID: string): any[] {
        const qualifierRegex = /<QualifierName[^>]*>([^<]+)<\/QualifierName>/g;
        const qualifiers = Array.from(articleXml.matchAll(qualifierRegex));
        
        return qualifiers.map((match, index) => ({
            uid: `${articleUID}_mesh_qual_${index}`,
            descriptorname: match[1].trim()
        }));
    }

    private extractKeywordsAsMesh(articleXml: string, articleUID: string): any[] {
        const keywordRegex = /<Keyword[^>]*>([^<]+)<\/Keyword>/g;
        const keywords = Array.from(articleXml.matchAll(keywordRegex));
        
        return keywords.map((match, index) => ({
            uid: `${articleUID}_mesh_kw_${index}`,
            descriptorname: match[1].trim()
        }));
    }

    private extractFallbackTerms(title: string, abstract: string, articleUID: string, diagnostics: ParsingDiagnostics): any[] {
        const fallbackTerms: any[] = [];
        const text = `${title} ${abstract}`.toLowerCase();
        
        // Extract likely medical/scientific terms
        const medicalTerms = [
            'cancer', 'tumor', 'mutation', 'protein', 'gene', 'therapy', 'treatment',
            'drug', 'pharmacology', 'clinical', 'patient', 'disease', 'syndrome',
            'receptor', 'inhibitor', 'biomarker', 'expression', 'pathway'
        ];

        medicalTerms.forEach((term, index) => {
            if (text.includes(term)) {
                fallbackTerms.push({
                    uid: `${articleUID}_mesh_fallback_${index}`,
                    descriptorname: term.charAt(0).toUpperCase() + term.slice(1)
                });
            }
        });

        if (fallbackTerms.length > 0) {
            diagnostics.method_used = 'fallback_extraction';
            diagnostics.warnings.push('Used fallback term extraction from title/abstract');
        }

        return fallbackTerms;
    }
}

// Enhanced parser for EInfo responses with structured field and link data
export class EInfoXMLParser implements IContentParser {
    parse(content: string): { entities: { type: string; data: any }[]; diagnostics: ParsingDiagnostics } {
        const allEntities: { type: string; data: any }[] = [];
        const diagnostics: ParsingDiagnostics = {
            method_used: 'einfo_extraction',
            terms_found: 0,
            failed_extractions: [],
            warnings: [],
            indexing_status: 'complete',
            mesh_availability: 'none'
        };

        // Extract database info
        const dbNameMatch = content.match(/<DbName>([^<]+)<\/DbName>/);
        const dbDescMatch = content.match(/<Description>([^<]+)<\/Description>/);
        const countMatch = content.match(/<Count>([^<]+)<\/Count>/);
        const lastUpdateMatch = content.match(/<LastUpdate>([^<]+)<\/LastUpdate>/);

        if (dbNameMatch) {
            allEntities.push({
                type: 'database_info',
                data: {
                    uid: `db_${dbNameMatch[1]}`,
                    name: dbNameMatch[1],
                    description: dbDescMatch ? dbDescMatch[1] : null,
                    record_count: countMatch ? parseInt(countMatch[1], 10) : null,
                    last_update: lastUpdateMatch ? lastUpdateMatch[1] : null
                }
            });
        }

        // Extract searchable fields
        const fieldMatches = content.match(/<Field>[\s\S]*?<\/Field>/g) || [];
        fieldMatches.forEach((fieldXml, index) => {
            const nameMatch = fieldXml.match(/<Name>([^<]+)<\/Name>/);
            const fullNameMatch = fieldXml.match(/<FullName>([^<]+)<\/FullName>/);
            const isDateMatch = fieldXml.match(/<IsDate>([^<]+)<\/IsDate>/);
            const isNumericalMatch = fieldXml.match(/<IsNumerical>([^<]+)<\/IsNumerical>/);

            if (nameMatch) {
                allEntities.push({
                    type: 'searchable_field',
                    data: {
                        uid: `field_${nameMatch[1]}_${index}`,
                        name: nameMatch[1],
                        full_name: fullNameMatch ? fullNameMatch[1] : null,
                        is_date: isDateMatch ? isDateMatch[1] === 'Y' : false,
                        is_numerical: isNumericalMatch ? isNumericalMatch[1] === 'Y' : false
                    }
                });
            }
        });

        // Extract available links
        const linkMatches = content.match(/<Link>[\s\S]*?<\/Link>/g) || [];
        linkMatches.forEach((linkXml, index) => {
            const nameMatch = linkXml.match(/<Name>([^<]+)<\/Name>/);
            const menuMatch = linkXml.match(/<Menu>([^<]+)<\/Menu>/);
            const dbToMatch = linkXml.match(/<DbTo>([^<]+)<\/DbTo>/);

            if (nameMatch) {
                allEntities.push({
                    type: 'link_info',
                    data: {
                        uid: `link_${nameMatch[1]}_${index}`,
                        name: nameMatch[1],
                        menu_name: menuMatch ? menuMatch[1] : null,
                        target_db: dbToMatch ? dbToMatch[1] : null
                    }
                });
            }
        });

        diagnostics.terms_found = allEntities.length;
        return { entities: allEntities, diagnostics };
    }
}

// Enhanced parser for ESummary responses with structured document summaries
export class ESummaryXMLParser implements IContentParser {
    parse(content: string): { entities: { type: string; data: any }[]; diagnostics: ParsingDiagnostics } {
        const allEntities: { type: string; data: any }[] = [];
        const diagnostics: ParsingDiagnostics = {
            method_used: 'esummary_extraction',
            terms_found: 0,
            failed_extractions: [],
            warnings: [],
            indexing_status: 'complete',
            mesh_availability: 'none'
        };

        const docSumMatches = content.match(/<DocSum>[\s\S]*?<\/DocSum>/g) || [];
        
        for (const docSumXml of docSumMatches) {
            const idMatch = docSumXml.match(/<Id>([^<]+)<\/Id>/);
            if (!idMatch) continue;

            const uid = idMatch[1];
            const summary: any = { uid, pmid: uid };

            // Extract common fields
            const titleMatch = docSumXml.match(/<Item Name="Title"[^>]*>([^<]*)<\/Item>/);
            const authorsMatch = docSumXml.match(/<Item Name="AuthorList"[^>]*>([\s\S]*?)<\/Item>/);
            const journalMatch = docSumXml.match(/<Item Name="FullJournalName"[^>]*>([^<]*)<\/Item>/);
            const pubDateMatch = docSumXml.match(/<Item Name="PubDate"[^>]*>([^<]*)<\/Item>/);
            const doiMatch = docSumXml.match(/<Item Name="DOI"[^>]*>([^<]*)<\/Item>/);

            summary.title = titleMatch ? titleMatch[1] : null;
            summary.journal = journalMatch ? journalMatch[1] : null;
            summary.pub_date = pubDateMatch ? pubDateMatch[1] : null;
            summary.doi = doiMatch ? doiMatch[1] : null;

            // Extract authors from AuthorList
            if (authorsMatch) {
                const authorItems = authorsMatch[1].match(/<Item Name="Author"[^>]*>([^<]*)<\/Item>/g) || [];
                summary.authors = authorItems.map(item => {
                    const authorMatch = item.match(/>([^<]*)</);
                    return authorMatch ? authorMatch[1] : '';
                }).filter(author => author);
            }

            allEntities.push({
                type: 'document_summary',
                data: summary
            });
        }

        diagnostics.terms_found = allEntities.length;
        return { entities: allEntities, diagnostics };
    }
}

// Enhanced parser for BLAST submit responses to extract RID
export class BlastSubmitParser implements IContentParser {
    parse(content: string): { entities: { type: string; data: any }[]; diagnostics: ParsingDiagnostics } {
        const allEntities: { type: string; data: any }[] = [];
        const diagnostics: ParsingDiagnostics = {
            method_used: 'blast_submit_extraction',
            terms_found: 0,
            failed_extractions: [],
            warnings: [],
            indexing_status: 'complete',
            mesh_availability: 'none'
        };

        // Extract RID from HTML response
        const ridMatch = content.match(/value="([A-Z0-9]+)"\s+id="rid"|RID\s*=\s*([A-Z0-9]+)/i);
        const estimateMatch = content.match(/We estimate that results will be ready in (\d+)/i);
        
        if (ridMatch) {
            const rid = ridMatch[1] || ridMatch[2];
            allEntities.push({
                type: 'blast_job',
                data: {
                    uid: rid,
                    rid: rid,
                    status: 'submitted',
                    estimated_time: estimateMatch ? parseInt(estimateMatch[1], 10) : null
                }
            });
            diagnostics.terms_found = 1;
        } else {
            diagnostics.failed_extractions.push('Could not extract RID from BLAST response');
        }

        return { entities: allEntities, diagnostics };
    }
}

// Enhanced fallback parser for unstructured data.
export class FallbackParser implements IContentParser {
    parse(content: any): { entities: { type: string; data: any }[]; diagnostics: ParsingDiagnostics } {
        const diagnostics: ParsingDiagnostics = {
            method_used: 'fallback_raw',
            terms_found: 0,
            failed_extractions: [],
            warnings: ['Content could not be parsed with specialized parser'],
            indexing_status: 'unknown',
            mesh_availability: 'none'
        };

        return { 
            entities: [{ type: 'raw_data', data: { uid: 'raw_1', content: JSON.stringify(content) } }],
            diagnostics
        };
    }
}

// Factory to select the appropriate parser.
export function getParserFor(db: string, rettype?: string): IContentParser {
    if (db === 'pubmed' && rettype === 'xml') {
        return new PubMedXMLParser();
    }
    return new FallbackParser();
}

// Factory to get parser for specific tool responses
export function getParserForTool(toolName: string, content: string): IContentParser {
    switch (toolName) {
        case 'EInfo':
            return new EInfoXMLParser();
        case 'ESummary':
            return new ESummaryXMLParser();
        case 'EFetch':
            // Determine database from content or use PubMed as default
            if (content.includes('<PubmedArticle>')) {
                return new PubMedXMLParser();
            }
            return new FallbackParser();
        case 'BLAST Submit':
            return new BlastSubmitParser();
        default:
            return new FallbackParser();
    }
} 