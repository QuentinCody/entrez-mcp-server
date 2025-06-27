export const BASE_EUTILS_URL = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/";
export const DEFAULT_EMAIL = "entrez-mcp-server@example.com";
export const DEFAULT_TOOL = "entrez-mcp-server";

// Valid databases list sourced from current EInfo endpoint (2025-06)
export const VALID_DATABASES = [
	"pubmed",
	"pmc",
	"protein",
	"nuccore",
	"ipg",
	"nucleotide",
	"structure",
	"genome",
	"annotinfo",
	"assembly",
	"bioproject",
	"biosample",
	"blastdbinfo",
	"books",
	"cdd",
	"clinvar",
	"gap",
	"gapplus",
	"grasp",
	"dbvar",
	"gene",
	"gds",
	"geoprofiles",
	"medgen",
	"mesh",
	"nlmcatalog",
	"omim",
	"orgtrack",
	"proteinclusters",
	"pcassay",
	"protfam",
	"pccompound",
	"pcsubstance",
	"seqannot",
	"snp",
	"sra",
	"taxonomy",
	"biocollections",
	"gtr",
	// Additional databases observed via EInfo but previously missing
	"pubmedhealth",
	"nucgss",
	"nucest",
	"biosystems",
	"unigene",
	"popset",
	"probe",
];

export const SERVER_CONFIG = {
	name: "Complete NCBI APIs MCP Server",
	version: "1.0.0",
};
