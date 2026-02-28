/**
 * claude-bridge.ts — Shared wrapper around `claude -p` for all integrations.
 *
 * Supports two modes:
 *   - Stateless: ClaudeBridge (original, one-shot per request)
 *   - Living:    LivingBridge (brain-aware, session-persistent, proactive)
 */

import { spawn, spawnSync, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Brain } from "./brain.js";
import { SessionStore } from "./session-store.js";

/**
 * Resolve the full path to the `claude` CLI binary.
 * Background processes (systemd, make start) often have a minimal PATH
 * that doesn't include npm global bin directories.
 */
function findClaudeBinary(): string {
  // 1. Check CLAUDE_BIN env var (explicit override)
  if (process.env["CLAUDE_BIN"]) return process.env["CLAUDE_BIN"];

  // 2. Try `which claude` (works if PATH is correct)
  try {
    const result = execFileSync("which", ["claude"], { stdio: "pipe", encoding: "utf-8" });
    const found = result.trim();
    if (found) return found;
  } catch { /* not in PATH */ }

  // 3. Check common installation locations
  const candidates = [
    "/usr/local/bin/claude",
    "/usr/bin/claude",
    path.join(process.env["HOME"] ?? "", ".npm-global", "bin", "claude"),
    path.join(process.env["HOME"] ?? "", ".local", "bin", "claude"),
  ];

  // 4. Scan nvm node versions for claude binary
  const nvmDir = process.env["NVM_DIR"] ?? path.join(process.env["HOME"] ?? "", ".nvm");
  const nvmVersionsDir = path.join(nvmDir, "versions", "node");
  try {
    if (fs.existsSync(nvmVersionsDir)) {
      for (const ver of fs.readdirSync(nvmVersionsDir)) {
        candidates.push(path.join(nvmVersionsDir, ver, "bin", "claude"));
      }
    }
  } catch { /* nvm dir not readable */ }

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  // 5. Fallback: just "claude" and hope for the best
  return "claude";
}

const CLAUDE_BIN = findClaudeBinary();
if (CLAUDE_BIN === "claude") {
  console.warn("[claude-bridge] Warning: could not resolve full path to claude CLI. Set CLAUDE_BIN env var if claude is installed in a non-standard location.");
} else {
  console.log(`[claude-bridge] Using claude binary: ${CLAUDE_BIN}`);
}

/** Structured response from a `claude -p` invocation. */
export interface ClaudeResponse {
  text: string;
  exitCode: number;
  costUsd: number;
  durationMs: number;
  durationApiMs: number;
  numTurns: number;
  sessionId: string;
  isError: boolean;
  raw: Record<string, unknown>;
}

function makeErrorResponse(text: string): ClaudeResponse {
  return {
    text,
    exitCode: -1,
    costUsd: 0,
    durationMs: 0,
    durationApiMs: 0,
    numTurns: 0,
    sessionId: "",
    isError: true,
    raw: {},
  };
}

export class ClaudeBridge {
  protected static readonly DEFAULT_TIMEOUT = 300;

  readonly projectDir: string;
  readonly model: string | undefined;
  readonly allowedTools: string[];
  readonly maxBudgetUsd: number | undefined;
  readonly timeoutSeconds: number;

  constructor(options: {
    projectDir?: string;
    model?: string;
    allowedTools?: string[];
    maxBudgetUsd?: number;
    timeoutSeconds?: number;
  } = {}) {
    this.projectDir = options.projectDir ?? process.cwd();
    this.model = options.model ?? process.env["CLAUDE_MODEL"];

    if (options.allowedTools) {
      this.allowedTools = options.allowedTools;
    } else {
      const envTools = process.env["CLAUDE_ALLOWED_TOOLS"] ?? "";
      this.allowedTools = envTools.split(",").map((t) => t.trim()).filter(Boolean);
    }

    if (options.maxBudgetUsd !== undefined) {
      this.maxBudgetUsd = options.maxBudgetUsd;
    } else {
      const envBudget = process.env["CLAUDE_MAX_BUDGET_USD"];
      this.maxBudgetUsd = envBudget ? parseFloat(envBudget) : undefined;
    }

    if (options.timeoutSeconds !== undefined) {
      this.timeoutSeconds = options.timeoutSeconds;
    } else {
      const envTimeout = process.env["CLAUDE_TIMEOUT_SECONDS"];
      this.timeoutSeconds = envTimeout ? parseInt(envTimeout, 10) : ClaudeBridge.DEFAULT_TIMEOUT;
    }
  }

