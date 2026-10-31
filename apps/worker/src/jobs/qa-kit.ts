import { buildSlideSnapshot, prompts, type BriefContext, type SlideData } from "@stage-ready/ai";
import {
  answerCards,
  claims,
  coachNotes,
  criteria,
  eventSpecs,
  evidence,
  fixTasks,
  loadRecentLatency,
  personas,
  projects,
  questions,
  repoFindings,
  repos,
  sessions,
  slides as slidesTable,
  winningPatterns,
} from "@stage-ready/db";
import { latencySummary, type JobPayload } from "@stage-ready/shared";
import { and, asc, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { UserFacingError, type JobContext } from "../lib/context";
import { cachedArtwork, modelName } from "../lib/artwork";
import { renderVerifiedSlide, slidesPdf } from "../lib/slides";

type QuestionsPayload = Extract<JobPayload, { name: "questions" }>;
type SlidesPayload = Extract<JobPayload, { name: "slides" }>;

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

async function latencyStats(ctx: JobContext, projectId: string) {
  const rows = await loadRecentLatency(ctx.db, projectId);
  return [...new Set(rows.map((r) => r.stepKey))].map((stepKey) => ({ stepKey, ...latencySummary(rows.filter((r) => r.stepKey === stepKey).map((r) => r.durationMs)) }));
}

async function recentSessions(ctx: JobContext, projectId: string, limit: number) {
  return ctx.db
    .select()
    .from(sessions)
    .where(and(eq(sessions.projectId, projectId), isNotNull(sessions.endedAt)))
    .orderBy(desc(sessions.startedAt))
    .limit(limit);
}

const findingRef = (f: { filePath: string; line: number | null }) => (f.line ? `${f.filePath}:${f.line}` : f.filePath);

/** Rebuilds the ranked question bank and answer cards, turns evidence gaps into Fix Tasks, then renders the slides. */
export async function questionBank(payload: QuestionsPayload, ctx: JobContext) {
  const [project] = await ctx.db.select().from(projects).where(eq(projects.id, payload.projectId));
  if (!project) throw new UserFacingError("Project not found.");
  await ctx.progress({ pct: 5, step: "Collecting criteria, claims, repo findings and past sessions" });
  const [spec] = await ctx.db.select({ id: eventSpecs.id, name: eventSpecs.name }).from(eventSpecs).where(eq(eventSpecs.projectId, project.id));
  const recent = await recentSessions(ctx, project.id, 3);
  // The brief reads more: every session's outcome, the winning patterns, the repo and the memory.
  const [allSessions, patternRows, [repo], memory] = await Promise.all([
    recentSessions(ctx, project.id, 20),
    ctx.db.select({ statement: winningPatterns.statement }).from(winningPatterns).where(eq(winningPatterns.projectId, project.id)),
    ctx.db.select({ readme: repos.readme }).from(repos).where(eq(repos.projectId, project.id)),
    ctx.db.select().from(coachNotes).where(eq(coachNotes.projectId, project.id)).orderBy(desc(coachNotes.createdAt)).limit(10),
  ]);
  const sessionClaims = allSessions.length
    ? await ctx.db
        .select({ sessionId: claims.sessionId, text: claims.text, status: claims.status })
        .from(claims)
        .where(
          and(
            eq(claims.projectId, project.id),
            inArray(
              claims.sessionId,
              allSessions.map((s) => s.id),
            ),
          ),
        )
    : [];
  const sessionIds = recent.map((s) => s.id);
  const [criteriaRows, claimRows, findingRows, personaRows, notes, latency] = await Promise.all([
    spec ? ctx.db.select().from(criteria).where(eq(criteria.eventSpecId, spec.id)).orderBy(asc(criteria.order)) : Promise.resolve([]),
    sessionIds.length
      ? ctx.db
          .select({ claim: claims, summary: evidence.summary })
          .from(claims)
          .leftJoin(evidence, eq(evidence.claimId, claims.id))
          .where(and(eq(claims.projectId, project.id), inArray(claims.sessionId, sessionIds)))
      : Promise.resolve([]),
    ctx.db.select().from(repoFindings).where(eq(repoFindings.projectId, project.id)),
    ctx.db.select().from(personas).where(eq(personas.projectId, project.id)),
    ctx.db.select().from(coachNotes).where(eq(coachNotes.projectId, project.id)).orderBy(desc(coachNotes.createdAt)).limit(1),
    latencyStats(ctx, project.id),
  ]);
  const seenClaims = new Set<string>();
  const input: BriefContext = {
    projectName: project.name,
    eventName: spec?.name || null,
    winningPatterns: patternRows.map((p) => p.statement),
    submission: project.submissionText || null,
    readme: repo?.readme ?? null,
    repoCapabilities: findingRows.filter((f) => f.kind === "capability").map((f) => ({ ref: findingRef(f), summary: f.summary })),
    sessions: allSessions.map((s) => ({
      when: (s.startedAt ?? s.createdAt).toISOString(),
      score: typeof s.summary?.score === "number" ? s.summary.score : null,
      contradicted: sessionClaims.filter((c) => c.sessionId === s.id && c.status === "contradicted").map((c) => c.text),
      notShown: sessionClaims.filter((c) => c.sessionId === s.id && c.status === "not_shown").map((c) => c.text),
    })),
    coachNotes: memory.map((n) => ({ when: n.createdAt.toISOString(), open: [...n.open, ...n.newIssues].map((i) => i.text), notRetested: n.notRetested.map((i) => i.text), nextPlan: n.nextPlan })),
    criteria: criteriaRows.map((c) => ({ name: c.name, description: c.description, weight: c.weight })),
    claims: claimRows
      .filter((r) => !seenClaims.has(norm(r.claim.text)) && Boolean(seenClaims.add(norm(r.claim.text))))
      .map((r) => ({ text: r.claim.text, type: r.claim.type, status: r.claim.status, evidence: r.summary })),
    findings: findingRows.map((f) => ({ kind: f.kind, summary: f.summary, ref: findingRef(f) })),
    personas: personaRows.map((p) => ({ role: p.role, questionStyle: p.questionStyle })),
    weakSpots: [...(notes[0]?.open ?? []), ...(notes[0]?.newIssues ?? [])].map((i) => ({ key: i.key, text: i.text })),
    latency,
  };

  await ctx.progress({ pct: 20, step: "Muse Wonder is reading everything: the brief, likely questions and answer cards" });
  const ai = await ctx.aiFor(project.id);
  const { value, modelId, latencyMs } = await ai.llm.generateObject(prompts.questionBankV2(input));
  await ctx.db
    .update(projects)
    .set({ prePitchBrief: { brief: value.brief, modelId, latencyMs: Math.round(latencyMs), createdAt: new Date().toISOString() } })
    .where(eq(projects.id, project.id));

  // Evidence refs must point at data that exists; anything else is dropped, not trusted.
  const known = new Set([
    ...latency.map((l) => `latency:${l.stepKey}`),
    ...input.criteria.map((c) => `criterion:${c.name}`),
    ...input.findings.map((f) => `repo:${f.ref}`),
    ...input.claims.map((c) => `claim:${c.text.replace(/[.!?]+$/, "").replace(/"/g, "'")}`),
  ]);
  const bank = value.questions.map((q) => ({ ...q, card: { ...q.card, evidenceRefs: q.card.evidenceRefs.filter((r) => known.has(r)) } }));

  await ctx.progress({ pct: 45, step: "Saving the question bank" });
  const personaByRole = new Map(personaRows.map((p) => [p.role, p.id]));
  const cardIds = await ctx.db.transaction(async (tx) => {
    const existing = await tx.select().from(questions).where(eq(questions.projectId, project.id));
    const byText = new Map(existing.map((q) => [norm(q.text), q]));
    const keep = new Set<string>();
    const ids: string[] = [];
    for (const q of bank) {
      const values = {
        text: q.text,
        personaId: q.personaRole ? (personaByRole.get(q.personaRole) ?? null) : null,
        likelihood: q.likelihood,
        damage: q.damage,
        sourceRefs: q.sourceRefs,
        modelId,
        modelLatencyMs: Math.round(latencyMs),
      };
      const prior = byText.get(norm(q.text));
      // Drill history (askedCount, lastScore) survives a rebuild for the same question.
      const [row] = prior
        ? await tx.update(questions).set(values).where(eq(questions.id, prior.id)).returning()
        : await tx
            .insert(questions)
            .values({ projectId: project.id, ...values })
            .returning();
      if (!row) continue;
      keep.add(row.id);
      const [card] = await tx
        .insert(answerCards)
        .values({ projectId: project.id, questionId: row.id, ...q.card })
        .onConflictDoUpdate({ target: answerCards.questionId, set: q.card })
        .returning({ id: answerCards.id });
      if (card) ids.push(card.id);
    }
    const stale = existing.filter((q) => !keep.has(q.id)).map((q) => q.id);
    if (stale.length) await tx.delete(questions).where(inArray(questions.id, stale));

    // Gap to task: a question without evidence becomes a Fix Task with the suggested artefact.
    const open = await tx
      .select({ title: fixTasks.title })
      .from(fixTasks)
      .where(and(eq(fixTasks.projectId, project.id), eq(fixTasks.origin, "question")));
    const have = new Set(open.map((t) => norm(t.title)));
    for (const q of bank.filter((x) => x.card.evidenceRefs.length === 0 && x.suggestedArtifact)) {
      const title = `Add evidence for: ${q.text}`.slice(0, 200);
      if (have.has(norm(title))) continue;
      have.add(norm(title));
      await tx.insert(fixTasks).values({
        projectId: project.id,
        title,
        detail: "A judge is likely to ask this, and nothing in the project proves the answer yet.",
        origin: "question",
        suggestedArtifact: q.suggestedArtifact,
      });
    }
    return ids;
  });

  const rendered = await renderSlides({ name: "slides", projectId: project.id, answerCardIds: cardIds }, ctx, { from: 50 });
  return { questions: bank.length, gaps: bank.filter((q) => q.card.evidenceRefs.length === 0).length, ...rendered };
}

/** Renders and verifies evidence slides, then rebuilds the PDF appendix. */
export async function renderSlides(payload: SlidesPayload, ctx: JobContext, options: { from?: number } = {}) {
  const from = options.from ?? 0;
  const [project] = await ctx.db.select().from(projects).where(eq(projects.id, payload.projectId));
  if (!project) throw new UserFacingError("Project not found.");
  const cards = await ctx.db
    .select({ card: answerCards, question: questions })
    .from(answerCards)
    .innerJoin(questions, eq(questions.id, answerCards.questionId))
    .where(and(eq(answerCards.projectId, project.id), payload.answerCardIds?.length ? inArray(answerCards.id, payload.answerCardIds) : undefined));

  const [latest] = await recentSessions(ctx, project.id, 1);
  const [latency, findingRows, claimRows] = await Promise.all([
    latencyStats(ctx, project.id),
    ctx.db.select().from(repoFindings).where(eq(repoFindings.projectId, project.id)),
    latest ? ctx.db.select({ status: claims.status }).from(claims).where(eq(claims.sessionId, latest.id)) : Promise.resolve([]),
  ]);
  const heatmap = latest?.rubricHeatmap ?? {};
  const data: SlideData = {
    projectName: project.name,
    latency,
    claimCounts: claimRows.reduce<Record<string, number>>((acc, c) => ({ ...acc, [c.status]: (acc[c.status] ?? 0) + 1 }), {}),
    coverage: Object.entries(heatmap).map(([criterion, bySection]) => {
      const values = Object.values(bySection as Record<string, number>);
      return { criterion, value: values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0 };
    }),
    findings: findingRows.map((f) => ({ kind: f.kind, summary: f.summary, ref: findingRef(f) })),
  };

  const ai = await ctx.aiFor(project.id);
  // Muse Image paints the deck background once (shared by every Demo Mode project); numbers are still drawn by the renderer.
  await ctx.progress({ pct: from, step: "Painting the slide background with Muse Image" });
  const artwork = await cachedArtwork(
    ctx,
    ai,
    project.demoMode ? "demo/slides/muse-background" : `projects/${project.id}/slides/muse-background`,
    `Abstract, minimal 16:9 background for presentation slides about ${project.tagline || project.name}. Dark and moody, with visible indigo and violet light, soft glowing gradients and a few bold abstract shapes toward the right edge; keep the left half calmer. No text, no letters, no numbers, no logos, no people.`,
  );
  const art = artwork ? { dataUrl: `data:${artwork.mime};base64,${Buffer.from(artwork.bytes).toString("base64")}`, caption: `Image: ${modelName(artwork.modelId)}` } : null;
  const results = { passed: 0, fallback: 0 };
  for (const [i, { card, question }] of cards.entries()) {
    await ctx.progress({ pct: Math.round(from + ((100 - from) * 0.9 * i) / Math.max(1, cards.length)), step: `Rendering slide ${i + 1} of ${cards.length}` });
    const snapshot = buildSlideSnapshot(question.text, card, data);
    const { png, verification, missing, error } = await renderVerifiedSlide(
      snapshot,
      async (image, text) => (await ai.llm.generateObject(prompts.slideVerifyV1({ png: image, renderedText: text }))).value.numbers,
      art,
    );
    if (verification === "fallback") ctx.logger.warn({ answerCardId: card.id, missing, err: error }, "slide verification did not pass; using the fallback template");
    const pngUrl = await ctx.storage.put(`projects/${project.id}/slides/${card.id}.png`, png, "image/png");
    await ctx.db.transaction(async (tx) => {
      await tx.delete(slidesTable).where(eq(slidesTable.answerCardId, card.id));
      await tx.insert(slidesTable).values({ projectId: project.id, answerCardId: card.id, pngUrl, dataSnapshot: snapshot, verification });
    });
    results[verification]++;
  }

  await ctx.progress({ pct: 95, step: "Building the PDF appendix" });
  const all = await ctx.db
    .select({ slide: slidesTable, likelihood: questions.likelihood, damage: questions.damage })
    .from(slidesTable)
    .innerJoin(answerCards, eq(answerCards.id, slidesTable.answerCardId))
    .innerJoin(questions, eq(questions.id, answerCards.questionId))
    .where(eq(slidesTable.projectId, project.id));
  all.sort((a, b) => b.likelihood * b.damage - a.likelihood * a.damage);
  const pngs = (await Promise.all(all.map((s) => (s.slide.pngUrl ? ctx.storage.get(s.slide.pngUrl) : null)))).filter((p): p is Uint8Array => p !== null);
  const pdfUrl = await ctx.storage.put(`projects/${project.id}/qa-kit/appendix.pdf`, await slidesPdf(pngs), "application/pdf");
  await ctx.db.update(slidesTable).set({ pdfUrl }).where(eq(slidesTable.projectId, project.id));
  await ctx.progress({ pct: 100, step: "Slides ready" });
  return { slides: cards.length, ...results, pdfUrl, imageModel: artwork?.modelId ?? null };
}
