import { heuristicQuestionBank, scoreTranscribedTake } from "@stage-ready/ai";
import { and, eq } from "drizzle-orm";
import { DbEnv, loadRootEnv, parseEnv } from "@stage-ready/config";
import {
  DEMO_FALLBACK_CLIP,
  DEMO_STRONGEST_MOMENT,
  DEMO_PROJECT_NAME,
  PERSONA_ROLE_LABEL,
  autoSectionPlan,
  demoEventSpec,
  demoPatterns,
  demoPersonas,
  demoRubricHeatmap,
  demoPitchScript,
  demoReadme,
  demoSubmissionText,
  demoRepo,
  demoSession,
  demoSteps,
  demoTakeScripts,
  demoTakes,
  demoWinners,
  buildAutoEdl,
  latencySummary,
  mapSegments,
  spreadWords,
  takeWeightsFrom,
  type DemoVoice,
} from "@stage-ready/shared";
import { uuidv7 } from "uuidv7";
import { auditFactsFrom } from "./facts";
import { createDb, type Db } from "./index";
import * as t from "./schema";

export const DEV_USER = { email: "dev@stage-ready.local", name: "Local developer", githubLogin: null };

export async function ensureDevUser(db: Db) {
  const [existing] = await db.select().from(t.users).where(eq(t.users.email, DEV_USER.email));
  if (existing) return existing;
  const [created] = await db.insert(t.users).values(DEV_USER).returning();
  if (!created) throw new Error("Could not create the local developer user.");
  return created;
}

const DEMO_VIDEO_LIMIT_SEC = 180;

/**
 * Every Demo Mode row for `ownerId`, built in memory with pre-generated ids, so the seed can write one insert
 * per table. Scoring, audit facts and the question bank run here, before any transaction opens.
 */
