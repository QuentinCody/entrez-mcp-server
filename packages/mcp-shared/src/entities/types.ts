/**
 * Shared entity types for cross-server entity resolution.
 *
 * These types represent canonical entities with identifiers mapped
 * across multiple biological databases.
 */

export interface ResolvedGene {
	entity_type: "gene";
	symbol: string;
	ensembl_id: string | null;
	uniprot_accessions: string[];
	ncbi_gene_id: string | null;
	hgnc_id: string | null;
	name: string | null;
}

export interface ResolvedDrug {
	entity_type: "drug";
	name: string;
	rxcui: string | null;
	chembl_id: string | null;
	drugbank_id: string | null;
	cas_number: string | null;
}

export interface ResolvedDisease {
	entity_type: "disease";
	name: string;
	mondo_id: string | null;
	doid: string | null;
	efo_id: string | null;
	icd10_codes: string[];
}

export interface ResolvedProtein {
	entity_type: "protein";
	name: string;
	uniprot_accession: string | null;
	ensembl_protein_id: string | null;
	pdb_ids: string[];
	gene_symbol: string | null;
}

export interface ResolvedVariant {
	entity_type: "variant";
	name: string;
	hgvs: string | null;
	rsid: string | null;
	civic_id: string | null;
	clinvar_id: string | null;
}

export type ResolvedEntity =
	| ResolvedGene
	| ResolvedDrug
	| ResolvedDisease
	| ResolvedProtein
	| ResolvedVariant;
