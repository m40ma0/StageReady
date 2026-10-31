import "server-only";
import { coachNotes, criteria, eventSpecs, fixTasks, pastWinners, personas, projects, repoFindings, repos, sectionPlans, sessions, winningPatterns } from "@stage-ready/db";
import { computeCompliance, toCoachItems, type ComplianceItem, type SectionPlanItem } from "@stage-ready/shared";
import { and, asc, count, desc, eq, inArray, isNotNull } from "drizzle-orm";
import type { EventSpecDTO, ProjectBundle, ProjectCardDTO, ProjectDTO, RepoDTO } from "@/lib/types";
import { notFound, uuidParam } from "./api";
import { db } from "./db";

type ProjectRow = typeof projects.$inferSelect;

export const toProjectDTO = (p: ProjectRow): ProjectDTO => ({
  id: p.id,
  name: p.name,
  tagline: p.tagline,
  timezone: p.timezone,
  videoLimitSec: p.videoLimitSec,
  demoMode: p.demoMode,
  pitchScript: p.pitchScript,
  submissionText: p.submissionText,
  setupStep: p.setupStep,
  cloudUploadEnabled: p.cloudUploadEnabled,
  strongestMoment: p.strongestMoment,
});

/** Loads a project the user owns, or throws a 404. Every child query is scoped by its projectId. */
export async function requireProject(userId: string, projectId: string): Promise<ProjectRow> {
  uuidParam(projectId);
  const [row] = await db()
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.ownerId, userId)));
  if (!row) throw notFound();
  return row;
}

export async function listProjects(userId: string): Promise<ProjectCardDTO[]> {
  const rows = await db()
    .select({ project: projects, eventName: eventSpecs.name, deadlineAt: eventSpecs.deadlineAt })
    .from(projects)
    .leftJoin(eventSpecs, eq(eventSpecs.projectId, projects.id))
    .where(eq(projects.ownerId, userId))
    .orderBy(desc(projects.updatedAt));
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.project.id);
  const openTasks = await db()
    .select({ projectId: fixTasks.projectId, n: count() })
    .from(fixTasks)
    .where(and(inArray(fixTasks.projectId, ids), eq(fixTasks.status, "open")))
    .groupBy(fixTasks.projectId);
  const latest = await db()
    .selectDistinctOn([sessions.projectId], { projectId: sessions.projectId, summary: sessions.summary })
    .from(sessions)
    .where(inArray(sessions.projectId, ids))
    .orderBy(sessions.projectId, desc(sessions.createdAt));
  return rows.map(({ project, eventName, deadlineAt }) => {
    const score = latest.find((s) => s.projectId === project.id)?.summary?.score;
    return {
      id: project.id,
      name: project.name,
      tagline: project.tagline,
      demoMode: project.demoMode,
      eventName: eventName || null,
      deadlineIso: deadlineAt?.toISOString() ?? null,
      timezone: project.timezone,
      lastScore: typeof score === "number" ? score : null,
      openFixTasks: openTasks.find((t) => t.projectId === project.id)?.n ?? 0,
      setupStep: project.setupStep,
    };
  });
}

export async function loadEventSpec(projectId: string): Promise<EventSpecDTO | null> {
  const [spec] = await db().select().from(eventSpecs).where(eq(eventSpecs.projectId, projectId));
  if (!spec) return null;
  const rows = await db()
    .select()
    .from(criteria)
    .where(and(eq(criteria.projectId, projectId), eq(criteria.eventSpecId, spec.id)))
    .orderBy(asc(criteria.order));
  return {
    id: spec.id,
    name: spec.name,
    sourceUrls: spec.sourceUrls,
    tracks: spec.tracks,
    criteria: rows.map((c) => ({ id: c.id, name: c.name, description: c.description, weight: c.weight, sourceQuote: c.sourceQuote })),
    weightsInferred: spec.weightsInferred,
    requiredTech: spec.requiredTech,
    requirements: spec.requirements,
    sourceQuotes: spec.sourceQuotes,
    droppedFields: spec.droppedFields,
    confirmedAt: spec.confirmedAt?.toISOString() ?? null,
  };
}

export async function loadSectionPlan(projectId: string): Promise<SectionPlanItem[]> {
  const rows = await db().select().from(sectionPlans).where(eq(sectionPlans.projectId, projectId)).orderBy(asc(sectionPlans.order));
  return rows.map((r) => ({ key: r.key, title: r.title, budgetSec: r.budgetSec }));
}

export async function loadRepo(projectId: string): Promise<RepoDTO | null> {
  const [repo] = await db().select().from(repos).where(eq(repos.projectId, projectId));
  if (!repo) return null;
  const counts = await db().select({ kind: repoFindings.kind, n: count() }).from(repoFindings).where(eq(repoFindings.repoId, repo.id)).groupBy(repoFindings.kind);
  const top = await db()
    .select()
    .from(repoFindings)
    .where(and(eq(repoFindings.repoId, repo.id), inArray(repoFindings.kind, ["secret", "mock_response", "todo", "capability"])))
    .orderBy(desc(repoFindings.severity))
    .limit(40);
  const rank = { high: 0, medium: 1, low: 2, info: 3 } as const;
  return {
    githubFullName: repo.githubFullName,
    commitSha: repo.commitSha,
    visibility: repo.visibility,
    fileCount: repo.fileCount,
    digestTokens: repo.digestTokens,
    findingCounts: Object.fromEntries(counts.map((c) => [c.kind, c.n])),
    capabilitiesError: repo.capabilitiesError,
    topFindings: top.sort((a, b) => rank[a.severity] - rank[b.severity]).map((f) => ({ id: f.id, kind: f.kind, filePath: f.filePath, line: f.line, summary: f.summary, severity: f.severity })),
  };
}

