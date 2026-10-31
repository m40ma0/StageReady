import { ANSWER_MAX_WORDS, MIN_QUESTIONS, formatSeconds, wordCount, type BankQuestion, type PersonaRole, type SlideSnapshot } from "@stage-ready/shared";

// Evidence Q&A Kit, deterministic parts: the question bank behind the mocked adapter, and the
// slide data built from stored measurements. Numbers on a slide only ever come from here.

export interface QaContext {
  projectName: string;
  criteria: { name: string; description: string; weight: number }[];
  claims: { text: string; type: string; status: string; evidence: string | null }[];
  findings: { kind: string; summary: string; ref: string }[];
  personas: { role: PersonaRole; questionStyle: string }[];
  weakSpots: { key: string; text: string }[];
  latency: { stepKey: string; n: number; p50: number | null; p95: number | null }[];
}

const ROLE_FOR: [RegExp, PersonaRole][] = [
  [/tech|implement|engineer|architect|complex|code|execution|quality/i, "technical"],
  [/impact|social|real[- ]world|outcome|benefit|sustain/i, "impact"],
  [/product|design|ux|user|market|business|present|pitch|origin|creativ|novel/i, "product"],
];
const roleFor = (text: string): PersonaRole | null => ROLE_FOR.find(([re]) => re.test(text))?.[1] ?? null;

/** Trims a script to the word cap at a sentence boundary when possible. */
export function capWords(text: string, max = ANSWER_MAX_WORDS): string {
  if (wordCount(text) <= max) return text.trim();
  const sentences = text.trim().split(/(?<=[.!?])\s+/);
  let out = "";
  for (const s of sentences) {
    const next = out ? `${out} ${s}` : s;
    if (wordCount(next) > max) break;
    out = next;
  }
  return out || text.trim().split(/\s+/).slice(0, max).join(" ");
}

