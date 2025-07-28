import { ToolContext } from "./base.js";
import { ApiKeyStatusTool } from "./api-key-status.js";
import { EInfoTool } from "./einfo.js";
import { ESearchTool } from "./esearch.js";
import { ESummaryTool } from "./esummary.js";
import { EFetchAndStageTool, QueryStagedDataTool, GetStagedSchemaTool } from "./staging.js";
import { ELinkTool, EPostTool, EGQueryTool, ESpellTool } from "./eutils.js";
import { BlastSubmitTool, BlastGetTool } from "./blast.js";
import { PubChemCompoundTool, PubChemSubstanceTool, PubChemBioAssayTool, PubChemStructureSearchTool } from "./pubchem.js";
import { PMCIdConverterTool, PMCOpenAccessServiceTool, PMCCitationExporterTool } from "./pmc.js";

export class ToolRegistry {
	private tools: any[] = [];

	constructor(context: ToolContext) {
		// Register all tools
		this.tools = [
			// Core API status tools
			new ApiKeyStatusTool(context),
			
			// Basic E-utilities
			new EInfoTool(context),
			new ESearchTool(context),
			new ESummaryTool(context),
			
			// Data staging tools
			new EFetchAndStageTool(context),
			new QueryStagedDataTool(context),
			new GetStagedSchemaTool(context),
			
			// Advanced E-utilities
			new ELinkTool(context),
			new EPostTool(context),
			new EGQueryTool(context),
			new ESpellTool(context),
			
			// BLAST tools
			new BlastSubmitTool(context),
			new BlastGetTool(context),
			
			// PubChem tools
			new PubChemCompoundTool(context),
			new PubChemSubstanceTool(context),
			new PubChemBioAssayTool(context),
			new PubChemStructureSearchTool(context),
			
			// PMC tools
			new PMCIdConverterTool(context),
			new PMCOpenAccessServiceTool(context),
			new PMCCitationExporterTool(context),
		];
	}

	registerAll(): void {
		this.tools.forEach(tool => tool.register());
	}
}

// Export types and tool classes for individual use if needed
export type { ToolContext };
export {
	ApiKeyStatusTool,
	EInfoTool,
	ESearchTool,
	ESummaryTool,
	EFetchAndStageTool,
	QueryStagedDataTool,
	GetStagedSchemaTool,
	ELinkTool,
	EPostTool,
	EGQueryTool,
	ESpellTool,
	BlastSubmitTool,
	BlastGetTool,
	PubChemCompoundTool,
	PubChemSubstanceTool,
	PubChemBioAssayTool,
	PubChemStructureSearchTool,
	PMCIdConverterTool,
	PMCOpenAccessServiceTool,
	PMCCitationExporterTool,
};
