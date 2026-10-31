import { scoreTranscribedTake } from "@stage-ready/ai";
import { criteria, edls, eventSpecs, incidents, loadAuditFacts, loadRecentLatency, projects, renderJobs, sectionPlans, takeScores, takes } from "@stage-ready/db";
import { CARD_MS, CROSSFADE_MS, chapters, storageFailure, takeWeightsFrom, timelineCaptions, timelineMs, toSrt, type JobPayload } from "@stage-ready/shared";
import { and, asc, eq, inArray } from "drizzle-orm";
import { UserFacingError, type JobContext } from "../lib/context";
import { cachedArtwork } from "../lib/artwork";
import { StorageUnavailable } from "../lib/s3";
import { renderStatus, visionClient } from "../lib/vision";

type TakePayload = Extract<JobPayload, { name: "take-process" }>;
type RenderPayload = Extract<JobPayload, { name: "render" }>;

/** Transcribes an uploaded take with word timestamps, then scores it. */
export async function takeProcess(payload: TakePayload, ctx: JobContext) {
  const [row] = await ctx.db
    .select({ take: takes, section: sectionPlans })
    .from(takes)
    .innerJoin(sectionPlans, eq(sectionPlans.id, takes.sectionPlanId))
    .where(and(eq(takes.id, payload.takeId), eq(takes.projectId, payload.projectId)));
  if (!row) throw new UserFacingError("Take not found.");
  const { take, section } = row;
  await ctx.db.update(takes).set({ status: "processing", error: null }).where(eq(takes.id, take.id));
  try {
    let transcript = take.transcript;
    let durationMs = take.durationMs;
    if (!transcript) {
      const url = take.mediaUrl ? await ctx.storage.presignGet(take.mediaUrl, 3600) : null;
      if (!url) throw new UserFacingError("The take has no uploaded recording to transcribe.");
      await ctx.progress({ pct: 15, step: "Transcribing with word timestamps" });
      const result = await visionClient(ctx.env).transcribe(url);
      transcript = { text: result.text, words: result.words };
      if (result.durationMs > 0) durationMs = result.durationMs;
    }
    const thumbnailUrl = take.thumbnailUrl ?? (await takeThumbnail(ctx, take, durationMs));
    await ctx.progress({ pct: 70, step: "Scoring delivery, coverage, claims and time fit" });
    const [spec] = await ctx.db.select({ id: eventSpecs.id }).from(eventSpecs).where(eq(eventSpecs.projectId, payload.projectId));
    const [criteriaRows, facts, latency, incidentRows] = await Promise.all([
      spec ? ctx.db.select().from(criteria).where(eq(criteria.eventSpecId, spec.id)) : Promise.resolve([]),
      loadAuditFacts(ctx.db, payload.projectId),
      loadRecentLatency(ctx.db, payload.projectId),
      // DemoGuard incidents in the session the take was cut from lower its demo success.
      take.sessionId ? ctx.db.select({ action: incidents.action }).from(incidents).where(eq(incidents.sessionId, take.sessionId)) : Promise.resolve([]),
    ]);
    const { contradictedClaims, ...score } = scoreTranscribedTake(
      { text: transcript.text, words: transcript.words, durationMs, budgetSec: section.budgetSec, incidents: incidentRows.filter((i) => i.action === "switch" || i.action === "panic").length },
      { criteria: criteriaRows.map((c) => ({ id: c.id, name: c.name, description: c.description })), latency, ...facts, weights: takeWeightsFrom(ctx.env.TAKE_SCORE_WEIGHTS) },
    );
    const values = { ...score, breakdown: { ...score.breakdown, contradictedClaims } };
    await ctx.db.transaction(async (tx) => {
      await tx
        .insert(takeScores)
        .values({ projectId: payload.projectId, takeId: take.id, ...values })
        .onConflictDoUpdate({ target: takeScores.takeId, set: values });
      await tx.update(takes).set({ transcript, durationMs, thumbnailUrl, status: "ready" }).where(eq(takes.id, take.id));
    });
    await ctx.progress({ pct: 100, step: "Take scored" });
    return { takeId: take.id, total: score.total };
  } catch (error) {
    await ctx.db
      .update(takes)
      .set({ status: "failed", error: error instanceof UserFacingError ? error.message : "Processing failed." })
      .where(eq(takes.id, take.id));
    throw error;
  }
}

