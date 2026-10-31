// Records the landing page's ~20 s product clip from the real app in Demo Mode, then cuts it with FFmpeg.
//
//   pnpm dev                                   # the stack, in Demo Mode (no keys needed)
//   pnpm --filter @stage-ready/web clip        # writes public/clip.mp4 and public/clip-poster.jpg
//
// Each scene is recorded in its own browser context; the script notes when the interesting state is
// on screen, then trims that span, adds a caption, and joins the scenes with short crossfades.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "@playwright/test";

const BASE = process.env.CLIP_BASE_URL ?? "http://localhost:3000";
const FIXTURES = new URL("../e2e/.fixtures/", import.meta.url).pathname;
const OUT = new URL("../public/", import.meta.url).pathname;
const SIZE = { width: 1280, height: 720 };
const work = mkdtempSync(join(tmpdir(), "stage-ready-clip-"));

const browser = await chromium.launch({
  ...(process.env.CHROME ? { channel: "chrome" } : {}),
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    `--use-file-for-fake-audio-capture=${FIXTURES}speech-bursts.wav`,
    `--use-file-for-fake-video-capture=${FIXTURES}demo-screen.y4m`,
    "--autoplay-policy=no-user-gesture-required",
  ],
});

/** Signed-out runs: the guest session the scenes share once the Demo Mode project exists. */
let guestState = null;

/** Runs one scene; `mark()` notes the moment the clip should centre on. Returns the video and the cut. */
async function scene(name, caption, seconds, run) {
  const dir = join(work, name);
  mkdirSync(dir);
  const context = await browser.newContext({
    viewport: SIZE,
    recordVideo: { dir, size: SIZE },
    colorScheme: "dark",
    permissions: ["microphone", "camera"],
    // The guest cookie from the project's creation, so later scenes open the same guest's project.
    ...(guestState ? { storageState: guestState } : {}),
  });
  const page = await context.newPage();
  let markAt = null;
  await run(page, () => (markAt = Date.now()));
  await page.waitForTimeout(800);
  const video = await page.video().path();
  const closedAt = Date.now();
  await context.close();
  // The recording ends when the context closes, so time the cut back from the video's end.
  const duration = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", video]).toString().trim());
  const markInVideo = duration - (closedAt - (markAt ?? closedAt)) / 1000;
  const length = Math.min(seconds, markInVideo + 0.6);
  return { video, caption, start: Math.max(0, markInVideo + 0.6 - length), seconds: length };
}

const demo = async (page) => {
  const response = await page.request.post(`${BASE}/api/demo`, { maxRedirects: 0 });
  return `${BASE}${response.headers().location}`;
};

const scenes = [];
scenes.push(
  await scene("landing", "One click into a fictional Demo Mode project", 3.5, async (page, mark) => {
    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.waitForTimeout(1200);
    await page.getByRole("link", { name: /Try Demo Mode/ }).click();
    await page.waitForURL(/\/projects\/[0-9a-f-]{36}$/);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1500);
    mark();
  }),
);
const project = await (async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const url = await demo(page);
  guestState = await context.storageState();
  await context.close();
  return url;
})();
scenes.push(
  await scene("studio", "Judges interrupt; the Claim Auditor checks each claim live", 7, async (page, mark) => {
    await page.goto(`${project}/rehearse`, { waitUntil: "networkidle" });
    await page.getByRole("combobox", { name: "Video source" }).click();
    await page.getByRole("option", { name: "Camera or virtual camera" }).click();
    await page.getByRole("button", { name: /Start rehearsal/ }).click();
    await page.getByLabel("I consent to recording this session.").check();
    await page.getByRole("button", { name: "Start", exact: true }).click();
    const instant = page.getByLabel("Claim ledger").getByRole("row").filter({ hasText: "The summary is instant." });
    await instant.filter({ hasText: "Contradicted" }).waitFor({ timeout: 60_000 });
    await page.waitForTimeout(3000);
    mark();
    await page.getByRole("button", { name: /Stop/ }).click();
  }),
);
for (const [name, path, caption] of [
  ["qa", "/qa-kit", "Likely questions, 20-second answers, evidence slides"],
  ["director", "/director", "The best take per section, cut into your video"],
  ["demoguard", "/demoguard", "DemoGuard watches the live demo for failures"],
]) {
  scenes.push(
    await scene(name, caption, 3.5, async (page, mark) => {
      await page.goto(`${project}${path}`, { waitUntil: "networkidle" });
      await page.waitForTimeout(3000);
      mark();
    }),
  );
}
// Captions as transparent PNGs, drawn by the browser: overlaying them works with any FFmpeg build (drawtext
// needs FFmpeg built with libfreetype, which Homebrew's default build lacks).
const captionPage = await (await browser.newContext({ viewport: { width: SIZE.width, height: 200 }, deviceScaleFactor: 1 })).newPage();
for (const [i, s] of scenes.entries()) {
  s.captionPng = join(work, `caption-${i}.png`);
  const html = `<html><body style="margin:0;background:transparent;display:flex;justify-content:center;align-items:flex-end;height:200px">
    <div id="c" style="font:700 30px 'DejaVu Sans',system-ui,sans-serif;color:#fff;background:rgba(12,14,20,.78);padding:14px 22px;border-radius:10px">${s.caption.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</div></body></html>`;
  await captionPage.setContent(html);
  await captionPage.locator("#c").screenshot({ path: s.captionPng, omitBackground: true });
}
await browser.close();

// Trim, caption and join with 0.4 s crossfades.
const FADE = 0.4;
const inputs = [...scenes.flatMap((s) => ["-ss", s.start.toFixed(2), "-t", s.seconds.toFixed(2), "-i", s.video]), ...scenes.flatMap((s) => ["-i", s.captionPng])];
const labelled = scenes.map(
  (s, i) => `[${i}:v]fps=30,scale=${SIZE.width}:${SIZE.height},setsar=1,format=yuv420p[v${i}];` + `[v${i}][${scenes.length + i}:v]overlay=x=(W-w)/2:y=H-h-48:format=auto,format=yuv420p[s${i}]`,
);
let chain = "[s0]";
let offset = scenes[0].seconds - FADE;
const fades = scenes.slice(1).map((s, i) => {
  const out = `[x${i}]`;
  const step = `${chain}[s${i + 1}]xfade=transition=fade:duration=${FADE}:offset=${offset.toFixed(2)}${out}`;
  chain = out;
  offset += s.seconds - FADE;
  return step;
});
execFileSync(
  "ffmpeg",
  [
    "-hide_banner",
    "-y",
    ...inputs,
    "-filter_complex",
    [...labelled, ...fades].join(";"),
    "-map",
    chain,
    "-an",
    "-c:v",
    "libx264",
    "-preset",
    "slow",
    "-crf",
    "30",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    join(OUT, "clip.mp4"),
  ],
  { stdio: "inherit" },
);
// The poster is the moment the Claim Auditor contradicts "instant" in the Studio scene.
const posterAt = scenes[0].seconds - FADE + scenes[1].seconds / 2;
execFileSync("ffmpeg", ["-hide_banner", "-y", "-ss", posterAt.toFixed(2), "-i", join(OUT, "clip.mp4"), "-frames:v", "1", "-q:v", "4", join(OUT, "clip-poster.jpg")], { stdio: "inherit" });
rmSync(work, { recursive: true, force: true });
console.log(`Wrote ${OUT}clip.mp4 and ${OUT}clip-poster.jpg (${(offset + FADE).toFixed(1)} s)`);
