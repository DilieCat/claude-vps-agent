/**
 * Barrel export for lib/ modules.
 */

export { withFileLock, withFileLockSync, atomicWrite } from "./filelock.js";
export { Brain } from "./brain.js";
export { SessionStore } from "./session-store.js";
export { NotificationQueue } from "./notifier.js";
export type { Notification } from "./notifier.js";
export { ClaudeBridge, LivingBridge } from "./claude-bridge.js";
export type { ClaudeResponse } from "./claude-bridge.js";
