import { snapshotNumbers, type SlideSnapshot } from "@stage-ready/shared";
import { describe, expect, it } from "vitest";
import { artGain, composeSlide, meanLuminance, renderSvg, renderVerifiedSlide } from "../src/lib/slides";

const snapshot: SlideSnapshot = {
  title: "How long does generate summary take?",
  subtitle: "Measured step latency across rehearsals (3 runs of generate summary)",
  chart: {
    kind: "bar",
    unit: "s",
    series: [
      { label: "generate summary", value: 9.2 },
      { label: "load comparison", value: 0.6 },
    ],
  },
  facts: [
    { label: "Median", value: "9.2 s" },
    { label: "p95", value: "9.8 s" },
  ],
  sources: ["latency_samples: generate_summary"],
};

describe("evidence slides", () => {
  it("draws every snapshot number on the slide", async () => {
    const { text } = await composeSlide(snapshot, { withChart: true });
    const drawn = text.join(" ");
    for (const n of snapshotNumbers(snapshot)) expect(drawn).toContain(n.replace(/ s$/, ""));
  });

  it("passes when the reader finds every number", async () => {
    const out = await renderVerifiedSlide(snapshot, async (_png, text) => text.flatMap((t) => t.match(/\d[\d,.]*/g) ?? []));
    expect(out.verification).toBe("passed");
    expect(out.png.subarray(1, 4).toString()).toBe("PNG");
  });

  it("a mismatch triggers the deterministic fallback slide", async () => {
    const out = await renderVerifiedSlide(snapshot, async () => ["9.3 s", "0.6 s", "9.8"]);
    expect(out.verification).toBe("fallback");
    expect(out.missing).toContain("9.2 s");
  });

  it("a failed reading also falls back", async () => {
    const out = await renderVerifiedSlide(snapshot, async () => {
      throw new Error("vision unavailable");
    });
    expect(out.verification).toBe("fallback");
  });

  it("draws Muse Image art behind the content with a caption, and still verifies", async () => {
    // A 1×1 PNG stands in for the generated background.
    const pixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const art = { dataUrl: `data:image/png;base64,${pixel}`, caption: "Image: Muse Image 1.0" };
    const { svg, text } = await composeSlide(snapshot, { withChart: true, art });
    expect(svg).toContain('<image href="data:image/png;base64,');
    expect(text).toContain("Image: Muse Image 1.0");
    const out = await renderVerifiedSlide(snapshot, async (_png, drawn) => drawn.flatMap((t) => t.match(/\d[\d,.]*/g) ?? []), art);
    expect(out.verification).toBe("passed");
    expect(out.png.length).toBeGreaterThan(1000);
  });

  it("draws the title with the bundled font even on a host with no system fonts", async () => {
    const { svg } = await composeSlide(snapshot, { withChart: true });
    const { pixels, width } = renderSvg(svg, { systemFonts: false });
    // The title's first line sits around y = 100–160 from x = 100; count distinct colours there.
    const colours = new Set<number>();
    for (let y = 95; y < 165; y += 2)
      for (let x = 100; x < 1100; x += 2) {
        const i = (y * width + x) * 4;
        colours.add((pixels[i]! << 16) | (pixels[i + 1]! << 8) | pixels[i + 2]!);
      }
    expect(colours.size).toBeGreaterThan(5);
  });

  it("brightens dark generated art, up to 4×, and leaves bright art alone", () => {
    expect(artGain(17)).toBe(4);
    expect(artGain(52.5)).toBe(2);
    expect(artGain(160)).toBe(1);
    const black = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==";
    expect(meanLuminance(`data:image/png;base64,${black}`)).toBeLessThan(5);
  });
});