export async function computeProjectCompliance(project: ProjectRow, spec: EventSpecDTO | null, plan: SectionPlanItem[]): Promise<ComplianceItem[]> {
  const [repo] = await db().select().from(repos).where(eq(repos.projectId, project.id));
  let repoSignals: string[] | null = null;
  if (repo?.commitSha) {
    const findings = await db()
      .select({ summary: repoFindings.summary })
      .from(repoFindings)
      .where(and(eq(repoFindings.repoId, repo.id), inArray(repoFindings.kind, ["dependency", "capability"])));
    repoSignals = [...repo.dependencies.map((d) => d.name), ...findings.map((f) => f.summary)];
  }
  const planTotal = plan.length > 0 ? plan.reduce((sum, s) => sum + s.budgetSec, 0) : null;
  return computeCompliance({
    videoMaxSec: spec?.requirements.videoMaxSec ?? null,
    plannedVideoSec: planTotal,
    requiredTech: spec?.requiredTech ?? [],
    repoSignals,
    repoVisibility: repo?.commitSha ? repo.visibility : null,
    repoPublicRequired: spec?.requirements.repoPublic ?? null,
    deadlineIso: spec?.requirements.deadlineIso ?? null,
    timezone: project.timezone,
    now: new Date(),
  });
}

export async function loadBundle(project: ProjectRow): Promise<ProjectBundle> {
  const [eventSpec, sectionPlan, repo] = await Promise.all([loadEventSpec(project.id), loadSectionPlan(project.id), loadRepo(project.id)]);
  const [winnerRows, patternRows, personaRows, compliance] = await Promise.all([
    db().select().from(pastWinners).where(eq(pastWinners.projectId, project.id)).orderBy(asc(pastWinners.createdAt)),
    db().select().from(winningPatterns).where(eq(winningPatterns.projectId, project.id)).orderBy(asc(winningPatterns.createdAt)),
    db().select().from(personas).where(eq(personas.projectId, project.id)).orderBy(asc(personas.createdAt)),
    computeProjectCompliance(project, eventSpec, sectionPlan),
  ]);
  return {
    project: toProjectDTO(project),
    eventSpec,
    winners: winnerRows.map((w) => ({ id: w.id, sourceUrl: w.sourceUrl, profile: w.profile })),
    patterns: patternRows.map((p) => ({ id: p.id, statement: p.statement, evidence: p.evidence, check: p.check, checkResult: p.checkResult, checkDetail: p.checkDetail })),
    repo,
    personas: personaRows.map((p) => ({
      id: p.id,
      role: p.role,
      difficulty: p.difficulty,
      criteriaWeights: p.criteriaWeights,
      questionStyle: p.questionStyle,
      voicePreset: p.voicePreset,
      isFictional: true as const,
    })),
    sectionPlan,
    compliance,
  };
}

export async function loadOverviewExtras(projectId: string) {
  const [openTasks, [note], [latestSession]] = await Promise.all([
    db()
      .select()
      .from(fixTasks)
      .where(and(eq(fixTasks.projectId, projectId), eq(fixTasks.status, "open")))
      .orderBy(asc(fixTasks.createdAt)),
    db().select().from(coachNotes).where(eq(coachNotes.projectId, projectId)).orderBy(desc(coachNotes.createdAt)).limit(1),
    // The latest finished rehearsal with a rubric heatmap: DemoGuard runs and sessions still in progress have none.
    db()
      .select()
      .from(sessions)
      .where(and(eq(sessions.projectId, projectId), isNotNull(sessions.rubricHeatmap)))
      .orderBy(desc(sessions.createdAt))
      .limit(1),
  ]);
  return {
    openTasks: openTasks.map((t) => ({ id: t.id, title: t.title, detail: t.detail, origin: t.origin })),
    coachNote: note
      ? {
          resolved: toCoachItems(note.resolved).map((i) => i.text),
          open: toCoachItems(note.open).map((i) => i.text),
          newIssues: toCoachItems(note.newIssues).map((i) => i.text),
          notRetested: toCoachItems(note.notRetested).map((i) => i.text),
          nextPlan: note.nextPlan,
          model: note.modelId ? { modelId: note.modelId, latencyMs: note.modelLatencyMs } : null,
        }
      : null,
    latestSession: latestSession
      ? { id: latestSession.id, rubricHeatmap: latestSession.rubricHeatmap, score: typeof latestSession.summary?.score === "number" ? latestSession.summary.score : null }
      : null,
  };
}
