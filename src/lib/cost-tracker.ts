/**
 * cost-tracker.ts — Track Claude API usage costs.
 *
 * Appends cost entries to a JSON file (data/costs.json) and provides
 * query functions for cost summaries by period.
 */

import fs from "node:fs";
import path from "node:path";
import { withFileLockSync } from "./filelock.js";

const PROJECT_ROOT = path.resolve(
  import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const DEFAULT_COSTS_PATH = path.join(PROJECT_ROOT, "data", "costs.json");

export interface CostEntry {
  timestamp: string;
  costUsd: number;
  numTurns: number;
  durationMs: number;
  promptPreview: string;
}

type Period = "today" | "week" | "month" | "all";

function ensureFile(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, "[]");
  }
}

function readEntries(filePath: string): CostEntry[] {
  ensureFile(filePath);
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as CostEntry[];
  } catch {
    return [];
  }
}

function writeEntries(filePath: string, entries: CostEntry[]): void {
  ensureFile(filePath);
  fs.writeFileSync(filePath, JSON.stringify(entries, null, 2));
}

function getPeriodStart(period: Period): Date {
  const now = new Date();
  switch (period) {
    case "today": {
      const start = new Date(now);
      start.setHours(0, 0, 0, 0);
      return start;
    }
    case "week": {
      const start = new Date(now);
      start.setDate(start.getDate() - 7);
      start.setHours(0, 0, 0, 0);
      return start;
    }
    case "month": {
      const start = new Date(now);
      start.setDate(start.getDate() - 30);
      start.setHours(0, 0, 0, 0);
      return start;
    }
    case "all":
      return new Date(0);
  }
}

/** Append a cost entry to the costs file. */
export function logCost(
  costUsd: number,
  numTurns: number,
  durationMs: number,
  promptPreview: string,
  costsPath?: string,
): void {
  const filePath = costsPath ?? DEFAULT_COSTS_PATH;
  withFileLockSync(filePath, () => {
    const entries = readEntries(filePath);
    entries.push({
      timestamp: new Date().toISOString(),
      costUsd,
      numTurns,
      durationMs,
      promptPreview: promptPreview.slice(0, 100),
    });
    writeEntries(filePath, entries);
  });
}

/** Get cost entries for a given period. */
export function getCosts(
  period: Period = "all",
  costsPath?: string,
): CostEntry[] {
  const filePath = costsPath ?? DEFAULT_COSTS_PATH;
  const entries = readEntries(filePath);
  const start = getPeriodStart(period);
  return entries.filter((e) => new Date(e.timestamp) >= start);
}

/** Get total cost for a given period. */
export function getTotalCost(
  period: Period = "all",
  costsPath?: string,
): number {
  const entries = getCosts(period, costsPath);
  return entries.reduce((sum, e) => sum + e.costUsd, 0);
}
