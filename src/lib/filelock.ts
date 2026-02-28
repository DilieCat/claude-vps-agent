/**
 * filelock.ts — Cross-process file locking and atomic write utilities.
 *
 * Uses a .lock sidecar file with O_EXCL for advisory locking (works on
 * Linux and macOS, no external dependencies). Provides withFileLock()
 * async helper and atomicWrite() using temp file + rename.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

const LOCK_POLL_MS = 50;
const LOCK_TIMEOUT_MS = 10_000;

/**
 * Acquire an exclusive advisory lock on `filePath` using flock(1).
 * Returns a release function that unlocks and cleans up.
 */
function acquireLockSync(filePath: string): () => void {
  const lockPath = filePath + ".lock";
  const fd = fs.openSync(lockPath, "w");
  try {
    execFileSync("flock", ["-x", "-n", fd.toString()], { stdio: "ignore" });
  } catch {
    // flock as a standalone command may not work with fd on all platforms.
    // Fall back to spin-lock using O_EXCL.
    fs.closeSync(fd);
    return acquireLockSyncExcl(filePath);
  }
  return () => {
    try {
      fs.closeSync(fd);
    } catch {
      // already closed
    }
  };
}

/**
 * Fallback lock using O_EXCL (atomic create). Spins until acquired or timeout.
 */
function acquireLockSyncExcl(filePath: string): () => void {
  const lockPath = filePath + ".lock";
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  const pid = process.pid.toString();

  while (true) {
    try {
      const fd = fs.openSync(lockPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL);
      fs.writeSync(fd, pid);
      fs.closeSync(fd);
      break;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (Date.now() > deadline) {
        throw new Error(`Timeout acquiring lock on ${lockPath}`);
      }
      // Busy-wait
      const waitUntil = Date.now() + LOCK_POLL_MS;
      while (Date.now() < waitUntil) {
        /* spin */
      }
    }
  }

  return () => {
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // lock file already removed
    }
  };
}

/**
 * Execute `fn` while holding an exclusive file lock on `filePath`.
 */
export async function withFileLock<T>(filePath: string, fn: () => T | Promise<T>): Promise<T> {
  const release = acquireLockSyncExcl(filePath);
  try {
    return await fn();
  } finally {
    release();
  }
}

/**
 * Synchronous version — execute `fn` while holding an exclusive file lock.
 */
export function withFileLockSync<T>(filePath: string, fn: () => T): T {
  const release = acquireLockSyncExcl(filePath);
  try {
    return fn();
  } finally {
    release();
  }
}

/**
 * Write `data` to `filePath` atomically via a temp file + rename.
 */
export function atomicWrite(filePath: string, data: string): void {
  const dir = path.dirname(filePath);
  const tmpPath = path.join(dir, `.tmp-${process.pid}-${Date.now()}`);
  try {
    fs.writeFileSync(tmpPath, data, "utf-8");
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // tmp already gone
    }
    throw err;
  }
}
