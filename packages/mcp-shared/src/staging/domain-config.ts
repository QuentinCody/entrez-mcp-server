/**
 * Pre-built DomainConfig objects for each server that uses Tier 2 normalization.
 *
 * All per-server customization is expressed here as configuration — no code forks.
 */

import type { DomainConfig } from "./types";

// ---------------------------------------------------------------------------
// DEFAULT — baseline config for unknown / new servers
// ---------------------------------------------------------------------------

export const DEFAULT_CONFIG: DomainConfig = {
	name: "default",
	wrapperKeys: ["nodes", "edges", "rows"],
	entityDetection: "standard",
};

// ---------------------------------------------------------------------------
// CIViC
// ---------------------------------------------------------------------------

export const CIVIC_CONFIG: DomainConfig = {
	name: "civic",
	columnNameMappings: {
		entrezid: "entrez_id",
		displayname: "display_name",
		varianttype: "variant_type",
		evidencelevel: "evidence_level",
		evidencetype: "evidence_type",
		evidencedirection: "evidence_direction",
		sourcetype: "source_type",
		molecularprofile: "molecular_profile",
		genomicchange: "genomic_change",
	},
	wrapperKeys: ["nodes", "edges"],
	entityDetection: "standard",
};

// ---------------------------------------------------------------------------
// DGIdb
// ---------------------------------------------------------------------------

export const DGIDB_CONFIG: DomainConfig = {
	name: "dgidb",
	columnNameMappings: {
		entrezid: "entrez_id",
		displayname: "display_name",
		conceptid: "concept_id",
		drugname: "drug_name",
		genename: "gene_name",
		interactiontype: "interaction_type",
		sourcetype: "source_type",
		sourcedb: "source_db",
		varianttype: "variant_type",
		evidencelevel: "evidence_level",
		evidencetype: "evidence_type",
		evidencedirection: "evidence_direction",
		molecularprofile: "molecular_profile",
		genomicchange: "genomic_change",
	},
	wrapperKeys: ["nodes", "edges"],
	entityDetection: "loose",
};

// ---------------------------------------------------------------------------
// Open Targets
// ---------------------------------------------------------------------------

export const OPENTARGETS_CONFIG: DomainConfig = {
	name: "opentargets",
	columnNameMappings: {
		ensemblid: "ensembl_id",
		efoid: "efo_id",
		chemblid: "chembl_id",
		approvedsymbol: "approved_symbol",
		approvedname: "approved_name",
		geneticconstraint: "genetic_constraint",
		mechanismsofaction: "mechanisms_of_action",
		therapeuticareas: "therapeutic_areas",
	},
	entityIdFields: ["ensemblId", "efoId", "chemblId"],
	entityTypeInference: [
		{ fields: ["ensemblId"], entityType: "target" },
		{ fields: ["approvedSymbol"], entityType: "target" },
		{ fields: ["efoId"], entityType: "disease" },
		{ fields: ["chemblId"], entityType: "drug" },
	],
	wrapperKeys: ["nodes", "edges", "rows"],
	entityDetection: "standard",
};

// ---------------------------------------------------------------------------
// RCSB PDB
// ---------------------------------------------------------------------------

export const RCSB_PDB_CONFIG: DomainConfig = {
	name: "rcsb_pdb",
	columnNameMappings: {
		entrezid: "entrez_id",
		displayname: "display_name",
		pdbid: "pdb_id",
		chainid: "chain_id",
		entityid: "entity_id",
		assemblyid: "assembly_id",
		molecularweight: "molecular_weight",
		experimentalmethod: "experimental_method",
		resolutionangstrom: "resolution_angstrom",
		ncbitaxonomyid: "taxonomy_id",
		ncbiscientificname: "organism_name",
		pdbxseqonelettercode: "sequence",
		pdbxseqonelettercodecan: "amino_acid_sequence",
		rcsbid: "id",
		rcsbentityid: "entity_id",
	},
	entityIdFields: ["rcsb_id"],
	semanticMappings: {
		pdbx_seq_one_letter_code_can: "amino_acid_sequence",
		pdbx_seq_one_letter_code: "sequence",
		ncbi_scientific_name: "organism_name",
		ncbi_taxonomy_id: "taxonomy_id",
		rcsb_id: "id",
		rcsb_entity_id: "entity_id",
		formula_weight: "molecular_weight",
		exptl_method: "experimental_method",
		resolution_combined: "resolution",
		deposit_date: "deposition_date",
		release_date: "release_date",
		revision_date: "last_modified_date",
		struct_title: "title",
		struct_keywords: "keywords",
		__typename: "type",
		displayname: "display_name",
		createdat: "created_at",
		updatedat: "updated_at",
	},
	typeInferencePatterns: [
		{ pattern: "_id$", type: "INTEGER" },
		{ pattern: "^id$", type: "TEXT PRIMARY KEY" },
		{ pattern: "taxonomy_id", type: "INTEGER" },
		{ pattern: "entity_id", type: "TEXT" },
		{ pattern: "comp_id", type: "TEXT" },
		{ pattern: "weight", type: "REAL" },
		{ pattern: "resolution", type: "REAL" },
		{ pattern: "temperature", type: "REAL" },
		{ pattern: "ph", type: "REAL" },
		{ pattern: "length", type: "REAL" },
		{ pattern: "count", type: "INTEGER" },
		{ pattern: "number", type: "INTEGER" },
		{ pattern: "score", type: "REAL" },
		{ pattern: "percentage", type: "REAL" },
		{ pattern: "_date$", type: "TEXT" },
		{ pattern: "_time$", type: "TEXT" },
		{ pattern: "_at$", type: "TEXT" },
		{ pattern: "is_", type: "INTEGER" },
		{ pattern: "has_", type: "INTEGER" },
		{ pattern: "description", type: "TEXT" },
		{ pattern: "title", type: "TEXT" },
		{ pattern: "name", type: "TEXT" },
		{ pattern: "sequence", type: "TEXT" },
		{ pattern: "formula", type: "TEXT" },
		{ pattern: "smiles", type: "TEXT" },
		{ pattern: "url", type: "TEXT" },
	],
	singularizationExceptions: ["genus", "species", "series", "analysis", "basis", "axis"],
	wrapperKeys: ["nodes", "edges"],
	entityDetection: "aggressive",
};

// ---------------------------------------------------------------------------
// Config lookup by server name
// ---------------------------------------------------------------------------

const CONFIG_REGISTRY: Record<string, DomainConfig> = {
	civic: CIVIC_CONFIG,
	dgidb: DGIDB_CONFIG,
	opentargets: OPENTARGETS_CONFIG,
	rcsb_pdb: RCSB_PDB_CONFIG,
	"rcsb-pdb": RCSB_PDB_CONFIG,
};

/**
 * Look up a DomainConfig by server name.
 * Returns DEFAULT_CONFIG if no specific config is registered.
 */
export function getDomainConfigByName(serverName: string): DomainConfig {
	const normalized = serverName.toLowerCase().replace(/[^a-z0-9_-]/g, "");
	return CONFIG_REGISTRY[normalized] ?? DEFAULT_CONFIG;
}
