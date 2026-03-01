import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { SessionStore } from "../src/lib/session-store.js";

describe("SessionStore", () => {
  let tmpDir: string;
  let storePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-test-"));
    storePath = path.join(tmpDir, "sessions.json");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null for unknown session", () => {
    const store = new SessionStore(storePath);
    expect(store.get("telegram", "user1")).toBeNull();
  });

  it("stores and retrieves a session", () => {
    const store = new SessionStore(storePath);
    store.set("telegram", "user1", "session-abc");
    expect(store.get("telegram", "user1")).toBe("session-abc");
  });

  it("separates sessions by platform", () => {
    const store = new SessionStore(storePath);
    store.set("telegram", "user1", "tg-session");
    store.set("discord", "user1", "dc-session");

    expect(store.get("telegram", "user1")).toBe("tg-session");
    expect(store.get("discord", "user1")).toBe("dc-session");
  });

  it("overwrites existing session", () => {
    const store = new SessionStore(storePath);
    store.set("telegram", "user1", "old-session");
    store.set("telegram", "user1", "new-session");
    expect(store.get("telegram", "user1")).toBe("new-session");
  });

  it("clear removes a specific session", () => {
    const store = new SessionStore(storePath);
    store.set("telegram", "user1", "session-1");
    store.set("telegram", "user2", "session-2");

    store.clear("telegram", "user1");
    expect(store.get("telegram", "user1")).toBeNull();
    expect(store.get("telegram", "user2")).toBe("session-2");
  });

  it("clearAll removes all sessions", () => {
    const store = new SessionStore(storePath);
    store.set("telegram", "user1", "s1");
    store.set("discord", "user2", "s2");

    store.clearAll();
    expect(store.get("telegram", "user1")).toBeNull();
    expect(store.get("discord", "user2")).toBeNull();
  });

  it("persists sessions to disk", () => {
    const store1 = new SessionStore(storePath);
    store1.set("telegram", "user1", "persistent-session");

    // New instance reads from same file
    const store2 = new SessionStore(storePath);
    expect(store2.get("telegram", "user1")).toBe("persistent-session");
  });

  it("handles corrupted JSON gracefully", () => {
    fs.writeFileSync(storePath, "not valid json");
    const store = new SessionStore(storePath);
    // Should not throw, returns null for missing sessions
    expect(store.get("telegram", "user1")).toBeNull();
  });

  it("cleanupExpired removes old sessions", () => {
    const store = new SessionStore(storePath);
    store.set("telegram", "user1", "fresh-session");

    // Manually write an expired session
    const data = JSON.parse(fs.readFileSync(storePath, "utf-8"));
    data["telegram:expired"] = {
      session_id: "old-session",
      platform: "telegram",
      user_id: "expired",
      updated_at: 0, // epoch = definitely expired
    };
    fs.writeFileSync(storePath, JSON.stringify(data));

    const removed = store.cleanupExpired();
    expect(removed).toBe(1);
    expect(store.get("telegram", "user1")).toBe("fresh-session");
  });
});
