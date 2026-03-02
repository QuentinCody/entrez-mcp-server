/**
 * Chunking engine for storing large content in SQLite-backed Durable Objects.
 *
 * Splits large JSON/text content into 16KB chunks stored in SQLite tables,
 * returning a compact reference string instead of the raw content.
 */

export interface ChunkMetadata {
	contentId: string;
	totalChunks: number;
	originalSize: number;
	contentType: "json" | "text";
	compressed: boolean;
}

export interface SqlExec {
	exec: (
		query: string,
		...bindings: unknown[]
	) => {
		toArray(): Array<Record<string, unknown>>;
		one?: () => Record<string, unknown> | undefined;
	};
}

export class ChunkingEngine {
	private readonly CHUNK_SIZE_THRESHOLD = 32 * 1024; // 32KB
	private readonly CHUNK_SIZE = 16 * 1024; // 16KB

	shouldChunk(content: string): boolean {
		return content.length > this.CHUNK_SIZE_THRESHOLD;
	}

	isContentReference(value: unknown): boolean {
		return typeof value === "string" && value.startsWith("__CHUNKED__:");
	}

	extractContentId(reference: string): string {
		return reference.replace("__CHUNKED__:", "");
	}

	createContentReference(metadata: ChunkMetadata): string {
		return `__CHUNKED__:${metadata.contentId}`;
	}

	async smartJsonStringify(obj: unknown, sql: SqlExec): Promise<string> {
		const json = JSON.stringify(obj);
		if (!this.shouldChunk(json)) return json;
		const meta = await this.storeChunkedContent(json, "json", sql);
		return this.createContentReference(meta);
	}

	async smartJsonParse(value: string, sql: SqlExec): Promise<unknown> {
		if (!this.isContentReference(value)) return JSON.parse(value);
		const id = this.extractContentId(value);
		const content = await this.retrieveChunkedContent(id, sql);
		if (content == null) throw new Error(`Missing chunked content ${id}`);
		return JSON.parse(content);
	}

	private generateContentId(): string {
		return `chunk_${crypto.randomUUID().replace(/-/g, "")}`;
	}

	private splitIntoChunks(content: string): string[] {
		const chunks: string[] = [];
		for (let i = 0; i < content.length; i += this.CHUNK_SIZE) {
			chunks.push(content.slice(i, i + this.CHUNK_SIZE));
		}
		return chunks;
	}

	private ensureTables(sql: SqlExec) {
		sql.exec(`
			CREATE TABLE IF NOT EXISTS content_chunks (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				content_id TEXT NOT NULL,
				chunk_index INTEGER NOT NULL,
				chunk_data TEXT NOT NULL,
				chunk_size INTEGER NOT NULL,
				created_at TEXT DEFAULT CURRENT_TIMESTAMP,
				UNIQUE(content_id, chunk_index)
			);
		`);
		sql.exec(`
			CREATE TABLE IF NOT EXISTS chunk_metadata (
				content_id TEXT PRIMARY KEY,
				total_chunks INTEGER NOT NULL,
				original_size INTEGER NOT NULL,
				content_type TEXT NOT NULL,
				compressed INTEGER DEFAULT 0,
				encoding TEXT,
				created_at TEXT DEFAULT CURRENT_TIMESTAMP
			);
		`);
		sql.exec(
			`CREATE INDEX IF NOT EXISTS idx_chunks_lookup ON content_chunks(content_id, chunk_index);`,
		);
	}

	async storeChunkedContent(
		content: string,
		contentType: "json" | "text",
		sql: SqlExec,
	): Promise<ChunkMetadata> {
		const contentId = this.generateContentId();
		this.ensureTables(sql);
		const parts = this.splitIntoChunks(content);
		for (let i = 0; i < parts.length; i++) {
			sql.exec(
				`INSERT INTO content_chunks (content_id, chunk_index, chunk_data, chunk_size) VALUES (?, ?, ?, ?)`,
				contentId,
				i,
				parts[i],
				parts[i].length,
			);
		}
		const meta: ChunkMetadata = {
			contentId,
			totalChunks: parts.length,
			originalSize: content.length,
			contentType,
			compressed: false,
		};
		sql.exec(
			`INSERT INTO chunk_metadata (content_id, total_chunks, original_size, content_type, compressed) VALUES (?, ?, ?, ?, 0)`,
			meta.contentId,
			meta.totalChunks,
			meta.originalSize,
			meta.contentType,
		);
		return meta;
	}

	async retrieveChunkedContent(
		contentId: string,
		sql: SqlExec,
	): Promise<string | null> {
		const rows = sql
			.exec(
				`SELECT chunk_data FROM content_chunks WHERE content_id = ? ORDER BY chunk_index ASC`,
				contentId,
			)
			.toArray();
		if (!rows || rows.length === 0) return null;
		return rows.map((r) => String(r.chunk_data)).join("");
	}
}
