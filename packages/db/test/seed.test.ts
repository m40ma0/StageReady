import { drizzle } from "drizzle-orm/pg-proxy";
import { describe, expect, it } from "vitest";
import * as schema from "../src/schema";
import { buildDemoRows, seedDemoProject } from "../src/seed";
import type { Db } from "../src/index";

/** A drizzle instance that records every statement instead of sending it (pg-proxy has no transactions, so run inline). */
function countingDb() {
  const statements: string[] = [];
  const db = drizzle(
    async (sql) => {
      statements.push(sql);
      return { rows: [] };
    },
    { schema, casing: "snake_case" },
  );
  const fake = Object.assign(db, { transaction: (fn: (tx: typeof db) => Promise<unknown>) => fn(db) });
  return { db: fake as unknown as Db, statements };
}

describe("seedDemoProject", () => {
  it("writes the whole Demo Mode project in at most 25 statements", async () => {
    const { db, statements } = countingDb();
    const projectId = await seedDemoProject(db, "00000000-0000-7000-8000-000000000001");
    expect(projectId).toMatch(/^[0-9a-f-]{36}$/);
    expect(statements.length).toBeLessThanOrEqual(25);
    expect(statements[0]).toMatch(/^delete from "projects"/);
  });

  it("links every child row to rows built in the same pass", () => {
    const r = buildDemoRows("owner");
    const sectionIds = new Set(r.sections.map((s) => s.id));
    expect(r.takes).toHaveLength(12);
    expect(r.takes.every((t) => sectionIds.has(t.sectionPlanId))).toBe(true);
    expect(r.takeScores.map((s) => s.takeId)).toEqual(r.takes.map((t) => t.id));
    expect(r.evidence.map((e) => e.claimId)).toEqual(r.claims.map((c) => c.id));
    expect(r.answerCards.map((a) => a.questionId)).toEqual(r.questions.map((q) => q.id));
    expect(r.questions.length).toBeGreaterThan(0);
  });

  it("uses the Muse transcript of the bundled recording when one is cached", () => {
    const voice = {
      modelId: "muse-voice-transcribe-1.0",
      latencyMs: 2_100,
      audioUrl: "/demo/rehearsal-1.m4a",
      // Muse merged the first two lines into one turn.
      turns: [
        { startMs: 500, endMs: 5_000, text: "We turn noisy field reports into a clear response plan. The summary is instant." },
        { startMs: 5_800, endMs: 8_000, text: "Signal Garden supports offline mode." },
      ],
      lines: [
        { startMs: 500, endMs: 3_200 },
        { startMs: 3_400, endMs: 5_000 },
        { startMs: 5_800, endMs: 8_000 },
      ],
    };
    const r = buildDemoRows("owner", voice);
    expect(r.segments.map((s) => s.text)).toEqual(voice.turns.map((t) => t.text));
    expect(r.session.summary.transcript).toEqual({ source: "muse", modelId: "muse-voice-transcribe-1.0", latencyMs: 2_100 });
    // A complete summary: one real model call (the transcription), priced at $0.18 per hour of audio.
    expect(r.session.summary).toMatchObject({ durationMs: 171_000, interruptions: 1, modelCalls: 1, stt: "muse-voice-transcribe-1.0" });
    expect(r.session.summary.modelCostUsd).toBeGreaterThan(0);
    expect(r.session.recordingUrl).toBe("/demo/rehearsal-1.m4a");
    // Claims 0 and 1 share the merged turn; claim 2 has its own; claims keep their scripted text.
    expect(r.claims[0]!.segmentId).toBe(r.segments[0]!.id);
    expect(r.claims[1]!.segmentId).toBe(r.segments[0]!.id);
    expect(r.claims[2]!.segmentId).toBe(r.segments[1]!.id);
    expect(r.claims[1]!.text).toBe("The summary is instant.");
  });

  it("falls back to the scripted fixture without a recording", () => {
    const r = buildDemoRows("owner");
    expect(r.session.summary.transcript).toEqual({ source: "scripted" });
    expect(Number.isFinite(r.session.summary.durationMs)).toBe(true);
    expect(r.session.summary.claims).toBeDefined();
    expect(r.claims.map((c) => c.segmentId)).toEqual(r.segments.slice(0, r.claims.length).map((s) => s.id));
  });
});
