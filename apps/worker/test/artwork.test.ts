import { describe, expect, it } from "vitest";
import { artworkKey } from "../src/lib/artwork";

describe("artworkKey", () => {
  it("changes with the prompt or the model, so a new prompt is never served the old cached image", () => {
    const a = artworkKey("demo/slides/muse-background", "very dark navy", "muse-image-1.0");
    expect(a).toMatch(/^demo\/slides\/muse-background-[0-9a-f]{8}$/);
    expect(artworkKey("demo/slides/muse-background", "very dark navy", "muse-image-1.0")).toBe(a);
    expect(artworkKey("demo/slides/muse-background", "dark and moody", "muse-image-1.0")).not.toBe(a);
    expect(artworkKey("demo/slides/muse-background", "very dark navy", "muse-image-1.1")).not.toBe(a);
  });
});