export function buildDemoRows(ownerId: string, voice: DemoVoice | null = null) {
  const projectId = uuidv7();
  const project = {
    id: projectId,
    ownerId,
    name: DEMO_PROJECT_NAME,
    tagline: "Turn noisy field reports into a clear response plan.",
    videoLimitSec: DEMO_VIDEO_LIMIT_SEC,
    timezone: "Asia/Singapore",
    demoMode: true,
    pitchScript: demoPitchScript,
    submissionText: demoSubmissionText,
    strongestMoment: DEMO_STRONGEST_MOMENT,
    setupStep: 5,
  } satisfies typeof t.projects.$inferInsert;

  const specId = uuidv7();
  const eventSpec = {
    id: specId,
    projectId,
    name: demoEventSpec.name,
    sourceUrls: [],
    tracks: demoEventSpec.tracks,
    requirements: demoEventSpec.requirements,
    requiredTech: demoEventSpec.requiredTech,
    deadlineAt: demoEventSpec.requirements.deadlineIso ? new Date(demoEventSpec.requirements.deadlineIso) : null,
    weightsInferred: demoEventSpec.weightsInferred,
    sourceQuotes: demoEventSpec.sourceQuotes,
    peopleNamed: demoEventSpec.peopleNamed,
    confirmedAt: new Date(),
  } satisfies typeof t.eventSpecs.$inferInsert;
  const criteria = demoEventSpec.criteria.map((c, order) => ({
    id: uuidv7(),
    projectId,
    eventSpecId: specId,
    order,
    name: c.name,
    description: c.description,
    weight: c.weight,
    sourceQuote: demoEventSpec.sourceQuotes[`criteria.${order}`] ?? null,
  })) satisfies (typeof t.criteria.$inferInsert)[];

  const pastWinners = demoWinners.map((w) => ({
    projectId,
    sourceUrl: w.sourceUrl,
    title: w.profile.title,
    placement: w.profile.placement,
    profile: w.profile,
  })) satisfies (typeof t.pastWinners.$inferInsert)[];
  const winningPatterns = demoPatterns.map((p) => ({ projectId, ...p })) satisfies (typeof t.winningPatterns.$inferInsert)[];

  const repoId = uuidv7();
  const repo = {
    id: repoId,
    projectId,
    githubFullName: demoRepo.githubFullName,
    commitSha: demoRepo.commitSha,
    visibility: demoRepo.visibility,
    fileCount: 38,
    digestTokens: 21_400,
    readme: demoReadme,
    dependencies: [{ name: "generative-ai-sdk (fictional)", version: "1.0.0", manifest: "package.json" }],
  } satisfies typeof t.repos.$inferInsert;
  const repoFindings = demoRepo.findings.map((f) => ({ projectId, repoId, ...f })) satisfies (typeof t.repoFindings.$inferInsert)[];

  const personas = demoPersonas.map((p) => ({ id: uuidv7(), projectId, ...p })) satisfies (typeof t.personas.$inferInsert)[];
  const personaByRole = new Map<string, string>(personas.map((p) => [p.role, p.id]));

  const sections = autoSectionPlan(DEMO_VIDEO_LIMIT_SEC).map((s, order) => ({ id: uuidv7(), projectId, order, ...s })) satisfies (typeof t.sectionPlans.$inferInsert)[];

  const sessionId = uuidv7();
  const started = new Date(Date.now() - 2 * 86_400_000);
  const session = {
    id: sessionId,
    projectId,
    mode: demoSession.mode,
    startedAt: started,
    endedAt: new Date(started.getTime() + demoSession.durationMs),
    recordingUrl: voice ? voice.audioUrl : "demo/rehearsal-1.webm",
    summary: {
      score: 72,
      modelCostUsd: 0,
      // With the bundled recording transcribed, the seeded rehearsal reads like a real one; otherwise it is the fixture text.
      transcript: voice ? { source: "muse", modelId: voice.modelId, latencyMs: voice.latencyMs } : { source: "scripted" },
    },
    rubricHeatmap: demoRubricHeatmap,
  } satisfies typeof t.sessions.$inferInsert;

  // The scripted lines; claims, the question bank and scoring always read these.
  const lines = demoSession.transcript.map((text, i) => ({ id: String(i), text, startMs: 12_000 + i * 15_000, endMs: 12_000 + i * 15_000 + 4_000 }));
  const segments = (
    voice
      ? voice.turns.map((turn) => ({
          startMs: turn.startMs,
          endMs: turn.endMs,
          text: turn.text,
          words: spreadWords(turn.text, turn.endMs - turn.startMs, 0).map((w) => ({ ...w, startMs: w.startMs + turn.startMs, endMs: w.endMs + turn.startMs })),
        }))
      : lines.map((l) => ({ startMs: l.startMs, endMs: l.endMs, text: l.text, words: [] }))
  ).map((seg) => ({ id: uuidv7(), projectId, sessionId, speaker: "presenter", ...seg })) satisfies (typeof t.transcriptSegments.$inferInsert)[];
  // Each claim points at the segment that holds its line: the same index without a recording, or the Muse turn that overlaps it.
  const lineToSegment = voice
    ? mapSegments(
        voice.lines.map((l, i) => ({ id: String(i), ...l })),
        segments,
      )
    : new Map(lines.map((l, i) => [l.id, segments[i]!.id]));
  const claims = demoSession.claims.map((c, i) => ({
    id: uuidv7(),
    projectId,
    sessionId,
    segmentId: lineToSegment.get(String(i)) ?? null,
    text: lines[i]?.text ?? "",
    type: c.type,
    status: c.status,
    confidence: c.status === "unverified" ? 0.4 : 0.9,
    suggestedRewrite: c.rewrite,
  })) satisfies (typeof t.claims.$inferInsert)[];
  const evidence = demoSession.claims.map((c, i) => ({
    projectId,
    claimId: claims[i]!.id,
    kind: c.evidence.kind,
    ref: { value: c.evidence.ref },
    summary: c.evidence.summary,
  })) satisfies (typeof t.evidence.$inferInsert)[];
  const latencySamples = demoSession.latency.map(([stepKey, durationMs], i) => ({
    projectId,
    sessionId,
    stepKey,
    startMs: 40_000 + i * 20_000,
    endMs: 40_000 + i * 20_000 + durationMs,
    durationMs,
    detector: "fixture",
  })) satisfies (typeof t.latencySamples.$inferInsert)[];
  const judgeTurns = demoSession.judgeTurns.map((j) => ({
    projectId,
    sessionId,
    personaId: personaByRole.get(j.role) ?? null,
    atMs: j.atMs,
    kind: "question" as const,
    text: j.text,
    trigger: j.trigger,
  })) satisfies (typeof t.judgeTurns.$inferInsert)[];

  // Twelve fixture takes, two per section, transcribed and scored like recorded ones.
  const scoring = {
    criteria: criteria.map((c) => ({ id: c.id, name: c.name, description: c.description })),
    latency: demoSession.latency.map(([stepKey, durationMs], i) => ({ stepKey, startMs: 40_000 + i * 20_000, durationMs })),
    ...auditFactsFrom(repo, repoFindings, project.submissionText),
    weights: takeWeightsFrom(process.env.TAKE_SCORE_WEIGHTS),
  };
  const takes: (typeof t.takes.$inferInsert)[] = [];
  const takeScores: (typeof t.takeScores.$inferInsert)[] = [];
  const candidates = [];
  for (const section of sections) {
    for (const [i, durationMs] of demoTakes[section.key].entries()) {
      const text = demoTakeScripts[section.key][i] ?? "";
      const words = spreadWords(text, durationMs);
      const takeId = uuidv7();
      takes.push({ id: takeId, projectId, sectionPlanId: section.id, sessionId, mediaUrl: `demo/${section.key}-${i + 1}.webm`, durationMs, transcript: { text, words }, status: "ready" });
      const { contradictedClaims, ...score } = scoreTranscribedTake({ text, words, durationMs, budgetSec: section.budgetSec }, scoring);
      takeScores.push({ projectId, takeId, ...score, breakdown: { ...score.breakdown, contradictedClaims } });
      candidates.push({ id: takeId, sectionKey: section.key, durationMs, score: score.total, valid: true });
    }
  }
  const edl = { projectId, items: buildAutoEdl(sections, candidates, DEMO_VIDEO_LIMIT_SEC).items } satisfies typeof t.edls.$inferInsert;

  const steps = [...new Set(scoring.latency.map((l) => l.stepKey))];
  const bank = heuristicQuestionBank({
    projectName: DEMO_PROJECT_NAME,
    criteria: demoEventSpec.criteria,
    claims: demoSession.claims.map((c, i) => ({ text: lines[i]?.text ?? "", type: c.type, status: c.status, evidence: c.evidence.summary })),
    findings: demoRepo.findings.map((f) => ({ kind: f.kind, summary: f.summary, ref: f.line ? `${f.filePath}:${f.line}` : f.filePath })),
    personas: demoPersonas.map((p) => ({ role: p.role, questionStyle: p.questionStyle })),
    weakSpots: [],
    latency: steps.map((stepKey) => ({ stepKey, ...latencySummary(scoring.latency.filter((l) => l.stepKey === stepKey).map((l) => l.durationMs)) })),
  });
  const questions = bank.map((q) => ({
    id: uuidv7(),
    projectId,
    text: q.text,
    personaId: q.personaRole ? (personaByRole.get(q.personaRole) ?? null) : null,
    likelihood: q.likelihood,
    damage: q.damage,
    sourceRefs: q.sourceRefs,
  })) satisfies (typeof t.questions.$inferInsert)[];
  const answerCards = bank.map((q, i) => ({ projectId, questionId: questions[i]!.id, ...q.card })) satisfies (typeof t.answerCards.$inferInsert)[];

  const stepMapId = uuidv7();
  const stepMap = { id: stepMapId, projectId, goldenRunSessionId: sessionId, fallbackClipUrl: DEMO_FALLBACK_CLIP } satisfies typeof t.stepMaps.$inferInsert;
  const stepRows = demoSteps.map((s, order) => ({ projectId, stepMapId, order, ...s })) satisfies (typeof t.steps.$inferInsert)[];

  const fixTasks = [
    {
      projectId,
      title: "Add an evaluation result for the 92% accuracy claim",
      detail: "No eval file or result supports the number.",
      origin: "claim",
      suggestedArtifact: "eval/classifier_accuracy.py",
    },
    { projectId, title: "Show offline mode or remove the claim", detail: "Offline mode was mentioned but never shown in the demo section.", origin: "claim" },
    { projectId, title: "Reach the response plan reveal before 60 s", detail: "Past winners showed their strongest moment within the first minute.", origin: "pattern" },
  ] satisfies (typeof t.fixTasks.$inferInsert)[];
  const coachNote = {
    projectId,
    sessionId,
    resolved: [{ key: "criterion:problem-statement", text: "Problem statement now names the responder", severity: "medium" }],
    open: [{ key: "claim:the summary is instant", text: 'Fix the contradicted claim "The summary is instant": it took 9.2 s.', severity: "high" }],
    newIssues: [
      { key: "criterion:real world impact", text: "Cover Real-world impact: the judges heard almost nothing about it.", severity: "medium" },
      { key: "pace:hook", text: "The hook runs long before the first demo moment", severity: "medium" },
    ],
    nextPlan: ["Show the offline flow or cut the line", "Add classifier evaluation evidence", "Drill the impact question"],
  } satisfies typeof t.coachNotes.$inferInsert;

  return {
    project,
    eventSpec,
    criteria,
    pastWinners,
    winningPatterns,
    repo,
    repoFindings,
    personas,
    sections,
    session,
    segments,
    claims,
    evidence,
    latencySamples,
    judgeTurns,
    takes,
    takeScores,
    edl,
    questions,
    answerCards,
    stepMap,
    steps: stepRows,
    fixTasks,
    coachNote,
  };
}

