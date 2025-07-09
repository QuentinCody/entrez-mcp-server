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
                const affiliationMatch = authorContent.match(affiliationRegex);
                
                const authorData = {
                    uid: `${articleUID}_auth_${index}`,
                    lastname: lastNameMatch ? lastNameMatch[1].trim() : null,
                    forename: foreNameMatch ? foreNameMatch[1].trim() : null,
                    affiliation: affiliationMatch ? affiliationMatch[1].trim() : null
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