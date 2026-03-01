import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { logCost, getCosts, getTotalCost } from "../src/lib/cost-tracker.js";

describe("cost-tracker", () => {
  let tmpDir: string;
  let costsPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "costs-test-"));
    costsPath = path.join(tmpDir, "costs.json");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("logCost creates the file and appends an entry", () => {
    logCost(0.01, 1, 500, "test prompt", costsPath);

    expect(fs.existsSync(costsPath)).toBe(true);
    const entries = JSON.parse(fs.readFileSync(costsPath, "utf-8"));
    expect(entries).toHaveLength(1);
    expect(entries[0].costUsd).toBe(0.01);
    expect(entries[0].numTurns).toBe(1);
    expect(entries[0].durationMs).toBe(500);
    expect(entries[0].promptPreview).toBe("test prompt");
  });

  it("logCost appends multiple entries", () => {
    logCost(0.01, 1, 500, "first", costsPath);
    logCost(0.02, 2, 1000, "second", costsPath);

    const entries = JSON.parse(fs.readFileSync(costsPath, "utf-8"));
    expect(entries).toHaveLength(2);
  });

  it("logCost truncates long prompt previews to 100 chars", () => {
    const longPrompt = "a".repeat(200);
    logCost(0.01, 1, 500, longPrompt, costsPath);

    const entries = JSON.parse(fs.readFileSync(costsPath, "utf-8"));
    expect(entries[0].promptPreview).toHaveLength(100);
  });

  it("getCosts returns all entries for 'all' period", () => {
    logCost(0.01, 1, 500, "one", costsPath);
    logCost(0.02, 2, 1000, "two", costsPath);

    const costs = getCosts("all", costsPath);
    expect(costs).toHaveLength(2);
  });

  it("getCosts filters by 'today' period", () => {
    logCost(0.05, 1, 500, "today's request", costsPath);

    // Manually add an old entry
    const entries = JSON.parse(fs.readFileSync(costsPath, "utf-8"));
    entries.push({
      timestamp: "2020-01-01T00:00:00.000Z",
      costUsd: 0.10,
      numTurns: 1,
      durationMs: 500,
      promptPreview: "old request",
    });
    fs.writeFileSync(costsPath, JSON.stringify(entries));

    const todayCosts = getCosts("today", costsPath);
    expect(todayCosts).toHaveLength(1);
    expect(todayCosts[0].promptPreview).toBe("today's request");
  });

  it("getTotalCost sums costs for a period", () => {
    logCost(0.01, 1, 500, "one", costsPath);
    logCost(0.02, 2, 1000, "two", costsPath);
    logCost(0.03, 3, 1500, "three", costsPath);

    const total = getTotalCost("all", costsPath);
    expect(total).toBeCloseTo(0.06, 4);
  });

  it("getTotalCost returns 0 for empty file", () => {
    const total = getTotalCost("all", costsPath);
    expect(total).toBe(0);
  });

  it("getCosts handles corrupted JSON gracefully", () => {
    fs.writeFileSync(costsPath, "not json");
    const costs = getCosts("all", costsPath);
    expect(costs).toEqual([]);
  });
});
