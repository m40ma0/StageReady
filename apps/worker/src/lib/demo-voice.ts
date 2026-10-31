import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { MuseVoiceTranscriber } from "@stage-ready/ai";
import { DEMO_VOICE_KEY, type DemoVoice } from "@stage-ready/shared";

/** The Demo Mode rehearsal recording (recorded with `pnpm demo:record-voice`) and where each scripted line sits in it. */
const WAV = new URL("../../fixtures/demo-rehearsal.wav", import.meta.url);
const LINES = new URL("../../fixtures/demo-rehearsal.json", import.meta.url);
/** The same recording, compressed for the browser's player (apps/web/public). */
export const DEMO_VOICE_AUDIO_URL = "/demo/rehearsal-1.m4a";

/** Mono PCM16 samples and the sample rate from a RIFF/WAVE file, walking its chunks (headers are not always 44 bytes). */
export function readWav(bytes: Uint8Array): { pcm: Int16Array; sampleRate: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("Not a WAV file.");
  let sampleRate = 0;
  for (let at = 12; at + 8 <= bytes.length;) {
    const id = tag(at);
    const size = view.getUint32(at + 4, true);
    if (id === "fmt ") {
      const [format, channels, bits] = [view.getUint16(at + 8, true), view.getUint16(at + 10, true), view.getUint16(at + 22, true)];
      if (format !== 1 || channels !== 1 || bits !== 16) throw new Error("The WAV must be mono 16-bit PCM.");
      sampleRate = view.getUint32(at + 12, true);
    }
    if (id === "data") {
      if (!sampleRate) throw new Error("The WAV has no fmt chunk before its data.");
      const data = bytes.slice(at + 8, at + 8 + size);
      return { pcm: new Int16Array(data.buffer, 0, Math.floor(data.byteLength / 2)), sampleRate };
    }
    at += 8 + size + (size % 2);
  }
  throw new Error("The WAV has no data chunk.");
}

/**
 * Transcribes the bundled Demo Mode recording with Muse Voice Transcribe once, and caches the result in Redis
 * for /api/demo, so every guest's seeded rehearsal shows a real Muse transcript. Runs again only when the
 * recording changes. Does nothing (and Demo Mode keeps the scripted transcript) without the files or a key.
 */
export async function warmDemoVoice(deps: {
  redis: { get(key: string): Promise<string | null>; set(key: string, value: string): Promise<unknown> };
  transcriber: Pick<MuseVoiceTranscriber, "transcribe">;
  logger: { info(o: object, m: string): void; warn(o: object, m: string): void };
  /** The bundled files by default; tests pass their own. */
  files?: { wav: URL | string; lines: URL | string };
}): Promise<DemoVoice | null> {
  const files = deps.files ?? { wav: WAV, lines: LINES };
  let wav: Buffer;
  let lines: DemoVoice["lines"];
  try {
    [wav, lines] = await Promise.all([readFile(files.wav), readFile(files.lines, "utf8").then((t) => (JSON.parse(t) as { lines: DemoVoice["lines"] }).lines)]);
  } catch {
    deps.logger.info({}, "no Demo Mode recording bundled; the seeded rehearsal keeps its scripted transcript");
    return null;
  }
  const hash = createHash("sha1").update(wav).digest("hex").slice(0, 12);
  const cached = await deps.redis.get(DEMO_VOICE_KEY).then((v) => (v ? (JSON.parse(v) as DemoVoice & { hash?: string }) : null));
  if (cached?.hash === hash) return cached;
  try {
    const { pcm, sampleRate } = readWav(new Uint8Array(wav));
    const result = await deps.transcriber.transcribe(pcm, sampleRate);
    if (result.turns.length === 0) throw new Error("Muse Voice Transcribe heard no speech in the Demo Mode recording.");
    const voice: DemoVoice & { hash: string } = { modelId: result.modelId, latencyMs: result.latencyMs, turns: result.turns, lines, audioUrl: DEMO_VOICE_AUDIO_URL, hash };
    await deps.redis.set(DEMO_VOICE_KEY, JSON.stringify(voice));
    deps.logger.info({ turns: result.turns.length, latencyMs: result.latencyMs }, "Demo Mode recording transcribed by Muse Voice Transcribe");
    return voice;
  } catch (err) {
    deps.logger.warn({ err }, "could not transcribe the Demo Mode recording; the seeded rehearsal keeps its scripted transcript");
    return null;
  }
}
