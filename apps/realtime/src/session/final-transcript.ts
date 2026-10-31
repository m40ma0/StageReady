import type { MuseVoiceTranscriber, VoiceTurn } from "@stage-ready/ai";
import { claims, judgeTurns, sessions, transcriptSegments, type Db } from "@stage-ready/db";
import { mapSegments, spreadWords, type SessionSummary } from "@stage-ready/shared";
import { and, eq, inArray } from "drizzle-orm";

/** The browser worklet sends 16 kHz mono PCM16 (apps/web/public/worklets/pcm16.js). */
export const SAMPLE_RATE = 16_000;
/** Keeps memory bounded: 40 minutes of 16 kHz PCM16 is about 77 MB. */
const MAX_SAMPLES = 40 * 60 * SAMPLE_RATE;

/**
 * Keeps the rehearsal's microphone audio, laid out on the session clock: a gap in the stream (a dropped
 * connection) becomes silence, so turn times from the final transcript line up with the live segments.
 */
export class AudioRecorder {
  private chunks: Int16Array[] = [];
  private samples = 0;
  startMs: number | null = null;

  push(atMs: number, pcm: Int16Array) {
    if (this.startMs === null) this.startMs = atMs;
    const expected = Math.round(((atMs - this.startMs) / 1000) * SAMPLE_RATE);
    const gap = expected - this.samples;
    if (gap > SAMPLE_RATE / 4 && this.samples + gap < MAX_SAMPLES) {
      this.chunks.push(new Int16Array(gap));
      this.samples += gap;
    }
    if (this.samples + pcm.length > MAX_SAMPLES) return;
    this.chunks.push(pcm.slice());
    this.samples += pcm.length;
  }

  get durationMs() {
    return (this.samples / SAMPLE_RATE) * 1000;
  }

  pcm(): Int16Array {
    const out = new Int16Array(this.samples);
    let at = 0;
    for (const c of this.chunks) {
      out.set(c, at);
      at += c.length;
    }
    return out;
  }

  clear() {
    this.chunks = [];
    this.samples = 0;
  }
}

export { mapSegments };

/** Replaces the session's live (faster-whisper) transcript with the final turns, keeping claims and judge answers linked. */
export async function replaceTranscript(db: Db, projectId: string, sessionId: string, turns: VoiceTurn[]): Promise<void> {
  await db.transaction(async (tx) => {
    const old = await tx
      .select({ id: transcriptSegments.id, startMs: transcriptSegments.startMs, endMs: transcriptSegments.endMs })
      .from(transcriptSegments)
      .where(eq(transcriptSegments.sessionId, sessionId));
    const inserted = await tx
      .insert(transcriptSegments)
      .values(
        turns.map((t) => {
          const startMs = Math.round(t.startMs);
          const endMs = Math.max(startMs + 1, Math.round(t.endMs));
          // The file endpoint gives turn times, not word times: spread the words across the turn.
          const words = spreadWords(t.text, endMs - startMs, 0).map((w) => ({ ...w, startMs: w.startMs + startMs, endMs: w.endMs + startMs }));
          return { projectId, sessionId, startMs, endMs, speaker: "presenter", text: t.text, words };
        }),
      )
      .returning({ id: transcriptSegments.id, startMs: transcriptSegments.startMs, endMs: transcriptSegments.endMs });
    const map = mapSegments(old, inserted);
    for (const [from, to] of map)
      await tx
        .update(claims)
        .set({ segmentId: to })
        .where(and(eq(claims.sessionId, sessionId), eq(claims.segmentId, from)));
    const answered = await tx.select({ id: judgeTurns.id, ids: judgeTurns.presenterAnswerSegmentIds }).from(judgeTurns).where(eq(judgeTurns.sessionId, sessionId));
    for (const turn of answered) {
      if (!turn.ids?.length) continue;
      const ids = [...new Set(turn.ids.map((id) => map.get(id) ?? id))];
      await tx.update(judgeTurns).set({ presenterAnswerSegmentIds: ids }).where(eq(judgeTurns.id, turn.id));
    }
    if (old.length)
      await tx.delete(transcriptSegments).where(
        inArray(
          transcriptSegments.id,
          old.map((o) => o.id),
        ),
      );
  });
}

/** Merges `transcript` into the stored session summary. */
export async function setTranscriptSource(db: Db, sessionId: string, transcript: NonNullable<SessionSummary["transcript"]>): Promise<void> {
  const [row] = await db.select({ summary: sessions.summary }).from(sessions).where(eq(sessions.id, sessionId));
  await db
    .update(sessions)
    .set({ summary: { ...(row?.summary ?? {}), transcript } })
    .where(eq(sessions.id, sessionId));
}

/** Runs Muse Voice Transcribe on the recorded audio and swaps the transcript in; on failure the live transcript stays and the summary says why. */
export async function finalizeTranscript(
  deps: { db: Db; transcriber: MuseVoiceTranscriber; logger: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void } },
  ids: { projectId: string; sessionId: string },
  recorder: AudioRecorder,
): Promise<void> {
  const baseMs = recorder.startMs ?? 0;
  try {
    const result = await deps.transcriber.transcribe(recorder.pcm(), SAMPLE_RATE);
    recorder.clear();
    if (result.turns.length === 0) {
      await setTranscriptSource(deps.db, ids.sessionId, { source: "live", note: "Muse Voice Transcribe heard no speech; the live transcript stays." });
      return;
    }
    await replaceTranscript(
      deps.db,
      ids.projectId,
      ids.sessionId,
      result.turns.map((t) => ({ ...t, startMs: t.startMs + baseMs, endMs: t.endMs + baseMs })),
    );
    await setTranscriptSource(deps.db, ids.sessionId, { source: "muse", modelId: result.modelId, latencyMs: result.latencyMs });
    deps.logger.info({ turns: result.turns.length, latencyMs: result.latencyMs }, "final transcript from Muse Voice Transcribe");
  } catch (err) {
    recorder.clear();
    deps.logger.warn({ err }, "Muse Voice Transcribe failed; keeping the live transcript");
    await setTranscriptSource(deps.db, ids.sessionId, { source: "live", note: "Muse Voice Transcribe failed; this is the live faster-whisper transcript." }).catch(() => undefined);
  }
}
