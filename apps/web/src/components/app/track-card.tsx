"use client";
import type { TrackRecommendation } from "@stage-ready/shared";
import { useQuery } from "@tanstack/react-query";
import { Route } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api-client";
import { EmptyState } from "./empty-state";
import { ErrorAlert } from "./error-alert";

export function TrackCard({ projectId, hasTracks }: { projectId: string; hasTracks: boolean }) {
  const query = useQuery({ queryKey: ["track", projectId], queryFn: () => api<{ recommendation: TrackRecommendation }>(`/api/projects/${projectId}/track`), enabled: hasTracks, staleTime: Infinity });
  if (!hasTracks) return <EmptyState icon={Route}>The event lists no tracks.</EmptyState>;
  if (query.isPending)
    return (
      <div className="grid gap-2" role="status">
        <p className="text-muted-foreground text-sm">Muse Spark is matching your pitch to the event&apos;s tracks…</p>
        <Skeleton className="h-16" />
      </div>
    );
  if (query.error) return <ErrorAlert title="Could not recommend a track" error={query.error} onRetry={() => void query.refetch()} />;
  const rec = query.data.recommendation;
  if (!rec.track) return <EmptyState icon={Route}>Add a pitch outline so a track can be matched to it.</EmptyState>;
  return (
    <div className="grid gap-2">
      <p className="text-lg font-semibold">{rec.track}</p>
      <ul className="grid gap-1">
        {rec.reasons.map((r) => (
          <li key={r.criterion}>
            <span className="font-medium">{r.criterion}: </span>
            <span className="text-muted-foreground">{r.reason}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
