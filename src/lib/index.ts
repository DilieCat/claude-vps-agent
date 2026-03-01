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
export { splitMessage } from "./message-utils.js";
export { loadNotifyPrefs, saveNotifyPrefs } from "./notify-prefs.js";
export { logCost, getCosts, getTotalCost } from "./cost-tracker.js";
export type { CostEntry } from "./cost-tracker.js";
