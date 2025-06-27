import JSZip from "jszip";
import {
	VALID_DATABASES,
	BASE_EUTILS_URL,
	DEFAULT_EMAIL,
	DEFAULT_TOOL,
} from "../constants";

// Helper method to validate database names
export function isValidDatabase(db: string): boolean {
	return VALID_DATABASES.includes(db.toLowerCase());
}

// Helper method to parse and validate response
export async function parseResponse(
	response: Response,
	toolName: string,
): Promise<string> {
	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(
			`${toolName} request failed: ${response.status} ${response.statusText}. Response: ${errorText}`,
		);
	}

	// For BLAST results, check if the response is compressed
	if (toolName.includes("BLAST Get")) {
		const contentType = response.headers.get("content-type") || "";
		const contentEncoding = response.headers.get("content-encoding") || "";

		// If it's a ZIP file or compressed content, try to extract readable data
		if (
			contentType.includes("application/zip") ||
			contentType.includes("application/x-zip") ||
			response.headers.get("content-disposition")?.includes(".zip") ||
			contentEncoding.includes("gzip") ||
			contentEncoding.includes("deflate")
		) {
			const arrayBuffer = await response.arrayBuffer();

			// Handle gzip/deflate first
			if (contentEncoding === "gzip" || contentEncoding === "deflate") {
				const decompressionStream = new DecompressionStream(contentEncoding);
				const decompressedStream = new Response(arrayBuffer).body!.pipeThrough(
					decompressionStream,
				);
				return await new Response(decompressedStream).text();
			}

			// Check for ZIP file signature ('PK') and handle it
			const firstBytes = new Uint8Array(arrayBuffer.slice(0, 4));
			if (firstBytes[0] === 0x50 && firstBytes[1] === 0x4b) {
				// ZIP file signature
				try {
					const zip = await JSZip.loadAsync(arrayBuffer);
					const fileNames = Object.keys(zip.files);
					if (fileNames.length > 0) {
						// Find the primary XML file, often with an XInclude
						const primaryXmlFile = fileNames.find(
							(name) => name.endsWith(".xml") && !name.includes("_"),
						);
						const primaryFile = primaryXmlFile
							? zip.file(primaryXmlFile)
							: zip.file(fileNames[0]);

						if (primaryFile) {
							const primaryContent = await primaryFile.async("string");

							// Check for XInclude and resolve it
							const includeMatch = primaryContent.match(
								/<xi:include\s+href="([^"]+)"/,
							);
							if (includeMatch && includeMatch[1]) {
								const includedFileName = includeMatch[1];
								const includedFile = zip.file(includedFileName);
								if (includedFile) {
									return await includedFile.async("string"); // Return the content of the included file
								} else {
									throw new Error(
										`XInclude file '${includedFileName}' not found in the BLAST archive.`,
									);
								}
							}

							return primaryContent; // Return primary content if no include found
						}
					}
					throw new Error("ZIP archive from BLAST was empty.");
				} catch (zipError) {
					throw new Error(
						`Failed to decompress BLAST result archive: ${zipError instanceof Error ? zipError.message : String(zipError)}`,
					);
				}
			}
		}
	}

	const data = await response.text();

	// Skip error checking for BLAST and PMC tools as they have different response formats
	if (
		toolName.includes("BLAST") ||
		toolName.includes("PMC") ||
		toolName.includes("PubChem")
	) {
		return data;
	}

	// Check for common NCBI error patterns (only for E-utilities tools). Perform case-insensitive scan.
	const lowerData = data.toLowerCase();
	if (
		lowerData.includes("<error>") ||
		lowerData.includes('"error"') ||
		lowerData.includes("error")
	) {
		// Capture NCBI error messages accurately
		const errorMatch =
			// Match XML error tags like <Error> or <ERROR>
			data.match(/<Error[^>]*>([\s\S]*?)<\/Error>/i) ||
			data.match(/<ERROR[^>]*>([\s\S]*?)<\/ERROR>/i) ||
			// Match JSON style "ERROR":"message"
			data.match(/"ERROR"\s*:\s*"([^"]*)"/i) ||
			// Generic 'error' text in plain responses
			data.match(/error['":]?\s*([^"',}\n]*)/i);
		if (errorMatch) {
			throw new Error(`NCBI ${toolName} error: ${errorMatch[1]}`);
		}
	}

	return data;
}

// Helper method to build URL with validation
export function buildUrl(
	endpoint: string,
	params: URLSearchParams,
	apiKey?: string,
): string {
	// Remove empty parameters
	const cleanParams = new URLSearchParams();
	params.forEach((value, key) => {
		if (value && value.trim() !== "") {
			cleanParams.append(key, value.trim());
		}
	});
	// Automatically attach API key if available
	if (apiKey) {
		cleanParams.append("api_key", apiKey);
	}
	return `${BASE_EUTILS_URL}${endpoint}?${cleanParams}`;
}

// Common parameter builder for default tool and email
export function createBaseParams(retmode?: string): URLSearchParams {
	const params = new URLSearchParams({
		tool: DEFAULT_TOOL,
		email: DEFAULT_EMAIL,
	});
	if (retmode) {
		params.append("retmode", retmode);
	}
	return params;
}
