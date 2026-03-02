// Unified tool registry
export { ToolRegistry, type ToolDefinition } from "./registry/registry";
export type { ToolEntry, ToolContext, SqlTaggedTemplate } from "./registry/types";

// Tool definitions
export { sqlTools } from "./tools/sql";
export { directQueryTools, DENIED_TABLES, REDACTED_COLUMNS } from "./tools/direct-query";
export { storeTools } from "./tools/store";

// SQL helpers
export { isReadOnly, isBlocked, executeSql } from "./tools/sql-helpers";

// Code Mode infrastructure
export { CodeModeProxy } from "./codemode/proxy";
export { createEvaluator } from "./codemode/evaluator";
export { generateTypes } from "./codemode/types";

// Code Mode response helpers
export {
	createCodeModeResponse,
	createCodeModeError,
	withCodeMode,
	ErrorCodes,
	type CodeModeResponse,
	type SuccessResponse,
	type ErrorResponse,
	type StructuredResponse,
	type ErrorCode,
} from "./codemode/response";

// Staging infrastructure
export { ChunkingEngine, type ChunkMetadata, type SqlExec } from "./staging/chunking";
export {
	detectArrays,
	inferSchema,
	materializeSchema,
	type SchemaHints,
	type InferredColumn,
	type InferredTable,
	type InferredSchema,
} from "./staging/schema-inference";
export { RestStagingDO } from "./staging/rest-staging-do";
export {
	shouldStage,
	generateDataAccessId,
	stageToDoAndRespond,
	queryDataFromDo,
	getSchemaFromDo,
	createQueryDataHandler,
	createGetSchemaHandler,
} from "./staging/utils";

// HTTP utilities
export { restFetch, buildQueryString, type RestFetchOptions } from "./http/rest-fetch";