/** A frame from early in an uploaded take for the take grid; best effort, so a failure never fails the take. */
async function takeThumbnail(ctx: JobContext, take: { id: string; projectId: string; mediaUrl: string | null }, durationMs: number): Promise<string | null> {
  if (!take.mediaUrl?.startsWith("s3://")) return null;
  try {
    const source = await ctx.storage.presignGet(take.mediaUrl, 900);
    if (!source) return null;
    const out = await ctx.storage.presignPut(`projects/${take.projectId}/takes/${take.id}/thumbnail.jpg`, "image/jpeg");
    await visionClient(ctx.env).thumbnail(source, Math.min(2_000, Math.floor(durationMs / 3)), out.url);
    return out.uri;
  } catch (error) {
    ctx.logger.warn({ err: error, takeId: take.id }, "take thumbnail failed");
    return null;
  }
}

const POLL_MS = 1_000;
const RENDER_TIMEOUT_MS = 30 * 60_000;

/** Renders an EDL on the vision service: crossfades, title cards, burned captions, −14 LUFS; uploads MP4, SRT, thumbnail and chapters. */
export async function render(payload: RenderPayload, ctx: JobContext) {
  const [row] = await ctx.db
    .select({ job: renderJobs, edl: edls, project: projects })
    .from(renderJobs)
    .innerJoin(edls, eq(edls.id, renderJobs.edlId))
    .innerJoin(projects, eq(projects.id, renderJobs.projectId))
    .where(and(eq(renderJobs.id, payload.renderJobId), eq(renderJobs.projectId, payload.projectId)));
  if (!row) throw new UserFacingError("Render job not found.");
  const { job, edl, project } = row;
  const fail = async (message: string) => ctx.db.update(renderJobs).set({ status: "failed", error: message }).where(eq(renderJobs.id, job.id));
  try {
    await ctx.db.update(renderJobs).set({ status: "running", progress: 0, error: null }).where(eq(renderJobs.id, job.id));
    const takeRows = edl.items.length
      ? await ctx.db
          .select()
          .from(takes)
          .where(
            and(
              eq(takes.projectId, project.id),
              inArray(
                takes.id,
                edl.items.map((i) => i.takeId),
              ),
            ),
          )
      : [];
    const sections = await ctx.db.select().from(sectionPlans).where(eq(sectionPlans.projectId, project.id)).orderBy(asc(sectionPlans.order));
    const titles = Object.fromEntries(sections.map((s) => [s.key, s.title]));
    const byId = new Map(takeRows.map((t) => [t.id, t]));

    const clips = [];
    for (const item of edl.items) {
      const take = byId.get(item.takeId);
      if (!take) throw new UserFacingError("The edit uses a take that no longer exists. Rebuild the EDL.");
      const title = titles[item.sectionKey] ?? item.sectionKey;
      // Demo Mode fixture takes have no recording; the service draws labelled colour bars for them.
      const source = take.mediaUrl?.startsWith("demo/") ? `demo://${title}` : take.mediaUrl ? await ctx.storage.presignGet(take.mediaUrl, 3600) : null;
      if (!source) throw new UserFacingError(`The ${title} take has no uploaded recording.`);
      clips.push({ source, inMs: item.inMs, outMs: item.outMs, chapter: title, transition: item.transition });
    }
    if (clips.length === 0) throw new UserFacingError("The EDL is empty.");

    const wordsByTake = Object.fromEntries(takeRows.map((t) => [t.id, t.transcript?.words ?? []]));
    const captions = timelineCaptions(edl.items, wordsByTake);
    const chapterList = chapters(edl.items, titles);
    const prefix = `projects/${project.id}/renders/${job.id}`;
    const srt = await ctx.storage.put(`${prefix}/captions.srt`, toSrt(captions), "application/x-subrip");
    const chaptersUri = await ctx.storage.put(`${prefix}/chapters.txt`, chapterList.map((c) => `${formatClock(c.atMs)} ${c.title}`).join("\n") + "\n", "text/plain");
    const mp4 = await ctx.storage.presignPut(`${prefix}/video.mp4`, "video/mp4");
    const thumbnail = await ctx.storage.presignPut(`${prefix}/thumbnail.png`, "image/png");
    const statusKey = `${prefix}/status.json`;
    const statusPut = await ctx.storage.presignPut(statusKey, "application/json");

    // Muse Image paints the card background; the title text is drawn by the renderer, so names stay exact.
    const background = await cardArtwork(ctx, project, prefix);

    await ctx.progress({ pct: 5, step: "Sending the edit to the renderer" });
    const vision = visionClient(ctx.env);
    let status = await vision.startRender({
      clips,
      captions,
      intro: { title: project.name, subtitle: project.tagline, ...(background ? { background } : {}) },
      outro: { title: "Thank you", subtitle: project.name, ...(background ? { background } : {}) },
      crossfadeMs: CROSSFADE_MS,
      cardMs: CARD_MS.intro,
      preset: ctx.env.FFMPEG_PRESET,
      outputs: { mp4: mp4.url, thumbnail: thumbnail.url, status: statusPut.url },
    });
    const started = Date.now();
    while (status.status === "queued" || status.status === "running") {
      if (Date.now() - started > RENDER_TIMEOUT_MS) throw new UserFacingError("The render took longer than 30 minutes.");
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      status = await renderStatus(vision, ctx.storage, status.id, statusKey);
      const pct = Math.round(5 + status.progress * 93);
      await ctx.db.update(renderJobs).set({ progress: status.progress }).where(eq(renderJobs.id, job.id));
      await ctx.progress({ pct, step: status.step });
    }
    if (status.status === "failed") {
      // The renderer writes to presigned URLs; a refused upload is a storage problem, not a render problem.
      if (storageFailure({ message: status.error ?? "" }) === "credentials") {
        ctx.logger.error({ renderError: status.error }, "render could not write to storage");
        throw new StorageUnavailable("credentials");
      }
      throw new UserFacingError(`The render failed: ${status.error ?? "unknown error"}`);
    }

    const outputs = { mp4: mp4.uri, thumbnail: thumbnail.uri, srt, chapters: chaptersUri };
    await ctx.db.update(renderJobs).set({ status: "done", progress: 1, outputs }).where(eq(renderJobs.id, job.id));
    await ctx.progress({ pct: 100, step: "Render ready" });
    return { renderJobId: job.id, expectedMs: timelineMs(edl.items), durationMs: status.durationMs, loudnessLufs: status.loudnessLufs };
  } catch (error) {
    await fail(error instanceof UserFacingError ? error.message : "The render failed.");
    throw error;
  }
}

const formatClock = (ms: number) => `${Math.floor(ms / 60_000)}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0")}`;

/** One abstract background for the intro and outro cards from Muse Image, or null (Demo Mode, no MODEL_IMAGE, or a failed call). */
async function cardArtwork(ctx: JobContext, project: { id: string; name: string; tagline: string; demoMode: boolean }, prefix: string): Promise<string | null> {
  const ai = await ctx.aiFor(project.id);
  if (!ai.image) return null;
  await ctx.progress({ pct: 3, step: "Generating title card artwork with Muse Image" });
  // Demo Mode projects share one cached card, so every guest render shows the same generated art.
  const art = await cachedArtwork(
    ctx,
    ai,
    project.demoMode ? "demo/renders/muse-card-art" : `${prefix}/card-art`,
    `Abstract, minimal 16:9 background artwork for the title card of a product demo video. Theme: ${project.tagline || project.name}. Dark, calm, soft gradients with subtle shapes. No text, no letters, no logos, no people.`,
  );
  return art ? ctx.storage.presignGet(ctx.storage.uri(art.key), 3600) : null;
}
