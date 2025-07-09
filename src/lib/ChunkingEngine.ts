// src/lib/ChunkingEngine.ts

export interface ChunkMetadata {
	contentId: string;
	totalChunks: number;
	originalSize: number;
}

export class ChunkingEngine {
	private readonly CHUNK_SIZE_THRESHOLD = 32 * 1024; // 32KB
	private readonly CHUNK_SIZE = 16 * 1024; // 16KB

	public shouldChunk(content: string): boolean {
		return content.length > this.CHUNK_SIZE_THRESHOLD;
	}

	public async storeChunkedContent(content: string, sql: any): Promise<ChunkMetadata> {
		const contentId = 'chunk_' + crypto.randomUUID();
		await this.ensureChunksTable(sql);

		const chunks = [];
		for (let i = 0; i < content.length; i += this.CHUNK_SIZE) {
			chunks.push(content.slice(i, i + this.CHUNK_SIZE));
		}

		for (let i = 0; i < chunks.length; i++) {
			sql.exec(
				`INSERT INTO content_chunks (content_id, chunk_index, chunk_data) VALUES (?, ?, ?)`,
				contentId, i, chunks[i]
			);
		}

		const metadata = { contentId, totalChunks: chunks.length, originalSize: content.length };
		sql.exec(
			`INSERT INTO chunk_metadata (content_id, total_chunks, original_size) VALUES (?, ?, ?)`,
			metadata.contentId, metadata.totalChunks, metadata.originalSize
		);
		return metadata;
	}

	public async retrieveChunkedContent(contentId: string, sql: any): Promise<string | null> {
		const result = sql.exec(
			`SELECT chunk_data FROM content_chunks WHERE content_id = ? ORDER BY chunk_index ASC`,
			contentId
		).toArray();
		return result.length > 0 ? result.map((row: any) => row.chunk_data).join('') : null;
	}

	public createContentReference(metadata: ChunkMetadata): string {
		return `__CHUNKED__:${metadata.contentId}`;
	}

	public isContentReference(value: any): boolean {
		return typeof value === 'string' && value.startsWith('__CHUNKED__:');
	}

	public extractContentId(reference: string): string {
		return reference.substring(12);
	}

	public async smartJsonStringify(obj: any, sql: any): Promise<string> {
		const jsonString = JSON.stringify(obj);
		if (!this.shouldChunk(jsonString)) {
			return jsonString;
		}
		const metadata = await this.storeChunkedContent(jsonString, sql);
		return this.createContentReference(metadata);
	}

	private async ensureChunksTable(sql: any): Promise<void> {
		sql.exec(`
			CREATE TABLE IF NOT EXISTS content_chunks (
				id INTEGER PRIMARY KEY, content_id TEXT NOT NULL, chunk_index INTEGER NOT NULL, chunk_data TEXT NOT NULL,
				UNIQUE(content_id, chunk_index)
			)
		`);
		sql.exec(`CREATE TABLE IF NOT EXISTS chunk_metadata (content_id TEXT PRIMARY KEY, total_chunks INTEGER, original_size INTEGER)`);
	}
} 