/** Replaces the Demo Mode project for `ownerId` with fresh fixtures. Returns its id. One delete plus one insert per table. */
export async function seedDemoProject(db: Db, ownerId: string, options: { voice?: DemoVoice | null } = {}): Promise<string> {
  const r = buildDemoRows(ownerId, options.voice ?? null);
  await db.transaction(async (tx) => {
    await tx.delete(t.projects).where(and(eq(t.projects.ownerId, ownerId), eq(t.projects.demoMode, true)));
    await tx.insert(t.projects).values(r.project);
    await tx.insert(t.eventSpecs).values(r.eventSpec);
    await tx.insert(t.criteria).values(r.criteria);
    await tx.insert(t.pastWinners).values(r.pastWinners);
    await tx.insert(t.winningPatterns).values(r.winningPatterns);
    await tx.insert(t.repos).values(r.repo);
    await tx.insert(t.repoFindings).values(r.repoFindings);
    await tx.insert(t.personas).values(r.personas);
    await tx.insert(t.sectionPlans).values(r.sections);
    await tx.insert(t.sessions).values(r.session);
    await tx.insert(t.transcriptSegments).values(r.segments);
    await tx.insert(t.claims).values(r.claims);
    await tx.insert(t.evidence).values(r.evidence);
    await tx.insert(t.latencySamples).values(r.latencySamples);
    await tx.insert(t.judgeTurns).values(r.judgeTurns);
    await tx.insert(t.takes).values(r.takes);
    await tx.insert(t.takeScores).values(r.takeScores);
    await tx.insert(t.edls).values(r.edl);
    await tx.insert(t.questions).values(r.questions);
    await tx.insert(t.answerCards).values(r.answerCards);
    await tx.insert(t.stepMaps).values(r.stepMap);
    await tx.insert(t.steps).values(r.steps);
    await tx.insert(t.fixTasks).values(r.fixTasks);
    await tx.insert(t.coachNotes).values(r.coachNote);
  });
  return r.project.id;
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  loadRootEnv();
  const env = parseEnv("db", DbEnv);
  const db = createDb(env.DATABASE_URL, { max: 1 });
  try {
    const user = await ensureDevUser(db);
    const projectId = await seedDemoProject(db, user.id);
    console.info(`Demo Mode project seeded (${projectId}) with personas: ${Object.values(PERSONA_ROLE_LABEL).join(", ")}.`);
  } finally {
    await db.close();
  }
}
