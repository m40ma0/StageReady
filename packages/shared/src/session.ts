import { formatSeconds } from "./stats";
import { z } from "zod";
import { SessionMode } from "./ws";

export const CreateSessionBody = z.object({
  mode: SessionMode,
  difficulty: z.number().int().min(1).max(5).default(3),
  drillSection: z.enum(["hook", "problem", "demo", "how", "impact", "close"]).optional(),
  /** Every recording starts with a consent checkbox per session. */
  consent: z.literal(true, { errorMap: () => ({ message: "Confirm consent to record this session." }) }),
});
export type CreateSessionBody = z.infer<typeof CreateSessionBody>;

export const CreateSessionResponse = z.object({ sessionId: z.string().uuid(), wsUrl: z.string(), wsToken: z.string() });
export type CreateSessionResponse = z.infer<typeof CreateSessionResponse>;

export const SessionTokenClaims = z.object({ sid: z.string().uuid(), pid: z.string().uuid(), uid: z.string().uuid() });
export type SessionTokenClaims = z.infer<typeof SessionTokenClaims>;

/** WebSocket tokens expire after 15 minutes and are scoped to one session. */
export const SESSION_TOKEN_TTL_SEC = 15 * 60;

/** Interruptions: at most one per judge per 45 s, only at sentence boundaries. */
export const JUDGE_COOLDOWN_MS = 45_000;
/** A judge yields when the presenter talks over it for this long, or says "let me finish". */
export const TALK_OVER_YIELD_MS = 1_500;

export interface SessionSummary {
  score: number;
  durationMs: number;
  claims: Record<"verified" | "contradicted" | "unverified" | "not_shown", number>;
  interruptions: number;
  latency: { stepKey: string; n: number; p50: number | null; p95: number | null }[];
  modelCostUsd: number | null;
  modelCalls: number;
  /** Calls answered by the mock (Demo Mode without live models, or past the demo allowance). */
  mockedCalls?: number;
  stt: string;
  flags?: AuditFlag[];
  /**
   * Where the stored transcript came from: "muse" once Muse Voice Transcribe has replaced the live
   * transcript after the session, "live" for the faster-whisper captions (with `pending` while the final
   * pass runs, or a `note` saying why it did not), "scripted" for Demo Mode's scripted speech.
   */
  transcript?: { source: "muse" | "live" | "scripted"; modelId?: string; latencyMs?: number; pending?: boolean; note?: string };
}

/** The caption under a session's transcript. */
export function transcriptLabel(t: SessionSummary["transcript"] | undefined, stt: string | undefined): string {
  if (t?.source === "muse") return `Transcript: Muse Voice Transcribe${t.latencyMs ? ` · ${(t.latencyMs / 1000).toFixed(1)} s` : ""}`;
  if (t?.source === "scripted") return "Transcript: Demo Mode scripted speech";
  if (t?.pending) return "Transcript: live captions (faster-whisper) · Muse Voice Transcribe is refining it";
  return `Transcript: live captions (${stt && stt !== "none" ? stt : "faster-whisper"})${t?.note ? ` · ${t.note}` : " · Muse Voice Transcribe is not configured"}`;
}

/** One weak spot in Rehearsal Memory. `key` is stable across sessions so items can be diffed. */
export const CoachItem = z.object({ key: z.string(), text: z.string().max(240), severity: z.enum(["high", "medium", "low"]) });
export type CoachItem = z.infer<typeof CoachItem>;

export const CoachNotesOutput = z.object({
  resolved: z.array(CoachItem),
  open: z.array(CoachItem),
  newIssues: z.array(CoachItem),
  nextPlan: z.array(z.string().max(200)).length(3),
});
export type CoachNotesOutput = z.infer<typeof CoachNotesOutput>;

