import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import { formatValue, snapshotNumbers, verifySlideNumbers, type SlideSnapshot } from "@stage-ready/shared";
import { PDFDocument } from "pdf-lib";
import * as vega from "vega";
import * as vl from "vega-lite";

// Evidence slides, rendered deterministically: Vega-Lite → SVG → PNG at 1920×1080. Every number
// on a slide comes from its dataSnapshot.

export const SLIDE_W = 1920;
export const SLIDE_H = 1080;
const FONT = "DejaVu Sans, Inter, Arial, sans-serif";
const C = { bg: "#0c0e14", fg: "#f5f6fa", muted: "#aab0be", accent: "#818cf8", plate: "#161a24" };

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function wrap(text: string, maxChars: number, maxLines: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if ((line + " " + word).trim().length > maxChars && line) {
      lines.push(line);
      line = word;
    } else line = `${line} ${word}`.trim();
  }
  if (line) lines.push(line);
  return lines.length > maxLines
    ? [
        ...lines.slice(0, maxLines - 1),
        `${lines
          .slice(maxLines - 1)
          .join(" ")
          .slice(0, maxChars - 1)}…`,
      ]
    : lines;
}

async function chartSvg(s: SlideSnapshot, width: number, height: number): Promise<string | null> {
  if (s.chart.kind !== "bar" || s.chart.series.length === 0) return null;
  const values = s.chart.series.map((p) => ({ label: p.label, value: p.value, text: formatValue(p.value, s.chart.unit) }));
  const wholeNumbers = s.chart.series.every((p) => Number.isInteger(p.value));
  const spec = vl.compile({
    $schema: "https://vega.github.io/schema/vega-lite/v6.json",
    width,
    height,
    background: C.plate,
    padding: 24,
    config: {
      font: FONT,
      axis: { labelColor: C.muted, titleColor: C.muted, gridColor: "#2a3040", domainColor: "#2a3040", labelFontSize: 22, titleFontSize: 22, labelLimit: 320 },
      view: { stroke: null },
    },
    data: { values },
    layer: [
      {
        mark: { type: "bar", color: C.accent, cornerRadiusEnd: 6 },
        encoding: {
          x: { field: "label", type: "nominal", sort: null, title: null, axis: { labelAngle: 0 } },
          // Counts are whole numbers: no 0.2 steps on their axis.
          y: { field: "value", type: "quantitative", title: s.chart.unit || null, ...(wholeNumbers ? { axis: { tickMinStep: 1, format: "d" } } : {}) },
        },
      },
      {
        mark: { type: "text", dy: -18, fontSize: 30, fontWeight: "bold", color: C.fg },
        encoding: { x: { field: "label", type: "nominal", sort: null }, y: { field: "value", type: "quantitative" }, text: { field: "text" } },
      },
    ],
  } as vl.TopLevelSpec).spec;
  const view = new vega.View(vega.parse(spec), { renderer: "none" });
  const svg = await view.toSVG();
  view.finalize();
  return svg;
}

export interface ComposedSlide {
  svg: string;
  /** Every string drawn on the slide, in order (used by the mocked verifier). */
  text: string[];
}

/** A generated background for the deck (Muse Image), drawn dimmed behind the content with a caption naming the model. */
export interface SlideArt {
  dataUrl: string;
  caption: string;
  /** Linear gain for dark images (1 = as generated), from artGain(); keeps the art visible behind the scrim. */
  gain?: number;
}

/** Mean luminance (0–255) of an image, from a 64 × 36 render. */
export function meanLuminance(dataUrl: string): number {
  const { pixels } = renderSvg(`<svg xmlns="http://www.w3.org/2000/svg" width="64" height="36"><image href="${dataUrl}" width="64" height="36" preserveAspectRatio="none"/></svg>`, { width: 64 });
  let sum = 0;
  for (let i = 0; i < pixels.length; i += 4) sum += 0.2126 * pixels[i]! + 0.7152 * pixels[i + 1]! + 0.0722 * pixels[i + 2]!;
  return sum / (pixels.length / 4);
}

