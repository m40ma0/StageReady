// Takes the README's three screenshots from the real app in Demo Mode (docs/images/*.png).
//
//   pnpm dev                                        # the stack, in Demo Mode
//   pnpm --filter @stage-ready/web screenshots
//
// Uses the e2e fixtures (fake camera, mic and screens); run `pnpm --filter @stage-ready/web test:e2e` once to create them.
import { mkdirSync } from "node:fs";
import { chromium } from "@playwright/test";

const BASE = process.env.SCREENSHOT_BASE_URL ?? "http://localhost:3000";
const FIXTURES = new URL("../e2e/.fixtures/", import.meta.url).pathname;
const OUT = new URL("../../../docs/images/", import.meta.url).pathname;
const VIEWPORT = { width: 1440, height: 900 };
// Installed Chrome when CHROME=1: Playwright's bundled Chromium cannot play the H.264 golden-run clip.
const channel = process.env.CHROME ? { channel: "chrome" } : {};
// SHOTS=studio,qa-kit,demoguard picks which to take (all by default).
const want = (name) => !process.env.SHOTS || process.env.SHOTS.split(",").includes(name);
mkdirSync(OUT, { recursive: true });

const media = (screen) => [
  "--use-fake-ui-for-media-stream",
  "--use-fake-device-for-media-stream",
  `--use-file-for-fake-audio-capture=${FIXTURES}speech-bursts.wav`,
  `--use-file-for-fake-video-capture=${FIXTURES}${screen}`,
  "--autoplay-policy=no-user-gesture-required",
];
const demoProject = async (page) => {
  const response = await page.request.post(`${BASE}/api/demo`, { maxRedirects: 0 });
  return `${BASE}${response.headers().location}`;
};

// 1. Rehearsal Studio: a judge has interrupted and "instant" is contradicted with the measured time.
if (want("studio")) {
  const browser = await chromium.launch({ ...channel, args: media("demo-screen.y4m") });
  const context = await browser.newContext({ viewport: VIEWPORT, colorScheme: "dark", permissions: ["microphone", "camera"] });
  const page = await context.newPage();
  const project = await demoProject(page);
  await page.goto(`${project}/rehearse`, { waitUntil: "networkidle" });
  await page.getByRole("combobox", { name: "Video source" }).click();
  await page.getByRole("option", { name: "Camera or virtual camera" }).click();
  await page.getByRole("button", { name: /Start rehearsal/ }).click();
  await page.getByLabel("I consent to recording this session.").check();
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await page.getByLabel("Claim ledger").getByRole("row").filter({ hasText: "The summary is instant." }).filter({ hasText: "Contradicted" }).waitFor({ timeout: 60_000 });
  await page.getByLabel("Judge turns").getByText("Interrupt", { exact: true }).first().waitFor({ timeout: 120_000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}studio.png` });
  await page.getByRole("button", { name: /Stop/ }).click();
  await browser.close();
}

// 2. Q&A Kit: the pre-pitch brief and the ranked questions.
if (want("qa-kit")) {
  const browser = await chromium.launch(channel);
  const page = await (await browser.newContext({ viewport: VIEWPORT, colorScheme: "dark" })).newPage();
  const project = await demoProject(page);
  await page.goto(`${project}/qa-kit`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Rebuild questions" }).click();
  // The rebuild writes the bank, then renders and checks about 24 slides (about 10 s each on the live site).
  await page.getByText("Pre-pitch brief").waitFor({ timeout: 480_000 });
  await page.getByText("Numbers verified").first().waitFor({ timeout: 480_000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}qa-kit.png` });
  await browser.close();
}

// 3. DemoGuard: the Stage window on the golden-run clip, with the Recorded segment badge.
if (want("demoguard")) {
  const browser = await chromium.launch({ ...channel, args: media("demoguard-screen.y4m") });
  const context = await browser.newContext({ viewport: VIEWPORT, colorScheme: "dark", permissions: ["camera"] });
  const page = await context.newPage();
  const project = await demoProject(page);
  await page.goto(`${project}/demoguard`, { waitUntil: "networkidle" });
  const stage = await context.newPage();
  await stage.goto(`${project}/demoguard/stage`, { waitUntil: "networkidle" });
  // Demo Mode ships its golden run (the Signal Garden walkthrough); wait until it can play.
  await stage.getByTestId("fallback-clip-status").filter({ hasText: "ready" }).waitFor({ timeout: 30_000 });
  await page.bringToFront();
  await page.getByRole("tab", { name: "Pre-flight" }).click();
  await page.getByRole("combobox", { name: "Demo screen" }).click();
  await page.getByRole("option", { name: "Camera or virtual camera" }).click();
  await page.getByLabel("I consent to DemoGuard analysing my shared screen.").check();
  await page.getByRole("button", { name: "Start pre-flight" }).click();
  await page.getByRole("button", { name: "Arm" }).click({ timeout: 30_000 });
  await page.getByRole("status", { name: "DemoGuard state" }).filter({ hasText: "Fallback" }).waitFor({ timeout: 40_000 });
  await stage.bringToFront();
  await stage.waitForTimeout(1_500);
  await stage.screenshot({ path: `${OUT}demoguard.png` });
  await browser.close();
}

console.log(
  `Wrote ${["studio", "qa-kit", "demoguard"]
    .filter(want)
    .map((n) => `${OUT}${n}.png`)
    .join(", ")}`,
);
