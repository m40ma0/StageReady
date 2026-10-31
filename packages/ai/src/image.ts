import type { Logger } from "pino";
import { AiError, type ImageGen } from "./types";

// Muse Image over the Meta Model API's OpenAI-compatible POST {base}/images/generations.
// The response carries each image as base64 (b64_json) or as a URL to download. output_format defaults to
// webp (dev.meta.ai/docs/api-reference/images/schemas), so every request asks for png.

interface ImagesResponse {
  data?: { b64_json?: string; url?: string }[];
}

export class MetaImageAdapter implements ImageGen {
  constructor(
    private readonly config: { baseUrl: string; apiKey: string; model: string; timeoutMs?: number },
    private readonly logger: Logger,
  ) {}

  get modelId() {
    return this.config.model;
  }

  async generate(input: { prompt: string }, options: { signal?: AbortSignal } = {}): Promise<Uint8Array> {
    const timeout = AbortSignal.timeout(this.config.timeoutMs ?? 180_000);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    const started = performance.now();
    let response: Response;
    try {
      response = await fetch(`${this.config.baseUrl.replace(/\/+$/, "")}/images/generations`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.config.apiKey}` },
        // PNG, not the API's default WebP: the slide renderer (resvg) cannot decode WebP. The size sets a 16:9 aspect.
        body: JSON.stringify({ model: this.config.model, prompt: input.prompt, n: 1, output_format: "png", size: "1920x1080" }),
        signal,
      });
    } catch (error) {
      if (timeout.aborted) throw new AiError("timeout", `Image model ${this.config.model} did not answer in time.`);
      throw new AiError("unavailable", `Could not reach the Meta Model API: ${(error as Error).message}`);
    }
    if (!response.ok) throw new AiError("http_error", `Meta Model API returned ${response.status} for image model ${this.config.model}.`, (await response.text()).slice(0, 500));
    const first = ((await response.json()) as ImagesResponse).data?.[0];
    let bytes: Uint8Array;
    if (first?.b64_json) bytes = Uint8Array.from(Buffer.from(first.b64_json, "base64"));
    else if (first?.url) {
      const image = await fetch(first.url, { signal });
      if (!image.ok) throw new AiError("http_error", `Could not download the generated image (${image.status}).`);
      bytes = new Uint8Array(await image.arrayBuffer());
    } else throw new AiError("parse_failed", "The image response had no image.");
    this.logger.info({ modelId: this.config.model, latencyMs: Math.round(performance.now() - started), bytes: bytes.length }, "image generated");
    return bytes;
  }
}