/** Auditor flags that are not claims, shown in the session review and fed to Coach Notes. */
export const AuditFlag = z.object({ kind: z.enum(["canned_response", "cross_source", "show_or_strike"]), detail: z.string(), refs: z.array(z.string()) });
export type AuditFlag = z.infer<typeof AuditFlag>;

/** Latency budget drawn as the reference line until DemoGuard step maps set one per step. */
export const DEFAULT_STEP_BUDGET_MS = 2_000;

/** Coach Notes written before M3 stored plain strings; read both shapes. */
export function toCoachItems(items: unknown): CoachItem[] {
  if (!Array.isArray(items)) return [];
  return items.flatMap((item) => {
    if (typeof item === "string") return [{ key: `text:${item.toLowerCase()}`, text: item, severity: "medium" as const }];
    const parsed = CoachItem.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

/**
 * How a session's model use reads: "Mocked" when no real model was called, the cost when MODEL_PRICES
 * covers it, otherwise just the call count (an unknown cost is not shown as $0).
 */
export function modelUseLabel(s: { modelCostUsd: number | null; modelCalls: number; mockedCalls?: number | undefined }): string {
  const calls = `${s.modelCalls} model call${s.modelCalls === 1 ? "" : "s"}`;
  const mocked = s.mockedCalls ?? (s.modelCostUsd === 0 ? s.modelCalls : 0);
  if (s.modelCalls === 0) return "no model calls";
  if (mocked >= s.modelCalls) return `${calls}, mocked`;
  if (s.modelCostUsd === null || s.modelCostUsd === 0) return mocked > 0 ? `${calls} (${mocked} mocked)` : calls;
  return `$${s.modelCostUsd.toFixed(4)} over ${calls}${mocked > 0 ? ` (${mocked} mocked)` : ""}`;
}

type Span = { id: string; startMs: number; endMs: number };
const overlapMs = (a: Span, b: Span) => Math.max(0, Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs));

/** For each old span, the new span it overlaps most (or the nearest one): how claims follow a replaced transcript. */
export function mapSegments(old: Span[], next: Span[]): Map<string, string> {
  const map = new Map<string, string>();
  if (next.length === 0) return map;
  for (const o of old) {
    let best = next[0]!;
    let bestScore = -Infinity;
    for (const n of next) {
      const shared = overlapMs(o, n);
      const score = shared > 0 ? shared : -Math.abs((o.startMs + o.endMs) / 2 - (n.startMs + n.endMs) / 2);
      if (score > bestScore) [best, bestScore] = [n, score];
    }
    map.set(o.id, best.id);
  }
  return map;
}

/**
 * The Demo Mode rehearsal's bundled voice recording, transcribed once by Muse Voice Transcribe and cached
 * (apps/worker/src/lib/demo-voice.ts). `lines` are where each demoSession.transcript line sits in the audio.
 */
export interface DemoVoice {
  modelId: string;
  latencyMs: number;
  turns: { startMs: number; endMs: number; text: string }[];
  lines: { startMs: number; endMs: number }[];
  /** Where the browser can play the recording. */
  audioUrl: string;
}

/** Redis key for the cached DemoVoice. */
export const DEMO_VOICE_KEY = "demo:voice-transcript";

/**
 * The one-line description under a session's score: duration, interruptions and model use, skipping any part
 * an older or partial summary lacks (never "NaN s" or "undefined model calls").
 */
export function summaryParts(s: Partial<SessionSummary>): string[] {
  const parts: string[] = [];
  if (typeof s.durationMs === "number" && Number.isFinite(s.durationMs)) parts.push(formatSeconds(s.durationMs));
  if (typeof s.interruptions === "number") parts.push(`${s.interruptions} interruption${s.interruptions === 1 ? "" : "s"}`);
  if (typeof s.modelCalls === "number") parts.push(modelUseLabel({ modelCostUsd: s.modelCostUsd ?? null, modelCalls: s.modelCalls, mockedCalls: s.mockedCalls }));
  return parts;
}
