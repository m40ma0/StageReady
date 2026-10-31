"use client";
import { useQuery } from "@tanstack/react-query";
import { FolderOpen } from "lucide-react";
import { forwardRef, useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api-client";

const vttTime = (ms: number) => {
  const s = Math.max(0, ms) / 1000;
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${(s % 60).toFixed(3).padStart(6, "0")}`;
};

/** Session recording with captions on by default. Uploaded recordings stream; local ones are opened from disk and never leave it. */
export const RecordingPlayer = forwardRef<HTMLVideoElement, { sessionId: string; transcript: { startMs: number; endMs: number; text: string }[] }>(function RecordingPlayer(
  { sessionId, transcript },
  ref,
) {
  const remote = useQuery({ queryKey: ["recording", sessionId], queryFn: () => api<{ url: string | null }>(`/api/sessions/${sessionId}/recording`) });
  const [local, setLocal] = useState<string | null>(null);
  const captions = useMemo(() => {
    const body = transcript.map((s, i) => `${i + 1}\n${vttTime(s.startMs)} --> ${vttTime(Math.max(s.endMs, s.startMs + 800))}\n${s.text}\n`).join("\n");
    return URL.createObjectURL(new Blob([`WEBVTT\n\n${body}`], { type: "text/vtt" }));
  }, [transcript]);
  useEffect(() => () => URL.revokeObjectURL(captions), [captions]);
  useEffect(() => () => (local ? URL.revokeObjectURL(local) : undefined), [local]);
  const src = local ?? remote.data?.url ?? null;
  // An audio-only recording (Demo Mode's bundled pitch) gets a short strip for the captions, not a 16:9 black frame.
  const audioOnly = src !== null && /\.(m4a|mp3|wav|ogg)(\?|$)/i.test(src);
  return (
    <div className="grid gap-2">
      {audioOnly ? <p className="text-muted-foreground text-xs">Audio recording · captions follow the transcript</p> : null}
      <div className={cn("bg-muted overflow-hidden rounded-lg border", audioOnly ? "h-32" : "aspect-video")}>
        {src ? (
          <video ref={ref} src={src} controls className="h-full w-full bg-black" crossOrigin="anonymous">
            <track kind="captions" src={captions} srcLang="en" label="Transcript" default />
          </video>
        ) : (
          <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-3 p-4 text-center">
            <p>The recording stayed on the computer that made it. Open it to replay this session with captions.</p>
            <Button asChild variant="outline" size="sm">
              <label>
                <FolderOpen /> Open recording
                <input
                  type="file"
                  accept="video/webm,video/mp4"
                  className="sr-only"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) setLocal(URL.createObjectURL(f));
                  }}
                />
              </label>
            </Button>
          </div>
        )}
      </div>
    </div>
  );
});
