import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pcm16ToWav } from "@stage-ready/ai";
import { DEMO_VOICE_KEY } from "@stage-ready/shared";
import { describe, expect, it, vi } from "vitest";
import { readWav, warmDemoVoice } from "../src/lib/demo-voice";

const logger = { info: () => undefined, warn: () => undefined };

describe("readWav", () => {
  it("reads mono PCM16 and its sample rate", () => {
    const { pcm, sampleRate } = readWav(pcm16ToWav(new Int16Array([1, -2, 3]), 16_000));
    expect(sampleRate).toBe(16_000);
    expect([...pcm]).toEqual([1, -2, 3]);
  });

  it("refuses anything that is not a WAV", () => {
    expect(() => readWav(new TextEncoder().encode("not audio at all"))).toThrow(/Not a WAV/);
  });
});

describe("warmDemoVoice", () => {
  it("transcribes the bundled recording once and caches it in Redis", async () => {
    const dir = mkdtempSync(join(tmpdir(), "demo-voice-"));
    const files = { wav: join(dir, "a.wav"), lines: join(dir, "a.json") };
    writeFileSync(files.wav, pcm16ToWav(new Int16Array(16_000), 16_000));
    writeFileSync(files.lines, JSON.stringify({ lines: [{ startMs: 100, endMs: 900 }] }));
    const store = new Map<string, string>();
    const redis = { get: async (k: string) => store.get(k) ?? null, set: async (k: string, v: string) => store.set(k, v) };
    const transcribe = vi.fn(async () => ({ modelId: "muse-voice-transcribe-1.0", latencyMs: 900, audioDurationMs: 1000, turns: [{ startMs: 100, endMs: 900, text: "hello" }] }));

    const first = await warmDemoVoice({ redis, transcriber: { transcribe }, logger, files });
    const second = await warmDemoVoice({ redis, transcriber: { transcribe }, logger, files });
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(first?.turns[0]?.text).toBe("hello");
    expect(second?.modelId).toBe("muse-voice-transcribe-1.0");
    expect(JSON.parse(store.get(DEMO_VOICE_KEY)!).audioUrl).toBe("/demo/rehearsal-1.m4a");
  });

  it("does nothing without a bundled recording", async () => {
    const transcribe = vi.fn();
    const out = await warmDemoVoice({ redis: { get: async () => null, set: async () => undefined }, transcriber: { transcribe }, logger, files: { wav: "/nope.wav", lines: "/nope.json" } });
    expect(out).toBeNull();
    expect(transcribe).not.toHaveBeenCalled();
  });
});
