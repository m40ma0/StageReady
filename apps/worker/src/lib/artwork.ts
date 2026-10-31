import { createHash } from "node:crypto";
import type { Ai } from "@stage-ready/ai";
import type { JobContext } from "./context";

export interface Artwork {
  /** The storage key the image lives under (includes the prompt hash). */
  key: string;
  bytes: Uint8Array;
  mime: "image/png" | "image/jpeg";
  /** The Muse Image model that painted it, for the on-slide caption. */
  modelId: string;
}

const mimeOf = (bytes: Uint8Array) => (bytes[0] === 0x89 ? "image/png" : "image/jpeg");

/**
 * One Muse Image background, generated once and cached in storage under `baseKey` plus a hash of the prompt and model. Demo Mode projects share
 * one key, since their fixtures are identical: every guest sees generated art for one image's cost.
 * Null when there is no image model, or the call fails (callers fall back to plain backgrounds).
 */
export async function cachedArtwork(ctx: JobContext, ai: Ai, baseKey: string, prompt: string): Promise<Artwork | null> {
  if (!ai.image) return null;
  const modelId = ai.image.modelId;
  const key = artworkKey(baseKey, prompt, modelId);
  const cached = await ctx.storage.getJson<{ modelId: string }>(`${key}.json`);
  if (cached) {
    const bytes = await ctx.storage.get(ctx.storage.uri(key));
    if (bytes?.length) return { key, bytes, mime: mimeOf(bytes), modelId: cached.modelId };
  }
  try {
    const bytes = await ai.image.generate({ prompt });
    await ctx.storage.put(key, bytes, mimeOf(bytes));
    await ctx.storage.putJson(`${key}.json`, { modelId, createdAt: new Date().toISOString() });
    return { key, bytes, mime: mimeOf(bytes), modelId };
  } catch (error) {
    ctx.logger.warn({ err: error, key }, "Muse Image artwork failed; using a plain background");
    return null;
  }
}

/** The cache key for one prompt and model: changing either (a new prompt, a new model) paints a new image. */
export const artworkKey = (baseKey: string, prompt: string, modelId: string) => `${baseKey}-${createHash("sha1").update(`${modelId}\n${prompt}`).digest("hex").slice(0, 8)}`;

/** "muse-image-1.0" → "Muse Image 1.0" for captions. */
export const modelName = (id: string) =>
  id
    .split("-")
    .map((p) => (/^\d/.test(p) ? p : p[0]!.toUpperCase() + p.slice(1)))
    .join(" ");
