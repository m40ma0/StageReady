import { describe, expect, it } from "vitest";
import { buildSlideSnapshot, inferEvidenceRef, type SlideData } from "../src/qa";

const data: SlideData = {
  projectName: "Signal Garden",
  latency: [
    { stepKey: "generate_summary", n: 3, p50: 9_200, p95: 9_800 },
    { stepKey: "load_comparison", n: 3, p50: 640, p95: 700 },
  ],
  claimCounts: { verified: 3, contradicted: 3, unverified: 1 },
  coverage: [],
  findings: [],
};

describe("inferEvidenceRef", () => {
  it("links the step a card names, or the slowest step for a timing question", () => {
    expect(inferEvidenceRef("We measured it: generate summary takes 9.2 s.", data)).toBe("latency:generate_summary");
    expect(inferEvidenceRef("How long does it actually take?", data)).toBe("latency:generate_summary");
    expect(inferEvidenceRef("Who owns follow-up when the system is wrong?", data)).toBeNull();
    expect(inferEvidenceRef("How long does it take?", { latency: [] })).toBeNull();
  });
});

describe("buildSlideSnapshot without cited evidence", () => {
  it("answers a timing question with the measured step, not a claim count", () => {
    const s = buildSlideSnapshot("How long does it actually take?", { evidenceRefs: [], script: "generate summary takes 9.2 s at the median." }, data);
    expect(s.sources).toEqual(["latency_samples: generate_summary"]);
    expect(s.facts[0]).toEqual({ label: "Median", value: "9.2 s" });
  });

  it("labels a claim-count fallback honestly", () => {
    const s = buildSlideSnapshot("Who owns follow-up?", { evidenceRefs: [] }, data);
    expect(s.subtitle).toMatch(/Claims from the latest rehearsal/);
  });
});