  /** Build the claude CLI command. */
  buildCommand(prompt: string, resumeSession?: string): string[] {
    const cmd = [CLAUDE_BIN, "-p", prompt, "--output-format", "json"];

    if (resumeSession) {
      cmd.push("--resume", resumeSession);
    }
    if (this.model) {
      cmd.push("--model", this.model);
    }
    if (this.allowedTools.length > 0) {
      cmd.push("--allowedTools", this.allowedTools.join(","));
    }
    if (this.maxBudgetUsd !== undefined) {
      cmd.push("--max-budget-usd", String(this.maxBudgetUsd));
    }

    // Append system prompt with agent personality if available
    const systemPromptFile = path.join(this.projectDir, "data", "system-prompt.md");
    if (fs.existsSync(systemPromptFile)) {
      const systemPrompt = fs.readFileSync(systemPromptFile, "utf-8");
      cmd.push("--append-system-prompt", systemPrompt);
    }

    return cmd;
  }

  /** Parse JSON output from `claude -p`. */
  parseResponse(stdout: string, exitCode: number): ClaudeResponse {
    try {
      const data = JSON.parse(stdout) as Record<string, unknown>;
      return {
        text: (data["result"] as string) ?? stdout,
        exitCode,
        costUsd: (data["cost_usd"] as number) ?? 0,
        durationMs: (data["duration_ms"] as number) ?? 0,
        durationApiMs: (data["duration_api_ms"] as number) ?? 0,
        numTurns: (data["num_turns"] as number) ?? 0,
        sessionId: (data["session_id"] as string) ?? "",
        isError: (data["is_error"] as boolean) ?? exitCode !== 0,
        raw: data,
      };
    } catch {
      return {
        text: stdout.trim(),
        exitCode,
        costUsd: 0,
        durationMs: 0,
        durationApiMs: 0,
        numTurns: 0,
        sessionId: "",
        isError: exitCode !== 0,
        raw: {},
      };
    }
  }

