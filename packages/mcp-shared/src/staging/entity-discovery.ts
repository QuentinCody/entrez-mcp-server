/**
 * Entity Discovery — detects entities in JSON data, infers their types,
 * and records parent→child relationships.
 *
 * This is the SINGLE SOURCE OF TRUTH for `isEntity()` and `inferEntityType()`.
 * Both schema-builder and data-inserter import from here, eliminating the
 * bug class where the two engines disagree on entity types.
 */

import type { DomainConfig } from "./types";
import { sanitizeTableName, singularize } from "./normalizer";

// ---------------------------------------------------------------------------
// Discovery result
// ---------------------------------------------------------------------------

export interface DiscoveryResult {
	/** entityType → array of entity objects */
	entities: Map<string, unknown[]>;
	/** fromTable → Set<toTable> (many-to-many relationships only) */
	relationships: Map<string, Set<string>>;
}

// ---------------------------------------------------------------------------
// isEntity — determine whether an object is an entity worth normalizing
// ---------------------------------------------------------------------------

export function isEntity(obj: unknown, config?: DomainConfig): boolean {
	if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;

	const record = obj as Record<string, unknown>;
	const keys = Object.keys(record);
	const fieldCount = keys.length;

	const mode = config?.entityDetection ?? "standard";

	// Check for standard ID fields
	const hasId =
		record.id !== undefined ||
		record._id !== undefined;

	// Check for extra domain-specific ID fields
	const hasExtraId = config?.entityIdFields?.some(
		(f) => record[f] !== undefined,
	) ?? false;

	if (mode === "strict") {
		return hasId || hasExtraId;
	}

	if (hasId || hasExtraId) return true;

	// Check common entity marker fields
	const hasEntityFields =
		record.name !== undefined ||
		record.title !== undefined ||
		record.description !== undefined ||
		record.type !== undefined;

	if (mode === "standard") {
		return fieldCount >= 2 && hasEntityFields;
	}

	if (mode === "loose") {
		// DGIdb pattern: any object with 2+ fields where at least one is scalar
		if (fieldCount < 2) return false;
		if (hasEntityFields) return true;
		return keys.some((key) => {
			const value = record[key];
			return value !== null && value !== undefined && typeof value !== "object";
		});
	}

	if (mode === "aggressive") {
		// RCSB-PDB pattern
		if (record.rcsb_id !== undefined) return true;
		if (fieldCount >= 3) {
			const hasIndicators = keys.some((key) =>
				["name", "title", "description", "type", "formula", "sequence", "value"].includes(
					key.toLowerCase(),
				),
			);
			if (hasIndicators) return true;
		}
		if (fieldCount >= 2) {
			return keys.some((key) => {
				const value = record[key];
				return value !== null && typeof value !== "object";
			});
		}
		return false;
	}

	return false;
}

// ---------------------------------------------------------------------------
// inferEntityType — determine the table name for an entity object
// ---------------------------------------------------------------------------

export function inferEntityType(
	obj: unknown,
	path: string[],
	config?: DomainConfig,
): string {
	const record = obj as Record<string, unknown>;

	// 1. __typename always wins
	if (record.__typename && typeof record.__typename === "string") {
		return sanitizeTableName(record.__typename);
	}

	// 2. type field (if not a GraphQL wrapper name)
	if (
		record.type &&
		typeof record.type === "string" &&
		!isWrapperFieldName(record.type as string)
	) {
		return sanitizeTableName(record.type as string);
	}

	// 3. Domain-specific entity type inference
	if (config?.entityTypeInference) {
		for (const rule of config.entityTypeInference) {
			if (rule.fields.every((f) => record[f] !== undefined)) {
				return rule.entityType;
			}
		}
	}

	// 4. Infer from path context
	if (path.length > 0) {
		let lastName = path[path.length - 1];

		// Skip GraphQL wrapper names
		if ((lastName === "node" || lastName === "nodes") && path.length > 1) {
			lastName = path[path.length - 2];
			if (lastName === "edges" && path.length > 2) {
				lastName = path[path.length - 3];
			}
		} else if (lastName === "edges" && path.length > 1) {
			lastName = path[path.length - 2];
		} else if (lastName === "rows" && path.length > 1) {
			lastName = path[path.length - 2];
		}

		return singularize(lastName, config);
	}

	// 5. Fallback
	return inferDeterministicFallbackEntityType(record, path);
}

// ---------------------------------------------------------------------------
// discoverEntities — walk a JSON tree and collect entities + relationships
// ---------------------------------------------------------------------------

export function discoverEntities(
	data: unknown,
	config?: DomainConfig,
): DiscoveryResult {
	const entities = new Map<string, unknown[]>();
	const relationships = new Map<string, Set<string>>();

	walkAndDiscover(data, [], undefined, entities, relationships, config);

	return { entities, relationships };
}

// ---------------------------------------------------------------------------
// Internal recursive walker
// ---------------------------------------------------------------------------

