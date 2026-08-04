// Extracts vision-input image references from request content so the panel
// can render them with a plain `<img>` tag — the browser does the fetching
// and decoding, no server-side terminal graphics protocol needed.

interface ContentPart {
  type?: string;
  image_url?: string | { url?: string };
  file_id?: string;
}

// Pulls every image reference out of a Chat Completions `content` array
// (type: "image_url") or a Responses API `content` array (type: "input_image").
export function extractImageUrls(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const urls: string[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== "object") continue;
    const part = raw as ContentPart;
    if (part.type !== "image_url" && part.type !== "input_image") continue;
    const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
    if (typeof url === "string" && url.length > 0) urls.push(url);
  }
  return urls;
}