  /** Send a prompt to Claude Code and return the response (blocking). */
  ask(prompt: string, resumeSession?: string): ClaudeResponse {
    const cmd = this.buildCommand(prompt, resumeSession);
    const [bin, ...args] = cmd;

    try {
      const result = spawnSync(bin, args, {
        cwd: this.projectDir,
        encoding: "utf-8",
        timeout: this.timeoutSeconds * 1000,
        maxBuffer: 10 * 1024 * 1024,
      });

      if (result.error) {
        if ((result.error as NodeJS.ErrnoException).code === "ENOENT") {
          return makeErrorResponse(
            "claude CLI not found. Install: npm install -g @anthropic-ai/claude-code"
          );
        }
        if ((result.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
          return makeErrorResponse(`Timeout after ${this.timeoutSeconds}s`);
        }
        return makeErrorResponse(result.error.message);
      }

      const response = this.parseResponse(result.stdout ?? "", result.status ?? 1);
      if ((result.status ?? 1) !== 0 && !response.text) {
        response.text = result.stderr?.trim() || "Unknown error";
        response.isError = true;
      }

      return response;
    } catch (err) {
      return makeErrorResponse(String(err));
    }
  }

  /** Async version of ask() for use in bot event loops. */
  async askAsync(prompt: string, resumeSession?: string): Promise<ClaudeResponse> {
    const cmd = this.buildCommand(prompt, resumeSession);
    const [bin, ...args] = cmd;

    return new Promise<ClaudeResponse>((resolve) => {
      let proc;
      try {
        proc = spawn(bin, args, {
          cwd: this.projectDir,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch {
        resolve(
          makeErrorResponse(
            "claude CLI not found. Install: npm install -g @anthropic-ai/claude-code"
          )
        );
        return;
      }

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];

      proc.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
      proc.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

      const timer = setTimeout(() => {
        proc.kill("SIGKILL");
      }, this.timeoutSeconds * 1000);

      proc.on("error", (err: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        if (err.code === "ENOENT") {
          resolve(
            makeErrorResponse(
              "claude CLI not found. Install: npm install -g @anthropic-ai/claude-code"
            )
          );
        } else {
          resolve(makeErrorResponse(err.message));
        }
      });

      proc.on("close", (code, signal) => {
        clearTimeout(timer);
        if (signal === "SIGKILL") {
          resolve(makeErrorResponse(`Timeout after ${this.timeoutSeconds}s`));
          return;
        }

        const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
        const stderr = Buffer.concat(stderrChunks).toString("utf-8");
        const exitCode = code ?? 1;
        const response = this.parseResponse(stdout, exitCode);

        if (exitCode !== 0 && !response.text) {
          response.text = stderr.trim() || "Unknown error";
          response.isError = true;
        }

        resolve(response);
      });
    });
  }
}

/**
 * Brain-aware, session-persistent bridge for the living agent.
 *
 * Extends ClaudeBridge with:
 * - Persistent memory (brain.md) injected into every prompt
 * - Session continuity per user (resume conversations)
 * - Automatic brain updates after each interaction
 * - Event logging for history
 */
export class LivingBridge extends ClaudeBridge {
  readonly brain: Brain;
  readonly sessions: SessionStore;

  constructor(options: {
    projectDir?: string;
    model?: string;
    allowedTools?: string[];
    maxBudgetUsd?: number;
    timeoutSeconds?: number;
  } = {}) {
    super(options);
    this.brain = new Brain();
    this.sessions = new SessionStore();
  }

  /** Wrap user message with brain context. */
  private buildLivingPrompt(userMessage: string): string {
    const brainContext = this.brain.getContextPrompt();
    return (
      `${brainContext}\n\n` +
      `---\n\n` +
      `User message:\n${userMessage}\n\n` +
      `---\n\n` +
      `Respond to the user's message. If you learn anything new about ` +
      `the user's preferences or if there are important events to ` +
      `remember, note them — your brain will be updated after this.`
    );
  }

  /**
   * Send a message as a specific user with brain context and session resume.
   *
   * This is the primary async method for the living agent. It:
   * 1. Loads the brain for context
   * 2. Looks up the user's session for continuity
   * 3. Sends the prompt with brain + session
   * 4. Stores the new session ID
   * 5. Logs the event to brain history
   */
  async askAs(platform: string, userId: string, message: string): Promise<ClaudeResponse> {
    const prompt = this.buildLivingPrompt(message);
    const sessionId = this.sessions.get(platform, userId);
    const response = await this.askAsync(prompt, sessionId ?? undefined);

    if (response.sessionId) {
      this.sessions.set(platform, userId, response.sessionId);
    }

    const shortMsg = message.length > 80 ? message.slice(0, 80) + "..." : message;
    const label = `${platform}:${userId}`;
    if (response.isError) {
      this.brain.addEvent(`[${label}] Error: ${response.text.slice(0, 100)}`);
    } else {
      this.brain.addEvent(
        `[${label}] Q: ${shortMsg} (cost=$${response.costUsd.toFixed(4)}, turns=${response.numTurns})`
      );
    }

    return response;
  }

  /** Sync version of askAs for non-async contexts. */
  askAsSync(platform: string, userId: string, message: string): ClaudeResponse {
    const prompt = this.buildLivingPrompt(message);
    const sessionId = this.sessions.get(platform, userId);
    const response = this.ask(prompt, sessionId ?? undefined);

    if (response.sessionId) {
      this.sessions.set(platform, userId, response.sessionId);
    }

    const shortMsg = message.length > 80 ? message.slice(0, 80) + "..." : message;
    const label = `${platform}:${userId}`;
    if (response.isError) {
      this.brain.addEvent(`[${label}] Error: ${response.text.slice(0, 100)}`);
    } else {
      this.brain.addEvent(
        `[${label}] Q: ${shortMsg} (cost=$${response.costUsd.toFixed(4)}, turns=${response.numTurns})`
      );
    }

    return response;
  }
}