const runs = (n: number) => `${n} ${n === 1 ? "run" : "runs"}`;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const unquote = (s: string) => s.replace(/[.!?]+$/, "").replace(/"/g, "'");
const bridgeFor = (project: string) => clip(`That is why ${project} turns every report into a plan someone owns.`, 120);

function q(text: string, role: PersonaRole | null, likelihood: number, damage: number, refs: string[], script: string, bridge: string, evidence: string[], artifact: string | null): BankQuestion {
  return {
    text: clip(text, 300),
    personaRole: role,
    likelihood: Math.round(Math.min(1, Math.max(0, likelihood)) * 100) / 100,
    damage: Math.round(Math.min(1, Math.max(0, damage)) * 100) / 100,
    sourceRefs: refs.slice(0, 6),
    card: { script: capWords(script), bridgeLine: clip(bridge, 120), evidenceRefs: evidence },
    suggestedArtifact: artifact,
  };
}

/** A ranked question bank of at least 20 questions from criteria, claims, repo findings, personas and past sessions. */
export function heuristicQuestionBank(ctx: QaContext): BankQuestion[] {
  const out: BankQuestion[] = [];
  const bridge = bridgeFor(ctx.projectName);
  const slowest = [...ctx.latency].filter((l) => l.p95 !== null).sort((a, b) => (b.p95 ?? 0) - (a.p95 ?? 0))[0];

  for (const c of ctx.claims) {
    const claim = unquote(c.text);
    if (c.status === "contradicted") {
      const step = c.type === "performance" ? slowest : undefined;
      const script = step
        ? `You are right to ask. We measured it: ${step.stepKey.replace(/_/g, " ")} takes ${formatSeconds(step.p50 ?? 0)} at the median and ${formatSeconds(step.p95 ?? 0)} at p95 over ${runs(step.n)}. We no longer call it instant; we show the timer live.`
        : `We overstated that. The evidence says otherwise: ${c.evidence ?? "the check failed"}. Here is what the product does today, and what we will change before the next demo.`;
      out.push(
        q(
          `You said "${claim}". The data says otherwise. Which is it?`,
          c.type === "performance" ? "technical" : roleFor(c.type),
          0.9,
          0.95,
          [`claim:${claim}`],
          script,
          bridge,
          step ? [`latency:${step.stepKey}`] : c.evidence ? [`claim:${claim}`] : [],
          null,
        ),
      );
    } else if (c.status === "unverified" && /\d/.test(c.text)) {
      const artifact = c.type === "accuracy" ? "eval/accuracy_eval.py with a results file" : c.type === "scale" ? "a load test script and its results" : "a measurement script and its results";
      out.push(
        q(
          `How did you measure "${claim}"?`,
          "technical",
          0.85,
          0.85,
          [`claim:${claim}`],
          `We have not published a measurement for that yet, so treat it as a target, not a result. We are adding ${artifact} to the repo, and the number will come from it.`,
          bridge,
          [],
          artifact,
        ),
      );
    } else if (c.status === "not_shown") {
      out.push(
        q(
          `You mentioned "${claim}" but we did not see it. Can you show it?`,
          "product",
          0.7,
          0.7,
          [`claim:${claim}`],
          `It is not in the demo build yet. What you saw end to end is the core flow. We will show "${clip(claim, 60)}" once it works, or drop the line.`,
          bridge,
          [],
          "a recorded demo of the feature",
        ),
      );
    }
  }

  for (const f of ctx.findings.filter((x) => x.kind === "todo" || x.kind === "mock_response").slice(0, 4)) {
    const what = f.kind === "todo" ? "unfinished work" : "a hard-coded response";
    out.push(
      q(
        `The repo shows ${what} at ${f.ref}. Is that part of what you demoed?`,
        "technical",
        0.6,
        0.8,
        [`repo:${f.ref}`],
        `Yes, ${f.ref} is ${f.summary.toLowerCase().replace(/\.$/, "")}. The live path you saw does not depend on it, and the open work is listed in our README.`,
        bridge,
        [`repo:${f.ref}`],
        null,
      ),
    );
  }

  for (const step of ctx.latency.filter((l) => l.p50 !== null)) {
    out.push(
      q(
        `How long does ${step.stepKey.replace(/_/g, " ")} take in practice?`,
        "technical",
        0.5 + ((step.p95 ?? 0) > 2_000 ? 0.25 : 0),
        (step.p95 ?? 0) > 2_000 ? 0.6 : 0.3,
        [`latency:${step.stepKey}`],
        `We measured it on every rehearsal: ${formatSeconds(step.p50 ?? 0)} at the median and ${formatSeconds(step.p95 ?? 0)} at p95, over ${runs(step.n)}. The number on screen comes from those runs, not from a benchmark.`,
        bridge,
        [`latency:${step.stepKey}`],
        null,
      ),
    );
  }

  for (const c of [...ctx.criteria].sort((a, b) => b.weight - a.weight)) {
    const role = roleFor(`${c.name} ${c.description}`);
    const weak = ctx.weakSpots.some((w) =>
      w.key.includes(
        c.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, " ")
          .trim(),
      ),
    );
    out.push(
      q(
        `Judged on ${c.name}: what is the single strongest piece of evidence for it?`,
        role,
        0.4 + c.weight,
        weak ? 0.7 : 0.45,
        [`criterion:${c.name}`],
        weak
          ? `Our weakest area so far. In rehearsal we covered ${c.name.toLowerCase()} least, so here it is directly: ${clip(c.description, 140)}`
          : `For ${c.name.toLowerCase()}, the strongest evidence is what you saw in the demo: ${clip(c.description, 140)}`,
        bridge,
        [`criterion:${c.name}`],
        null,
      ),
    );
  }

  // A persona's style becomes a question only when it is phrased as one.
  for (const p of ctx.personas.filter((x) => /\?\s*$/.test(x.questionStyle.split(/(?<=[.!?])\s+/)[0] ?? ""))) {
    out.push(
      q(
        `${p.questionStyle.split(/(?<=[.!?])\s+/)[0] ?? "What is the hardest part?"}`.replace(/^(\w)/, (m) => m.toUpperCase()),
        p.role,
        0.55,
        0.5,
        [`persona:${p.role}`],
        "Short answer first: it works end to end today on real reports. The limits are known, they are listed on our README, and the next step is a pilot with a second team.",
        bridge,
        [],
        null,
      ),
    );
  }

  const generic: [string, PersonaRole, number, number, string, string | null][] = [
    [
      "What happens when the model gets a report wrong?",
      "technical",
      0.8,
      0.8,
      "A coordinator reviews every plan before it is sent, so a wrong extraction is caught by a person. We log each correction and use them as test cases.",
      "a test set of corrected reports",
    ],
    ["Who owns the follow-up when the system is wrong?", "product", 0.7, 0.7, "The coordinator does. Every plan names an owner and a follow-up time, and nothing is sent without their review.", null],
    [
      "How do you protect the personal data in field reports?",
      "impact",
      0.65,
      0.85,
      "Reports stay in the team's own workspace. We do not train on them, and access is limited to the coordinators on that team.",
      "a data handling note in the README",
    ],
    [
      "How did you test that it works on real reports?",
      "technical",
      0.7,
      0.75,
      "We have not run a formal evaluation yet. We tested it on sample reports in rehearsal and are adding an evaluation script with results.",
      "eval/report_extraction_eval.py",
    ],
    [
      "Why not just use a spreadsheet or an existing ticketing tool?",
      "product",
      0.6,
      0.5,
      "Teams already use spreadsheets, and urgent reports still get buried. The difference is triage: urgent reports surface first with an owner attached.",
      null,
    ],
    [
      "What did you build during the event, and what existed before?",
      "technical",
      0.55,
      0.7,
      "Everything you saw was built during the event. The commit history in the repo shows it, with the first commit on day one.",
      null,
    ],
    [
      "Who is your first user, and have they tried it?",
      "product",
      0.6,
      0.6,
      "Field coordinators are the first users. We showed it to one team during the event; a pilot is the next step.",
      "notes from a user session",
    ],
    [
      "How would this scale to a thousand reports a day?",
      "technical",
      0.5,
      0.55,
      "Each report is processed on its own, so it scales out with more workers. We have not load tested a thousand a day yet.",
      "a load test script and its results",
    ],
    [
      "What does it cost to run per report?",
      "product",
      0.4,
      0.45,
      "We have not measured cost per report yet. Model calls are the main cost, and we log them per request, so the number will come from those logs.",
      "a cost-per-report measurement",
    ],
    [
      "What is the biggest risk to this working in the field?",
      "impact",
      0.55,
      0.6,
      "Connectivity. Teams in the field often lose signal, so reports must queue and sync. That is the next thing we will build and test.",
      null,
    ],
    [
      "How will you know it actually helps responders?",
      "impact",
      0.65,
      0.7,
      "We will measure time from report to plan, and how many urgent reports wait overnight, before and after a pilot.",
      "a before and after metric plan",
    ],
    ["What would you build with another month?", "product", 0.45, 0.3, "Offline sync for field teams, an evaluation set from real corrections, and a pilot with a second team.", null],
  ];
  for (const [text, role, l, d, script, artifact] of generic) out.push(q(text, role, l, d, ["generic"], script, bridge, [], artifact));

  const seen = new Set<string>();
  const unique = out.filter((x) => {
    const k = x.text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return unique.sort((a, b) => b.likelihood * b.damage - a.likelihood * a.damage).slice(0, Math.max(MIN_QUESTIONS, 30));
}

export interface SlideData {
  projectName: string;
  latency: QaContext["latency"];
  claimCounts: Record<string, number>;
  coverage: { criterion: string; value: number }[];
  findings: QaContext["findings"];
}

const TIMING = /\b(how long|how fast|how quick|latency|instant(ly)?|seconds?|speed|slow|fast)\b|\d+(\.\d+)?\s?s\b/i;

/**
 * Evidence for a card that cites none: a measured step named in the question or script ("generate summary"),
 * or, for a timing question, the slowest measured step. Null when nothing stored answers it.
 */
export function inferEvidenceRef(text: string, data: Pick<SlideData, "latency">): string | null {
  const measured = data.latency.filter((l) => l.p50 !== null && l.n > 0);
  if (measured.length === 0) return null;
  const lower = text.toLowerCase();
  const named = measured.find((l) => lower.includes(l.stepKey.replace(/_/g, " ").toLowerCase()) || lower.includes(l.stepKey.toLowerCase()));
  if (named) return `latency:${named.stepKey}`;
  if (!TIMING.test(text)) return null;
  const slowest = [...measured].sort((a, b) => (b.p50 ?? 0) - (a.p50 ?? 0))[0]!;
  return `latency:${slowest.stepKey}`;
}

/** Builds a slide's exact numbers from stored data, keyed by the card's first evidence ref (or, failing that, an inferred one). */
export function buildSlideSnapshot(question: string, card: { evidenceRefs: string[]; script?: string }, data: SlideData): SlideSnapshot {
  const ref = card.evidenceRefs[0] ?? inferEvidenceRef(`${question} ${card.script ?? ""}`, data) ?? "";
  const [kind, ...rest] = ref.split(":");
  const value = rest.join(":");
  const title = clip(question, 90);
  if (kind === "latency") {
    const step = data.latency.find((l) => l.stepKey === value);
    const others = data.latency.filter((l) => l.p50 !== null).slice(0, 5);
    return {
      title,
      subtitle: `Measured step latency across rehearsals (${step?.n ?? 0} ${step?.n === 1 ? "run" : "runs"} of ${value.replace(/_/g, " ")})`,
      chart: { kind: "bar", unit: "s", series: others.map((l) => ({ label: l.stepKey.replace(/_/g, " "), value: Math.round((l.p50 ?? 0) / 100) / 10 })) },
      facts: step
        ? [
            { label: "Median", value: formatSeconds(step.p50 ?? 0) },
            { label: "p95", value: formatSeconds(step.p95 ?? 0) },
            { label: "Runs", value: String(step.n) },
          ]
        : [],
      sources: [`latency_samples: ${value}`],
    };
  }
  if (kind === "criterion") {
    return {
      title,
      subtitle: "Criteria coverage in the latest rehearsal (0–100%)",
      chart: { kind: "bar", unit: "%", series: data.coverage.slice(0, 6).map((c) => ({ label: clip(c.criterion, 24), value: Math.round(c.value * 100) })) },
      facts: [{ label: value, value: `${Math.round((data.coverage.find((c) => c.criterion === value)?.value ?? 0) * 100)}%` }],
      sources: ["session rubric heatmap"],
    };
  }
  if (kind === "repo") {
    const f = data.findings.find((x) => x.ref === value);
    return {
      title,
      subtitle: `From the analysed repository at ${value}`,
      chart: { kind: "none", unit: "", series: [] },
      facts: f ? [{ label: f.kind.replace(/_/g, " "), value: clip(f.summary, 60) }] : [],
      sources: [value],
    };
  }
  const counts = Object.entries(data.claimCounts).filter(([, n]) => n > 0);
  return {
    title,
    subtitle: ref ? `Evidence: ${ref}` : counts.length ? "Claims from the latest rehearsal; no direct measurement yet (a Fix Task tracks it)" : "No measured evidence yet: a Fix Task tracks it",
    chart: counts.length ? { kind: "bar", unit: "", series: counts.map(([status, n]) => ({ label: status.replace(/_/g, " "), value: n })) } : { kind: "none", unit: "", series: [] },
    facts: [],
    sources: counts.length ? ["claim ledger, latest rehearsal"] : [],
  };
}
