import { describe, expect, it } from "vitest";
import { summaryParts } from "../src/session";

describe("summaryParts", () => {
  it("skips what a partial summary lacks instead of printing NaN or undefined", () => {
    expect(summaryParts({ score: 72, modelCostUsd: 0 })).toEqual([]);
    expect(summaryParts({ durationMs: 85_000, interruptions: 1, modelCalls: 4, modelCostUsd: 0.0143, mockedCalls: 0 })).toEqual(["85 s", "1 interruption", "$0.0143 over 4 model calls"]);
  });
});