function walkAndDiscover(
	obj: unknown,
	path: string[],
	parentEntityType: string | undefined,
	entities: Map<string, unknown[]>,
	relationships: Map<string, Set<string>>,
	config?: DomainConfig,
): void {
	if (!obj || typeof obj !== "object") return;

	// Handle arrays
	if (Array.isArray(obj)) {
		if (obj.length === 0) return;

		let arrayEntityType: string | null = null;

		for (const item of obj) {
			if (isEntity(item, config)) {
				if (!arrayEntityType) {
					arrayEntityType = inferEntityType(item, path, config);
				}

				addEntity(entities, arrayEntityType, item);

				// Record parent → child relationship
				if (parentEntityType && path.length > 0) {
					const fieldName = path[path.length - 1];
					if (!isWrapperFieldName(fieldName)) {
						recordRelationship(relationships, parentEntityType, arrayEntityType);
					}
				}

				processEntityProperties(item, arrayEntityType, entities, relationships, config);
			}
		}
		return;
	}

	const record = obj as Record<string, unknown>;

	// Unwrap GraphQL edges pattern
	if (record.edges && Array.isArray(record.edges)) {
		const nodes = (record.edges as Array<Record<string, unknown>>)
			.map((edge) => edge.node)
			.filter(Boolean);
		if (nodes.length > 0) {
			walkAndDiscover(nodes, path, parentEntityType, entities, relationships, config);
		}
		return;
	}

	// Unwrap {nodes: [...]} pattern (if not itself an entity)
	if (record.nodes && Array.isArray(record.nodes) && !isEntity(obj, config)) {
		walkAndDiscover(record.nodes, path, parentEntityType, entities, relationships, config);
		return;
	}

	// Unwrap {rows: [...]} pattern (Open Targets)
	if (record.rows && Array.isArray(record.rows) && !isEntity(obj, config)) {
		walkAndDiscover(record.rows, path, parentEntityType, entities, relationships, config);
		return;
	}

	// Process individual entity
	if (isEntity(obj, config)) {
		const entityType = inferEntityType(obj, path, config);
		addEntity(entities, entityType, obj);
		processEntityProperties(obj, entityType, entities, relationships, config);
		return;
	}

	// For non-entity objects, explore children
	for (const [key, value] of Object.entries(record)) {
		walkAndDiscover(value, [...path, key], parentEntityType, entities, relationships, config);
	}
}

// ---------------------------------------------------------------------------
// processEntityProperties — scan an entity's fields for nested relationships
// ---------------------------------------------------------------------------

function processEntityProperties(
	entity: unknown,
	entityType: string,
	entities: Map<string, unknown[]>,
	relationships: Map<string, Set<string>>,
	config?: DomainConfig,
): void {
	const record = entity as Record<string, unknown>;

	for (const [key, value] of Object.entries(record)) {
		// Unwrap wrapper objects: {nodes: [...]}, {edges: [{node:}]}, {rows: [...]}
		let items: unknown[] | null = null;

		if (Array.isArray(value) && value.length > 0) {
			items = value;
		} else if (value && typeof value === "object" && !Array.isArray(value)) {
			const wrapper = value as Record<string, unknown>;
			if (wrapper.nodes && Array.isArray(wrapper.nodes)) {
				items = wrapper.nodes;
			} else if (wrapper.edges && Array.isArray(wrapper.edges)) {
				items = (wrapper.edges as Array<Record<string, unknown>>)
					.map((e) => e.node)
					.filter(Boolean);
			} else if (wrapper.rows && Array.isArray(wrapper.rows)) {
				items = wrapper.rows;
			}
		}

		if (items && items.length > 0) {
			const firstEntity = items.find((item) => isEntity(item, config));
			if (firstEntity) {
				const relatedType = inferEntityType(firstEntity, [key], config);
				recordRelationship(relationships, entityType, relatedType);

				for (const item of items) {
					if (isEntity(item, config)) {
						addEntity(entities, relatedType, item);
						processEntityProperties(item, relatedType, entities, relationships, config);
					}
				}
			}
		} else if (
			value &&
			typeof value === "object" &&
			!Array.isArray(value) &&
			isEntity(value, config)
		) {
			// 1:1 relationships → direct FK column, no junction table.
			const relatedType = inferEntityType(value, [key], config);
			addEntity(entities, relatedType, value);
			processEntityProperties(value, relatedType, entities, relationships, config);
		} else if (
			value &&
			typeof value === "object" &&
			!Array.isArray(value) &&
			!isEntity(value, config)
		) {
			// Non-entity wrapper — explore for nested entities
			processEntityProperties(value, entityType, entities, relationships, config);
		}
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function addEntity(
	entities: Map<string, unknown[]>,
	entityType: string,
	entity: unknown,
): void {
	const list = entities.get(entityType) ?? [];
	list.push(entity);
	entities.set(entityType, list);
}

function recordRelationship(
	relationships: Map<string, Set<string>>,
	fromTable: string,
	toTable: string,
): void {
	if (fromTable === toTable) return;

	const fromSet = relationships.get(fromTable) ?? new Set();
	const toSet = relationships.get(toTable) ?? new Set();

	// Only record in one direction to avoid duplicates
	if (!fromSet.has(toTable) && !toSet.has(fromTable)) {
		fromSet.add(toTable);
		relationships.set(fromTable, fromSet);
	}
}

function isWrapperFieldName(name: string): boolean {
	return ["nodes", "edges", "node", "data", "items", "results", "rows"].includes(
		name.toLowerCase(),
	);
}

function inferDeterministicFallbackEntityType(
	record: Record<string, unknown>,
	path: string[],
): string {
	const pathSignature = path.length > 0 ? path.join(".") : "root";
	const fieldSignature = Object.keys(record)
		.sort()
		.map((key) => `${key}:${valueSignature(record[key])}`)
		.join("|");
	const hash = stableHash(`${pathSignature}|${fieldSignature}`);
	return sanitizeTableName(`entity_${hash}`);
}

function valueSignature(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) {
		if (value.length === 0) return "array:empty";
		return `array:${valueSignature(value[0])}`;
	}
	if (typeof value === "object") return "object";
	if (typeof value === "number") {
		return Number.isInteger(value) ? "integer" : "number";
	}
	return typeof value;
}

function stableHash(input: string): string {
	let hash = 2166136261;
	for (let i = 0; i < input.length; i++) {
		hash ^= input.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0).toString(36);
}