/** How much to brighten generated art so its shapes show: aims for a mean luminance of about 105, at most 4×. */
export const artGain = (luminance: number) => Math.min(4, Math.max(1, 105 / Math.max(1, luminance)));

/** The evidence slide: title, chart and the key facts. `withChart: false` is the deterministic fallback template. */
export async function composeSlide(s: SlideSnapshot, options: { withChart: boolean; art?: SlideArt | null }): Promise<ComposedSlide> {
  const text: string[] = [];
  const parts: string[] = [`<rect width="${SLIDE_W}" height="${SLIDE_H}" fill="${C.bg}"/>`];
  if (options.art) {
    // The art shows clearly on the right; a scrim darkens the left, where the title and figures sit, so they stay legible.
    const gain = options.art.gain ?? 1;
    if (gain > 1.01)
      parts.push(
        `<defs><filter id="lift" color-interpolation-filters="sRGB"><feComponentTransfer><feFuncR type="linear" slope="${gain.toFixed(2)}"/><feFuncG type="linear" slope="${gain.toFixed(2)}"/><feFuncB type="linear" slope="${gain.toFixed(2)}"/></feComponentTransfer></filter></defs>`,
      );
    parts.push(
      `<image href="${options.art.dataUrl}" x="0" y="0" width="${SLIDE_W}" height="${SLIDE_H}" preserveAspectRatio="xMidYMid slice" opacity="0.9"${gain > 1.01 ? ' filter="url(#lift)"' : ""}/>`,
    );
    parts.push(
      `<defs><linearGradient id="scrim" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${C.bg}" stop-opacity="0.78"/><stop offset="0.55" stop-color="${C.bg}" stop-opacity="0.5"/><stop offset="1" stop-color="${C.bg}" stop-opacity="0.1"/></linearGradient></defs>`,
      `<rect width="${SLIDE_W}" height="${SLIDE_H}" fill="url(#scrim)"/>`,
    );
  }
  parts.push(`<rect y="${SLIDE_H - 10}" width="${SLIDE_W}" height="10" fill="${C.accent}"/>`);
  const title = wrap(s.title, 46, 2);
  title.forEach((line, i) => parts.push(`<text x="100" y="${150 + i * 76}" font-family="${FONT}" font-size="64" font-weight="bold" fill="${C.fg}">${esc(line)}</text>`));
  text.push(...title);
  const subY = 150 + title.length * 76 + 10;
  parts.push(`<text x="100" y="${subY}" font-family="${FONT}" font-size="34" fill="${C.muted}">${esc(s.subtitle)}</text>`);
  text.push(s.subtitle);

  const top = subY + 60;
  const chart = options.withChart ? await chartSvg(s, 1000, 520) : null;
  const factsX = chart ? 1260 : 100;
  if (chart) {
    // Nested inline, not as an <image>: resvg only loads fonts for text in the main document.
    parts.push(chart.replace(/^<svg /, `<svg x="100" y="${top}" `));
    text.push(...s.chart.series.map((p) => formatValue(p.value, s.chart.unit)), ...s.chart.series.map((p) => p.label));
  }
  // Fallback and chartless slides print the series as large figures instead.
  const facts = chart ? s.facts : [...s.facts, ...s.chart.series.map((p) => ({ label: p.label, value: formatValue(p.value, s.chart.unit) }))].slice(0, 6);
  facts.forEach((f, i) => {
    const col = chart ? 0 : i % 3;
    const row = chart ? i : Math.floor(i / 3);
    const x = factsX + col * 580;
    const y = top + 70 + row * 190;
    parts.push(`<text x="${x}" y="${y}" font-family="${FONT}" font-size="30" fill="${C.muted}">${esc(f.label)}</text>`);
    parts.push(`<text x="${x}" y="${y + 84}" font-family="${FONT}" font-size="${f.value.length > 14 ? 40 : 76}" font-weight="bold" fill="${C.fg}">${esc(f.value)}</text>`);
    text.push(f.label, f.value);
  });
  if (facts.length === 0 && !chart) {
    parts.push(`<text x="100" y="${top + 120}" font-family="${FONT}" font-size="44" fill="${C.muted}">No measured evidence yet. The Fix Task list tracks what would prove it.</text>`);
  }
  if (s.sources.length) {
    const src = `Source: ${s.sources.join(" · ")}`;
    parts.push(`<text x="100" y="${SLIDE_H - 50}" font-family="${FONT}" font-size="24" fill="${C.muted}">${esc(src)}</text>`);
    text.push(src);
  }
  if (options.art) {
    // A dark backing keeps the caption legible over bright art.
    const w = Math.round(options.art.caption.length * 12.5) + 28;
    parts.push(`<rect x="${SLIDE_W - 100 - w + 14}" y="${SLIDE_H - 50 - 27}" width="${w}" height="38" rx="8" fill="${C.bg}" opacity="0.72"/>`);
    parts.push(`<text x="${SLIDE_W - 100}" y="${SLIDE_H - 50}" text-anchor="end" font-family="${FONT}" font-size="22" fill="${C.fg}">${esc(options.art.caption)}</text>`);
    text.push(options.art.caption);
  }
  return { svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${SLIDE_W}" height="${SLIDE_H}" viewBox="0 0 ${SLIDE_W} ${SLIDE_H}">${parts.join("")}</svg>`, text };
}

/**
 * DejaVu Sans ships with the worker (fonts/, Bitstream Vera licence), so slides render the same on any host.
 * The slim container image has no system fonts at all; without these, resvg drew every text element as nothing.
 */
export const BUNDLED_FONTS = ["DejaVuSans.ttf", "DejaVuSans-Bold.ttf"].map((f) => fileURLToPath(new URL(`../../fonts/${f}`, import.meta.url)));

/** Renders an SVG at slide width; `pixels` is RGBA, for checks that text actually drew. */
export function renderSvg(svg: string, options: { systemFonts?: boolean; width?: number } = {}) {
  const image = new Resvg(svg, {
    fitTo: { mode: "width", value: options.width ?? SLIDE_W },
    font: { fontFiles: BUNDLED_FONTS, loadSystemFonts: options.systemFonts ?? true, defaultFontFamily: "DejaVu Sans" },
  }).render();
  return { png: image.asPng(), pixels: image.pixels, width: image.width, height: image.height };
}

export function svgToPng(svg: string): Uint8Array {
  return renderSvg(svg).png;
}

/** PDF appendix: one 16:9 page per slide PNG. */
export async function slidesPdf(pngs: Uint8Array[]): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle("Evidence appendix");
  for (const png of pngs) {
    const image = await pdf.embedPng(png);
    const page = pdf.addPage([SLIDE_W / 2, SLIDE_H / 2]);
    page.drawImage(image, { x: 0, y: 0, width: SLIDE_W / 2, height: SLIDE_H / 2 });
  }
  return pdf.save();
}

/**
 * Renders the chart slide, has a reader list the numbers on the PNG, and compares them with the
 * snapshot. On any missing number, or if the reader fails, renders the deterministic fallback template.
 */
export async function renderVerifiedSlide(snapshot: SlideSnapshot, read: (png: Uint8Array, drawnText: string[]) => Promise<string[]>, art: SlideArt | null = null) {
  const slide = await composeSlide(snapshot, { withChart: true, art });
  const png = svgToPng(slide.svg);
  try {
    const check = verifySlideNumbers(snapshotNumbers(snapshot), await read(png, slide.text));
    if (check.ok) return { png, verification: "passed" as const, missing: [] as string[], error: null };
    const fallback = await composeSlide(snapshot, { withChart: false, art });
    return { png: svgToPng(fallback.svg), verification: "fallback" as const, missing: check.missing, error: null };
  } catch (error) {
    const fallback = await composeSlide(snapshot, { withChart: false, art });
    return { png: svgToPng(fallback.svg), verification: "fallback" as const, missing: [] as string[], error: error as Error };
  }
}
