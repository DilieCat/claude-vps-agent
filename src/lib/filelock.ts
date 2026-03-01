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

const LOCK_POLL_MS = 50;
const LOCK_TIMEOUT_MS = 10_000;
const LOCK_STALE_MS = 60_000;

/**
 * Check whether a lock file is stale (owning process is dead or file is too old).
 */
function isLockStale(lockPath: string, maxAgeMs = LOCK_STALE_MS): boolean {
  try {
    const content = fs.readFileSync(lockPath, "utf-8").trim();
    const pid = parseInt(content, 10);
    if (!isNaN(pid)) {
      try {
        process.kill(pid, 0);
        return false; // process alive
      } catch {
        return true; // process dead = stale
      }
    }
    // Can't read PID, check file age
    const stat = fs.statSync(lockPath);
    return Date.now() - stat.mtimeMs > maxAgeMs;
  } catch {
    return true; // can't read lock file = stale
  }
}

/**
 * Acquire an exclusive lock asynchronously with setTimeout-based retry.
 * Returns a release function that removes the lock file.
 */
async function acquireLockAsync(filePath: string, timeoutMs = LOCK_TIMEOUT_MS): Promise<() => void> {
  const lockPath = filePath + ".lock";
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const fd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);
      fs.writeSync(fd, process.pid.toString());
      fs.closeSync(fd);
      return () => {
        try {
          fs.unlinkSync(lockPath);
        } catch {}
      };
    } catch (e: any) {
      if (e.code === "EEXIST") {
        if (isLockStale(lockPath)) {
          try {
            fs.unlinkSync(lockPath);
          } catch {}
          continue;
        }
        await new Promise((r) => setTimeout(r, LOCK_POLL_MS));
        continue;
      }
      throw e;
    }
  }
  throw new Error(`Timeout acquiring lock: ${lockPath}`);
}

/**
 * Acquire an exclusive lock synchronously using O_EXCL. Spins until acquired or timeout.
 * Includes stale lock detection.
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
      // Check for stale lock before waiting
      if (isLockStale(lockPath)) {
        try {
          fs.unlinkSync(lockPath);
        } catch {}
        continue;
      }
      // Brief sleep to avoid burning CPU
      const sharedBuffer = new SharedArrayBuffer(4);
      const int32 = new Int32Array(sharedBuffer);
      Atomics.wait(int32, 0, 0, LOCK_POLL_MS);
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
  const release = await acquireLockAsync(filePath);
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
