// Renders vision-input images inline in the operator's terminal via Kitty's
// graphics protocol (`kitty +kitten icat`), so the human standing in for the
// model actually sees what the client attached.
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function fetchImageBytes(url: string): Promise<Uint8Array> {
  if (url.startsWith("data:")) {
    const comma = url.indexOf(",");
    if (comma === -1) throw new Error("malformed data URI");
    const meta = url.slice(5, comma);
    const b64 = url.slice(comma + 1);
    return meta.includes("base64") ? Uint8Array.from(Buffer.from(b64, "base64")) : new TextEncoder().encode(decodeURIComponent(b64));
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch failed: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * Precondition: none — safe to call even without a Kitty-capable terminal or
 * network access.
 * Postcondition: on success, the image is written to Kitty's graphics
 * protocol on process.stdout; on any failure (bad URL, non-Kitty terminal,
 * missing `kitty` binary), a one-line fallback note is printed instead and
 * the promise still resolves.
 */
export async function renderImageInline(url: string): Promise<void> {
  try {
    const bytes = await fetchImageBytes(url);
    const dir = await mkdtemp(join(tmpdir(), "madeup-img-"));
    const file = join(dir, "image");
    await writeFile(file, bytes);
    await new Promise<void>((resolve) => {
      const proc = spawn("kitty", ["+kitten", "icat", "--align", "left", file], {
        stdio: ["ignore", "inherit", "inherit"],
      });
      proc.on("exit", () => resolve());
      proc.on("error", () => resolve());
    });
  } catch (err) {
    console.log(`[image could not be displayed: ${(err as Error).message}] ${url.slice(0, 80)}`);
  }
}

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
