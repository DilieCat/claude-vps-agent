/**
 * session-store.ts — Track Claude Code session IDs per user for conversation continuity.
 *
 * Each user (identified by platform + user_id) gets a persistent session.
 * When they send a message, we resume their session instead of starting fresh.
 */

import fs from "node:fs";
import path from "node:path";
import { withFileLockSync, atomicWrite } from "./filelock.js";

const PROJECT_ROOT = path.resolve(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname), "..", "..");
const DEFAULT_STORE_PATH = path.join(PROJECT_ROOT, "data", "sessions.json");

/** Sessions older than this are expired (7 days). */
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

interface SessionEntry {
  session_id: string;
  platform: string;
  user_id: string;
  updated_at: number;
}

type SessionData = Record<string, SessionEntry>;

export class SessionStore {
  readonly path: string;

  constructor(storePath?: string) {
    this.path = storePath ?? DEFAULT_STORE_PATH;
    const dir = path.dirname(this.path);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  private load(): SessionData {
    if (!fs.existsSync(this.path)) return {};
    try {
      const raw = fs.readFileSync(this.path, "utf-8");
      return JSON.parse(raw) as SessionData;
    } catch {
      return {};
    }
  }

  private save(data: SessionData): void {
    atomicWrite(this.path, JSON.stringify(data, null, 2));
  }

  private key(platform: string, userId: string): string {
    return `${platform}:${userId}`;
  }

  /** Get the session ID for a user, or null if no active session. */
  get(platform: string, userId: string): string | null {
    const k = this.key(platform, userId);
    return withFileLockSync(this.path, () => {
      const data = this.load();
      const entry = data[k];
      if (!entry) return null;

      // Check TTL
      if (Date.now() / 1000 - (entry.updated_at ?? 0) > SESSION_TTL_SECONDS) {
        delete data[k];
        this.save(data);
        return null;
      }

      return entry.session_id;
    });
  }

  /** Store or update a session ID for a user. */
  set(platform: string, userId: string, sessionId: string): void {
    const k = this.key(platform, userId);
    withFileLockSync(this.path, () => {
      const data = this.load();
      data[k] = {
        session_id: sessionId,
        platform,
        user_id: userId,
        updated_at: Date.now() / 1000,
      };
      this.save(data);
    });
  }

  /** Remove a user's session (start fresh next time). */
  clear(platform: string, userId: string): void {
    const k = this.key(platform, userId);
    withFileLockSync(this.path, () => {
      const data = this.load();
      delete data[k];
      this.save(data);
    });
  }

  /** Remove all sessions. */
  clearAll(): void {
    withFileLockSync(this.path, () => {
      this.save({});
    });
  }

  /** Remove all expired sessions. Returns number removed. */
  cleanupExpired(): number {
    const nowSec = Date.now() / 1000;
    return withFileLockSync(this.path, () => {
      const data = this.load();
      const expired = Object.keys(data).filter(
        (k) => nowSec - (data[k].updated_at ?? 0) > SESSION_TTL_SECONDS
      );
      for (const k of expired) {
        delete data[k];
      }
      if (expired.length > 0) {
        this.save(data);
      }
      return expired.length;
    });
  }
}
