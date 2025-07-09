// src/lib/parsers.ts

// A specific interface for our parsers that returns typed entities.
export interface IContentParser {
    parse(content: string): { type: string; data: any }[];
}

// A robust parser for PubMed's XML format with corrected regex.
export class PubMedXMLParser implements IContentParser {
    parse(content: string): { type: string; data: any }[] {
        const allEntities: { type: string; data: any }[] = [];
        const articleMatches = content.match(/<PubmedArticle>[\s\S]+?<\/PubmedArticle>/g) || [];

        for (const articleXml of articleMatches) {
            const pmidMatch = articleXml.match(/<PMID[^>]*>(\d+)<\/PMID>/);
            const titleMatch = articleXml.match(/<ArticleTitle>([\s\S]+?)<\/ArticleTitle>/);
            const abstractMatch = articleXml.match(/<AbstractText[^>]*>([\s\S]+?)<\/AbstractText>/i);
            const journalMatch = articleXml.match(/<Title>([\s\S]+?)<\/Title>/);
            const yearMatch = articleXml.match(/<PubDate>[\s\S]*?<Year>(\d{4})<\/Year>/);

            const articleUID = pmidMatch ? pmidMatch[1] : `art_${Math.random()}`;

            // --- ROBUST AUTHOR PARSING with Correct Column Names ---
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
                    lastname: lastNameMatch ? lastNameMatch[1].trim() : null,  // Fixed: lowercase
                    forename: foreNameMatch ? foreNameMatch[1].trim() : null,  // Fixed: lowercase
                    affiliation: affiliationMatch ? affiliationMatch[1].trim() : null
                };
                allEntities.push({ type: 'author', data: authorData });
                return authorData;
            });

            // --- ROBUST MeSH PARSING with Correct Column Names ---
            const meshRegex = /<MeshHeading>([\s\S]*?)<\/MeshHeading>/g;
            const descriptorRegex = /<DescriptorName[^>]*>([^<]+)<\/DescriptorName>/;
            
            const meshBlocks = Array.from(articleXml.matchAll(meshRegex));
            
            const meshTerms = meshBlocks.map((meshBlock, index) => {
                const meshContent = meshBlock[1];
                const descriptorMatch = meshContent.match(descriptorRegex);
                
                const meshData = {
                    uid: `${articleUID}_mesh_${index}`,
                    descriptorname: descriptorMatch ? descriptorMatch[1].trim() : null  // Fixed: lowercase
                };
                allEntities.push({ type: 'meshterm', data: meshData });
                return meshData;
            });

            // --- 3. CREATE THE FINAL ARTICLE OBJECT ---
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
        
        return allEntities;
    }
}

// Fallback parser for unstructured data remains the same.
export class FallbackParser implements IContentParser {
    parse(content: any): { type: string; data: any }[] {
        return [{ type: 'raw_data', data: { uid: 'raw_1', content: JSON.stringify(content) } }];
    }
}

// Factory to select the appropriate parser remains the same.
export function getParserFor(db: string, rettype?: string): IContentParser {
    if (db === 'pubmed' && rettype === 'xml') {
        return new PubMedXMLParser();
    }
    return new FallbackParser();
} 