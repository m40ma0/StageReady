import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MetaImageAdapter, createAi } from "../src";

const logger = pino({ level: "silent" });
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const adapter = () => new MetaImageAdapter({ baseUrl: "https://api.meta.ai/v1/", apiKey: "k", model: "muse-image-1.0" }, logger);

afterEach(() => vi.unstubAllGlobals());

describe("Muse Image", () => {
  it("posts model, prompt, n, PNG output and a 16:9 size to /images/generations and decodes b64_json", async () => {
    const fetchMock = vi.fn(async () => Response.json({ data: [{ b64_json: PNG.toString("base64") }] }));
    vi.stubGlobal("fetch", fetchMock);
    const bytes = await adapter().generate({ prompt: "an abstract stage background" });
    expect(Buffer.from(bytes).equals(PNG)).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.meta.ai/v1/images/generations");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer k");
    // PNG, not the API's default WebP, which the slide renderer cannot decode.
    expect(JSON.parse(String(init.body))).toEqual({ model: "muse-image-1.0", prompt: "an abstract stage background", n: 1, output_format: "png", size: "1920x1080" });
  });

  it("downloads the image when the response carries a URL", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ data: [{ url: "https://cdn.example.test/img.png" }] }))
      .mockResolvedValueOnce(new Response(PNG));
    vi.stubGlobal("fetch", fetchMock);
    expect(Buffer.from(await adapter().generate({ prompt: "x" })).equals(PNG)).toBe(true);
    expect((fetchMock.mock.calls[1] as unknown as [string])[0]).toBe("https://cdn.example.test/img.png");
  });

  it("fails with a typed error on an empty or failed response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ data: [] })),
    );
    await expect(adapter().generate({ prompt: "x" })).rejects.toMatchObject({ code: "parse_failed" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 403 })),
    );
    await expect(adapter().generate({ prompt: "x" })).rejects.toMatchObject({ code: "http_error" });
  });

  it("is configured from MODEL_IMAGE and is off in mock mode", () => {
    const base = { META_RESPONSE_FORMAT: "json_object" as const, MODEL_MOCK: false };
    expect(createAi({ ...base, MODEL_API_KEY: "k", META_API_BASE_URL: "https://api.meta.ai/v1", MODEL_SPARK: "muse-spark-1.3", MODEL_IMAGE: "muse-image-1.0" }, logger).image?.modelId).toBe(
      "muse-image-1.0",
    );
    expect(createAi({ ...base, MODEL_API_KEY: "k", META_API_BASE_URL: "https://api.meta.ai/v1", MODEL_SPARK: "muse-spark-1.3" }, logger).image).toBeNull();
    expect(createAi(base, logger).image).toBeNull();
  });
});
