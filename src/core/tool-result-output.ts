/** Native tool attachments share one display path during a turn and after reload. */
export interface ToolResultImage {
	data: string;
	mimeType: string;
}

const RASTER_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp"]);

/** Keep executable documents and malformed data out of image sources. */
export function toolResultImages(value: unknown): ToolResultImage[] {
	if (!Array.isArray(value)) return [];
	return value.filter((image): image is ToolResultImage => {
		if (image === null || typeof image !== "object") return false;
		const { data, mimeType } = image as Partial<ToolResultImage>;
		return typeof mimeType === "string" && RASTER_MIME_TYPES.has(mimeType)
			&& typeof data === "string" && data.length > 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(data);
	});
}

/** Tool details remain unchanged unless native content contains displayable images.
 * Read results in older records have null details, but retain the image bytes. */
export function toolResultDisplayOutput(result: {
	content?: readonly { type?: string; text?: string; data?: string; mimeType?: string }[];
	details?: unknown;
} | null | undefined, toolName: string): unknown {
	if (toolName !== "read") return result?.details;
	const images = toolResultImages(result?.content?.filter((part) => part.type === "image"));
	if (images.length === 0) return result?.details;
	return {
		text: result?.content?.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n") ?? "",
		images,
		details: result?.details,
	};
}
