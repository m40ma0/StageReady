"use client";
import { DEFAULT_STEP_BUDGET_MS, type ClaimStatus, summaryParts, transcriptLabel } from "@stage-ready/shared";
import { useQuery } from "@tanstack/react-query";
import { NotebookPen } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { Area, CartesianGrid, ComposedChart, Line, ReferenceLine, Scatter, XAxis, YAxis } from "recharts";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { api } from "@/lib/api-client";
import type { CoachItemDTO, SessionReviewDTO } from "@/lib/types";
import { EmptyState } from "../empty-state";
import { StatusBadge } from "../status-badge";
import { RecordingPlayer } from "./player";
import { ModelCaption } from "@/components/app/model-caption";

const clock = (ms: number) => `${Math.floor(ms / 60_000)}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0")}`;
const SEVERITY: Record<CoachItemDTO["severity"], ClaimStatus> = { high: "contradicted", medium: "unverified", low: "not_shown" };

function CoachList({ title, items }: { title: string; items: CoachItemDTO[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <h3 className="mb-1 text-sm font-medium">{title}</h3>
      <ul className="grid gap-1.5">
        {items.map((i) => (
          <li key={i.key} className="flex items-start gap-2">
            <StatusBadge status={SEVERITY[i.severity]} label={i.severity === "high" ? "High" : i.severity === "medium" ? "Medium" : "Low"} />
            <span>{i.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function CoachNotes({ data }: { data: SessionReviewDTO }) {
  // Coach Notes are written by a background job right after the session; poll until they land.
  const query = useQuery({
    queryKey: ["session", data.session.id],
    queryFn: () => api<SessionReviewDTO>(`/api/sessions/${data.session.id}`),
    initialData: data,
    refetchInterval: (q) => (q.state.data?.coachNote ? false : 3_000),
  });
  const note = query.data.coachNote;
  if (!note) return <EmptyState icon={NotebookPen}>Coach Notes are being written from this session and your earlier ones.</EmptyState>;
  return (
    <div className="grid gap-4">
      <CoachList title="Resolved since last time (re-checked)" items={note.resolved} />
      <CoachList title="Still open" items={note.open} />
      <CoachList title="New this session" items={note.newIssues} />
      <CoachList title="Not re-tested" items={note.notRetested} />
      <div>
        <h3 className="mb-1 text-sm font-medium">Next session</h3>
        <ol className="list-decimal pl-5">
          {note.nextPlan.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ol>
        <ModelCaption modelId={note.model?.modelId} latencyMs={note.model?.latencyMs ?? null} className="mt-1" />
      </div>
    </div>
  );
}

function Evidence({ claim }: { claim: SessionReviewDTO["claims"][number] }) {
  return (
    <HoverCard openDelay={100}>
      <HoverCardTrigger asChild>
        <button type="button" className="focus-visible:ring-primary rounded-sm focus-visible:ring-2">
          <StatusBadge status={claim.status} />
        </button>
      </HoverCardTrigger>
      <HoverCardContent className="w-80" align="end">
        {claim.evidence.length === 0 ? (
          <p className="text-muted-foreground text-xs">No evidence, so this stays Unverified.</p>
        ) : (
          <ul className="grid gap-2 text-xs">
            {claim.evidence.map((e) => (
              <li key={e.ref + e.summary}>
                <code className="font-mono">{e.ref}</code> <span className="text-muted-foreground">{e.summary}</span>
              </li>
            ))}
          </ul>
        )}
      </HoverCardContent>
    </HoverCard>
  );
}

const latencyConfig = {
  p50: { label: "p50 (s)", color: "var(--chart-1)" },
  p95: { label: "p95 (s)", color: "var(--chart-1)" },
  thisSession: { label: "This session (s)", color: "var(--chart-2)" },
} satisfies ChartConfig;

export function SessionReview({ data }: { data: SessionReviewDTO }) {
  const video = useRef<HTMLVideoElement>(null);
  const [tab, setTab] = useState("summary");
  const [filter, setFilter] = useState<ClaimStatus | "all">("all");
  const seek = (ms: number) => {
    setTab("transcript");
    requestAnimationFrame(() => {
      if (!video.current) return;
      video.current.currentTime = ms / 1000;
      void video.current.play().catch(() => undefined);
    });
  };
  const s = data.summary;
  const issues = useMemo(() => {
    const rank = { contradicted: 0, not_shown: 1, unverified: 2, verified: 3 } as const;
    return [...data.claims]
      .filter((c) => c.status !== "verified")
      .sort((a, b) => rank[a.status] - rank[b.status])
      .slice(0, 3);
  }, [data.claims]);
  const sectionStarts = useMemo(() => {
    let t = 0;
    return Object.fromEntries(data.rubric.sections.map((sec) => [sec.key, ((t += sec.budgetSec), (t - sec.budgetSec) * 1000)]));
  }, [data.rubric.sections]);
  const latencyData = data.latency.acrossRehearsals.map((l) => ({
    stepKey: l.stepKey,
    p50: l.p50 === null ? null : l.p50 / 1000,
    band: l.p50 === null || l.p95 === null ? null : [l.p50 / 1000, l.p95 / 1000],
    thisSession: l.thisSession === null ? null : l.thisSession / 1000,
  }));

  return (
    <Tabs value={tab} onValueChange={setTab}>
      <TabsList>
        <TabsTrigger value="summary">Summary</TabsTrigger>
        <TabsTrigger value="claims">Claims</TabsTrigger>
        <TabsTrigger value="rubric">Rubric</TabsTrigger>
        <TabsTrigger value="latency">Latency</TabsTrigger>
        <TabsTrigger value="judges">Judges</TabsTrigger>
        <TabsTrigger value="transcript">Transcript</TabsTrigger>
      </TabsList>

      <TabsContent value="summary" className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>
              Score <span className="font-mono tabular-nums">{s?.score ?? "–"}</span> / 100
            </CardTitle>
            <CardDescription>
              {s ? (
                <>
                  <span className="tabular-nums">{summaryParts(s).join(" · ")}</span>
                  {s.transcript?.source === "muse" ? " · transcript by Muse Voice Transcribe" : ""}
                </>
              ) : (
                "This session has no summary yet."
              )}
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            <h3 className="text-sm font-medium">Three biggest issues</h3>
            {issues.length === 0 ? (
              <p className="text-muted-foreground">No contradicted, unshown or unverified claims.</p>
            ) : (
              <ul className="grid gap-2">
                {issues.map((c) => (
                  <li key={c.id} className="grid gap-1 rounded-lg border p-3">
                    <div className="flex items-start justify-between gap-2">
                      <span>{c.text}</span>
                      <StatusBadge status={c.status} />
                    </div>
                    {c.suggestedRewrite ? <p className="text-muted-foreground text-xs">Say instead: {c.suggestedRewrite}</p> : null}
                    <ModelCaption modelId={c.model?.modelId} latencyMs={c.model?.latencyMs ?? null} />
                  </li>
                ))}
              </ul>
            )}
            {s?.flags?.length ? (
              <div className="grid gap-1">
                <h3 className="text-sm font-medium">Auditor flags</h3>
                {s.flags.map((f) => (
                  <p key={f.detail} className="text-sm">
                    <Badge variant="outline" className="mr-1">
                      {f.kind === "canned_response" ? "Possible canned response" : f.kind === "show_or_strike" ? "Show or strike" : "Cross-source"}
                    </Badge>
                    {f.detail} {f.refs.length ? <span className="text-muted-foreground text-xs">({f.refs.join("; ")})</span> : null}
                  </p>
                ))}
              </div>
            ) : null}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Coach Notes</CardTitle>
            <CardDescription>Compared with your earlier rehearsals.</CardDescription>
          </CardHeader>
          <CardContent>
            <CoachNotes data={data} />
          </CardContent>
        </Card>
      </TabsContent>

      <TabsContent value="claims" className="grid gap-3">
        <ToggleGroup type="single" value={filter} onValueChange={(v) => setFilter((v || "all") as ClaimStatus | "all")} aria-label="Filter claims by status">
          {(["all", "contradicted", "not_shown", "unverified", "verified"] as const).map((k) => (
            <ToggleGroupItem key={k} value={k}>
              {k === "all" ? "All" : k === "not_shown" ? "Not shown" : k[0]!.toUpperCase() + k.slice(1)} ({k === "all" ? data.claims.length : data.claims.filter((c) => c.status === k).length})
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-16">At</TableHead>
              <TableHead>Claim</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Honest rewrite</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.claims
              .filter((c) => filter === "all" || c.status === filter)
              .map((c) => (
                <TableRow key={c.id}>
                  <TableCell>
                    {c.atMs === null ? (
                      "–"
                    ) : (
                      <button type="button" className="text-primary font-mono tabular-nums underline underline-offset-2" onClick={() => seek(c.atMs ?? 0)}>
                        {clock(c.atMs)}
                      </button>
                    )}
                  </TableCell>
                  <TableCell className="whitespace-normal">
                    {c.text}
                    <ModelCaption modelId={c.model?.modelId} latencyMs={c.model?.latencyMs ?? null} className="flex" />
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs">{c.type}</TableCell>
                  <TableCell>
                    <Evidence claim={c} />
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs whitespace-normal">{c.suggestedRewrite ?? "–"}</TableCell>
                </TableRow>
              ))}
          </TableBody>
        </Table>
      </TabsContent>

      <TabsContent value="rubric">
        {data.rubric.criteria.length === 0 ? (
          <EmptyState icon={NotebookPen}>Add judging criteria to see the rubric.</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-separate border-spacing-1 text-sm" aria-label="Rubric heatmap: criteria by section">
              <thead>
                <tr>
                  <th className="text-left font-medium">Criterion</th>
                  {data.rubric.sections.map((sec) => (
                    <th key={sec.key} className="font-medium">
                      {sec.title}
                    </th>
                  ))}
                  <th className="font-medium">Q&amp;A</th>
                </tr>
              </thead>
              <tbody>
                {data.rubric.criteria.map((name) => (
                  <tr key={name}>
                    <th scope="row" className="pr-2 text-left font-normal">
                      {name}
                    </th>
                    {[...data.rubric.sections.map((sec) => sec.key), "qa"].map((key) => {
                      const v = data.rubric.cells[name]?.[key] ?? 0;
                      return (
                        <td key={key} className="p-0">
                          <button
                            type="button"
                            onClick={() => seek(sectionStarts[key] ?? 0)}
                            className="focus-visible:ring-primary text-foreground h-10 w-full rounded-md font-mono tabular-nums focus-visible:ring-2"
                            // Single-hue scale on --primary, capped at 55% so the printed score keeps 4.5:1 contrast.
                            style={{ backgroundColor: `color-mix(in oklch, var(--primary) ${Math.round(8 + v * 47)}%, var(--background))` }}
                            aria-label={`${name}, ${key}: ${Math.round(v * 100)}%. Play from this section.`}
                          >
                            {Math.round(v * 100)}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="text-muted-foreground mt-2 text-xs">Coverage score (%) per section. Select a cell to play the recording from that section.</p>
          </div>
        )}
      </TabsContent>

      <TabsContent value="latency" className="grid gap-3">
        {latencyData.length === 0 ? (
          <EmptyState icon={NotebookPen}>No screen steps were timed in this project yet.</EmptyState>
        ) : (
          <>
            <ChartContainer config={latencyConfig} className="aspect-auto h-72 w-full">
              <ComposedChart data={latencyData} margin={{ left: 8, right: 16, bottom: 16 }}>
                <CartesianGrid vertical={false} />
                <XAxis dataKey="stepKey" label={{ value: "Step", position: "insideBottom", offset: -8 }} height={40} />
                <YAxis tickFormatter={(v: number) => `${v} s`} label={{ value: "Latency (s)", angle: -90, position: "insideLeft" }} width={64} />
                <ChartTooltip content={<ChartTooltipContent />} />
                <Area dataKey="band" stroke="none" fill="var(--color-p95)" fillOpacity={0.15} name="p50–p95 band" isAnimationActive={false} />
                <Line dataKey="p50" stroke="var(--color-p50)" strokeWidth={2} dot isAnimationActive={false} />
                <Scatter dataKey="thisSession" fill="var(--color-thisSession)" />
                <ReferenceLine
                  y={DEFAULT_STEP_BUDGET_MS / 1000}
                  stroke="var(--status-contradicted)"
                  strokeDasharray="4 4"
                  label={{ value: `Budget ${DEFAULT_STEP_BUDGET_MS / 1000} s`, position: "insideTopRight" }}
                />
              </ComposedChart>
            </ChartContainer>
            <p className="text-muted-foreground text-xs">p50 line and p50–p95 band across all rehearsals; dots are this session. Dashed line: the latency budget.</p>
          </>
        )}
      </TabsContent>

      <TabsContent value="judges">
        {data.turns.length === 0 ? (
          <EmptyState icon={NotebookPen}>No judge turns in this session.</EmptyState>
        ) : (
          <ul className="grid gap-3">
            {data.turns.map((t) => (
              <li key={t.id} className="grid gap-1 rounded-lg border p-3">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <button type="button" className="text-primary font-mono tabular-nums underline underline-offset-2" onClick={() => seek(t.atMs)}>
                    {clock(t.atMs)}
                  </button>
                  <Badge variant="outline">{t.kind === "follow_up" ? "Follow-up" : t.kind === "question" ? "Question" : "Interrupt"}</Badge>
                  <span className="text-muted-foreground">
                    {t.persona} · Fictional persona{t.trigger ? ` · trigger: ${t.trigger.replace("_", " ")}` : ""}
                  </span>
                </div>
                <p className="font-medium">{t.text}</p>
                <p className="text-muted-foreground">{t.answer ? `You answered: ${t.answer}` : "No answer recorded."}</p>
                <ModelCaption modelId={t.model?.modelId} latencyMs={t.model?.latencyMs ?? null} />
              </li>
            ))}
          </ul>
        )}
      </TabsContent>

      <TabsContent value="transcript" className="grid gap-4 lg:grid-cols-2" forceMount hidden={tab !== "transcript"}>
        <RecordingPlayer ref={video} sessionId={data.session.id} transcript={data.transcript} />
        <ul className="grid max-h-[32rem] content-start gap-1.5 overflow-y-auto pr-2">
          <li className="text-muted-foreground text-xs" data-testid="transcript-source">
            {transcriptLabel(s?.transcript, s?.stt)}
          </li>
          {data.transcript.map((seg) => (
            <li key={seg.id}>
              <button type="button" onClick={() => seek(seg.startMs)} className="hover:bg-muted focus-visible:ring-primary w-full rounded-md p-1 text-left focus-visible:ring-2">
                <span className="text-muted-foreground mr-2 font-mono text-xs tabular-nums">{clock(seg.startMs)}</span>
                {seg.text}
              </button>
            </li>
          ))}
        </ul>
      </TabsContent>
    </Tabs>
  );
}
