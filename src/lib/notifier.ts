/**
 * notifier.ts — Notification queue for the living agent.
 *
 * Stores pending notifications per platform so bots (Telegram, Discord, etc.)
 * can poll and deliver them to users asynchronously.
 *
 * Backed by a JSON file at data/notifications.json.
 */

import fs from "node:fs";
import path from "node:path";
import { withFileLockSync, atomicWrite } from "./filelock.js";

const PROJECT_ROOT = path.resolve(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname), "..", "..");
const DEFAULT_QUEUE_PATH = path.join(PROJECT_ROOT, "data", "notifications.json");

/** A single queued notification. */
export interface Notification {
  platform: string;
  user_id: string | null; // null = broadcast to all users on that platform
  message: string;
  timestamp: string;
  source: string; // e.g. "scheduler:daily-code-review"
}

export class NotificationQueue {
  readonly path: string;

  constructor(queuePath?: string) {
    this.path = queuePath ?? DEFAULT_QUEUE_PATH;
    const dir = path.dirname(this.path);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  private load(): Notification[] {
    if (!fs.existsSync(this.path)) return [];
    try {
      const raw = fs.readFileSync(this.path, "utf-8");
      const data: unknown = JSON.parse(raw);
      return Array.isArray(data) ? (data as Notification[]) : [];
    } catch {
      return [];
    }
  }

  private save(entries: Notification[]): void {
    atomicWrite(this.path, JSON.stringify(entries, null, 2));
  }

  /** Queue a notification for a specific user on a platform. */
  push(platform: string, userId: string, message: string, source = ""): void {
    const notif: Notification = {
      platform,
      user_id: userId,
      message,
      timestamp: new Date().toISOString(),
      source,
    };
    withFileLockSync(this.path, () => {
      const entries = this.load();
      entries.push(notif);
      this.save(entries);
    });
  }

  /** Queue a broadcast notification for all users on a platform. */
  pushBroadcast(platform: string, message: string, source = ""): void {
    const notif: Notification = {
      platform,
      user_id: null,
      message,
      timestamp: new Date().toISOString(),
      source,
    };
    withFileLockSync(this.path, () => {
      const entries = this.load();
      entries.push(notif);
      this.save(entries);
    });
  }

  /** Return and remove all queued notifications for a platform. */
  popAll(platform: string): Notification[] {
    return withFileLockSync(this.path, () => {
      const entries = this.load();
      const matched = entries.filter((e) => e.platform === platform);
      const remaining = entries.filter((e) => e.platform !== platform);
      this.save(remaining);
      return matched;
    });
  }

  /** Peek at all queued notifications for a platform (without removing). */
  peek(platform: string): Notification[] {
    return withFileLockSync(this.path, () => {
      const entries = this.load();
      return entries.filter((e) => e.platform === platform);
    });
  }
}
