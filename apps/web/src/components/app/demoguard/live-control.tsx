"use client";
import { SIGNAL_LABEL, type DgPhase, type UiRegion } from "@stage-ready/shared";
import { CircleStop, ExternalLink, Pause, Play, Siren } from "lucide-react";
import { useEffect, useRef } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import type { StepDTO } from "@/lib/types";
import { cn } from "@/lib/utils";
import type { useDemoGuardRun } from "./use-run";
import { RegionOverlay, trackerLabel } from "../region-overlay";

type Run = ReturnType<typeof useDemoGuardRun>;

export const PHASE: Record<DgPhase, { label: string; className: string }> = {
  idle: { label: "Idle", className: "bg-muted text-muted-foreground" },
  preflight: { label: "Pre-flight", className: "bg-muted text-foreground" },
  armed: { label: "Armed", className: "bg-primary text-primary-foreground" },
  live: { label: "Live", className: "bg-status-live text-black" },
  suspect: { label: "Suspect", className: "bg-status-unverified text-black" },
  fallback: { label: "Fallback", className: "bg-status-fallback text-black" },
  recovering: { label: "Recovering", className: "bg-status-unverified text-black" },
  frozen: { label: "Frozen", className: "bg-foreground text-background" },
  done: { label: "Done", className: "bg-muted text-foreground" },
};

const isTyping = (target: EventTarget | null) => target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
const sec = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

export function LiveControlTab({ projectId, dg, steps }: { projectId: string; dg: Run; steps: StepDTO[] }) {
  const { run } = dg;
  const step = steps[run.stepIndex];
  const next = steps[run.stepIndex + 1];
  const active = run.sessionId !== null && !run.ended;
  const onFallback = run.phase === "fallback" || run.phase === "recovering";
  const lastSwitch = run.incidents.find((i) => i.action === "switch");

  // Shift+P Panic, Shift+R Resume, Shift+F Freeze.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.shiftKey || e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      const action = ({ P: "panic", R: "resume", F: "freeze" } as const)[e.key.toUpperCase() as "P" | "R" | "F"];
      if (!action) return;
      e.preventDefault();
      dg.hotkey(action);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, dg]);

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="grid content-start gap-4">
        <div className={cn("flex items-center justify-between gap-4 rounded-xl p-6", PHASE[run.phase].className)} role="status" aria-live="assertive" aria-label="DemoGuard state">
          <span className="text-5xl font-semibold tracking-tight">{PHASE[run.phase].label}</span>
          <span className="text-right text-sm">
            {step ? `Step ${run.stepIndex + 1} of ${steps.length}: ${step.name}` : "No step"}
            {run.totalFallbackMs > 0 ? <span className="block">Time on fallback: {sec(run.totalFallbackMs)}</span> : null}
          </span>
        </div>
        {onFallback && step ? (
          <Alert>
            <Siren aria-hidden />
            <AlertTitle>On fallback: {step.name}</AlertTitle>
            <AlertDescription>
              <p>
                The fallback clip is cued to {sec(run.fallbackSeekMs ?? step.fallbackInMs)} (until {sec(step.fallbackOutMs)}){run.badgeVisible ? ", with the Recorded segment badge" : ""}. The Stage
                window plays it; keep narrating from the cue window. DemoGuard cuts back to live at the next step boundary once the app recovers.
              </p>
              {lastSwitch?.switchMs != null ? <p>Detected and switched {lastSwitch.switchMs} ms after the frame that showed the failure.</p> : null}
            </AlertDescription>
          </Alert>
        ) : null}
        {!active ? <p className="text-muted-foreground">{run.ended ? "This run has ended. Its incidents are in the Post-mortem tab." : "Start pre-flight to begin a run."}</p> : null}
        <div className="grid grid-cols-3 gap-3">
          <Button size="lg" variant="destructive" disabled={!active} onClick={() => dg.hotkey("panic")}>
            <Siren /> Panic <kbd className="ml-auto font-mono text-xs opacity-80">⇧P</kbd>
          </Button>
          <Button size="lg" variant="outline" disabled={!active} onClick={() => dg.hotkey("resume")}>
            <Play /> Resume <kbd className="ml-auto font-mono text-xs opacity-80">⇧R</kbd>
          </Button>
          <Button size="lg" variant="outline" disabled={!active} onClick={() => dg.hotkey("freeze")}>
            <Pause /> Freeze <kbd className="ml-auto font-mono text-xs opacity-80">⇧F</kbd>
          </Button>
        </div>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Signal feed</CardTitle>
            <CardDescription>
              {run.vision === "sam"
                ? "Error dialogs and spinners from SAM 3.1."
                : "Basic screen tracking: frame hashes, colour checks and network signals (SAM 3.1 is not available: no Meta key, or today's demo allowance is used up)."}{" "}
              One critical signal, or two different ones within 3 s, switches to fallback.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {run.feed.length ? (
              <ScrollArea className="h-56">
                <ol className="grid gap-1.5" aria-label="Signals">
                  {run.feed.map((s) => (
                    <li key={s.id} className="flex items-start gap-2 text-sm">
                      <Badge variant={s.critical ? "contradicted" : "unverified"}>{s.critical ? "Critical" : "Signal"}</Badge>
                      <span>
                        <span className="font-medium">{SIGNAL_LABEL[s.kind]}</span> <span className="text-muted-foreground">{s.detail}</span>
                      </span>
                      <span className="text-muted-foreground ml-auto font-mono text-xs tabular-nums">{sec(s.atMs)}</span>
                    </li>
                  ))}
                </ol>
              </ScrollArea>
            ) : (
              <p className="text-muted-foreground text-sm">No signals yet.</p>
            )}
          </CardContent>
        </Card>
      </div>
      <div className="grid content-start gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Next</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-1 text-sm">
            <p>{next ? next.name : "Last step"}</p>
            {step?.narration ? <p className="text-muted-foreground">Narration now: {step.narration}</p> : null}
          </CardContent>
        </Card>
        <Card>
          <CardContent className="grid gap-2 pt-6">
            <p className="text-sm font-medium">Watched screen</p>
            <WatchedScreen stream={run.stream} regions={run.regions} />
            <p className="text-muted-foreground text-xs">{run.vision ? trackerLabel(run.vision) : "Starts with pre-flight."}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="grid gap-3 pt-6">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="dg-badge">Recorded segment badge</Label>
              <Switch id="dg-badge" checked={run.badgeVisible} onCheckedChange={dg.setBadge} disabled={!active} />
            </div>
            <Button variant="outline" onClick={() => window.open(`/projects/${projectId}/demoguard/stage`, "stage-ready-stage", "popup,width=1280,height=720")}>
              <ExternalLink /> Open Stage window (share this one)
            </Button>
            <Button variant="outline" onClick={() => window.open(`/projects/${projectId}/demoguard/cue`, "stage-ready-cue", "popup,width=1280,height=720")}>
              <ExternalLink /> Open cue window
            </Button>
            <Button variant="outline" onClick={dg.end} disabled={!active}>
              <CircleStop /> End run
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

/** What DemoGuard is watching, with SAM 3.1's boxes when hosted SAM is on. */
function WatchedScreen({ stream, regions }: { stream: MediaStream | null; regions: UiRegion[] }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream;
  }, [stream]);
  return (
    <div className={cn("relative aspect-video w-full overflow-hidden rounded-lg border", stream ? "bg-black" : "bg-muted")}>
      {stream ? <video ref={ref} autoPlay muted playsInline className="h-full w-full object-contain" aria-label="Watched screen preview" /> : null}
      <RegionOverlay regions={regions} />
    </div>
  );
}
