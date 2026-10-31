"use client";
import { formatSeconds, type SessionSummary, summaryParts } from "@stage-ready/shared";
import { useQuery } from "@tanstack/react-query";
import { Download, ListChecks } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api-client";
import { StatusBadge } from "../status-badge";
import { downloadBlob } from "@/lib/studio/download";

export function SummaryCard({ projectId, sessionId, recording }: { projectId: string; sessionId: string; recording: Blob | null }) {
  const { data } = useQuery({ queryKey: ["session", sessionId], queryFn: () => api<{ summary: SessionSummary }>(`/api/sessions/${sessionId}`) });
  if (!data) return <Skeleton className="h-28 rounded-xl" />;
  const s = data.summary;
  return (
    <Card className="gap-3 py-4">
      <CardHeader>
        <CardTitle>
          Session score <span className="font-mono tabular-nums">{s.score}</span> / 100
        </CardTitle>
        <CardDescription>
          <span className="tabular-nums">{[...summaryParts(s), ...(s.stt ? [`speech: ${s.stt}`] : [])].join(" · ")}</span>
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-3">
        {(["contradicted", "unverified", "not_shown", "verified"] as const).map((k) => (
          <StatusBadge key={k} status={k} label={`${s.claims[k]} ${k === "not_shown" ? "not shown" : k}`} />
        ))}
        {s.latency.map((l) => (
          <span key={l.stepKey} className="text-muted-foreground text-xs">
            {l.stepKey}: p50 <span className="font-mono tabular-nums">{l.p50 === null ? "–" : formatSeconds(l.p50)}</span>, p95{" "}
            <span className="font-mono tabular-nums">{l.p95 === null ? "–" : formatSeconds(l.p95)}</span>
          </span>
        ))}
        <div className="ml-auto flex gap-2">
          {recording ? (
            <Button variant="outline" size="sm" onClick={() => downloadBlob(recording, "session")}>
              <Download /> Download recording
            </Button>
          ) : null}
          <Button asChild size="sm">
            <Link href={`/projects/${projectId}/sessions`}>
              <ListChecks /> All sessions
            </Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
