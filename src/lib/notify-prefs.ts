/**
 * notify-prefs.ts — Shared notification preference persistence for bot modules.
 *
 * Stores per-user opt-in/opt-out preferences for proactive notifications.
 * Uses atomicWrite for safe concurrent access.
 */

import fs from "node:fs";
import path from "node:path";
import { atomicWrite } from "./filelock.js";

/**
 * Load notification preferences from a JSON file.
 * Returns an empty object if the file does not exist or is malformed.
 */
export function loadNotifyPrefs(prefsPath: string): Record<string, boolean> {
  const dir = path.dirname(prefsPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (fs.existsSync(prefsPath)) {
    try {
      return JSON.parse(fs.readFileSync(prefsPath, "utf-8")) as Record<string, boolean>;
    } catch {
      return {};
    }
  }
  return {};
}

/**
 * Save notification preferences to a JSON file using atomic writes.
 */
export function saveNotifyPrefs(prefsPath: string, prefs: Record<string, boolean>): void {
  const dir = path.dirname(prefsPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  atomicWrite(prefsPath, JSON.stringify(prefs, null, 2));
}
