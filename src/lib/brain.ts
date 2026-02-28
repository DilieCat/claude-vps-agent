/**
 * brain.ts — Persistent memory for the living agent.
 *
 * The brain is a Markdown file that the agent reads before every interaction
 * and updates after. It stores: identity, ongoing tasks, user preferences,
 * recent conversation summaries, and learned patterns.
 */

import fs from "node:fs";
import path from "node:path";
import { withFileLockSync, atomicWrite } from "./filelock.js";

const PROJECT_ROOT = path.resolve(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname), "..", "..");
const DEFAULT_BRAIN_PATH = path.join(PROJECT_ROOT, "data", "brain.md");

/** Maximum events to keep in recent history. */
const MAX_EVENTS = 50;

export class Brain {
  readonly path: string;
  private content: string;

  constructor(brainPath?: string) {
    this.path = brainPath ?? DEFAULT_BRAIN_PATH;
    const dir = path.dirname(this.path);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    if (!fs.existsSync(this.path)) {
      this.initBrain();
    }
    this.content = fs.readFileSync(this.path, "utf-8");
  }

  private initBrain(): void {
    const templatePath = path.join(PROJECT_ROOT, "data", "brain.template.md");
    if (fs.existsSync(templatePath)) {
      fs.writeFileSync(this.path, fs.readFileSync(templatePath, "utf-8"));
    } else {
      fs.writeFileSync(this.path, DEFAULT_TEMPLATE);
    }
  }

  /** Reload brain from disk (in case another process updated it). */
  reload(): void {
    this.content = fs.readFileSync(this.path, "utf-8");
  }

  /** Write current brain state to disk atomically. */
  save(): void {
    atomicWrite(this.path, this.content);
  }

  /** Return the full brain content for injection into a Claude prompt. */
  getContext(): string {
    this.reload();
    return this.content;
  }

  /** Return a prompt-ready string that instructs Claude to use the brain. */
  getContextPrompt(): string {
    const brainContent = this.getContext();
    return (
      "You are a persistent AI agent. Below is your brain — your memory " +
      "from previous sessions. Use it to maintain continuity. At the end " +
      "of this interaction, you will update your brain with anything new " +
      "you learned.\n\n" +
      "<brain>\n" +
      brainContent + "\n" +
      "</brain>\n\n" +
      "Important: Respond naturally as a continuous being. Reference past " +
      "interactions when relevant. Remember user preferences."
    );
  }

  /** Extract content under a specific ## heading. */
  getSection(heading: string): string {
    const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`^## ${escaped}\n(.*?)(?=^## |$)`, "ms");
    const match = this.content.match(pattern);
    return match ? match[1].trim() : "";
  }

  /** Replace content under a specific ## heading (locked, atomic). */
  updateSection(heading: string, content: string): void {
    withFileLockSync(this.path, () => {
      this.reload();
      this.applySectionUpdate(heading, content);
      this.save();
    });
  }

  private applySectionUpdate(heading: string, content: string): void {
    const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`(^## ${escaped}\n).*?(?=^## |$)`, "ms");
    const newContent = this.content.replace(pattern, `$1${content}\n`);

    if (newContent === this.content) {
      // Section didn't exist — check if heading is truly absent
      const headingPattern = new RegExp(`^## ${escaped}`, "m");
      if (!this.getSection(heading) && !headingPattern.test(this.content)) {
        this.content = this.content.trimEnd() + `\n\n## ${heading}\n${content}\n`;
      }
    } else {
      this.content = newContent;
    }
  }

  /** Add a timestamped event to the Recent History section. */
  addEvent(event: string): void {
    const now = new Date();
    const ts = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, "0"),
      String(now.getDate()).padStart(2, "0"),
    ].join("-") + " " + [
      String(now.getHours()).padStart(2, "0"),
      String(now.getMinutes()).padStart(2, "0"),
    ].join(":");
    const entry = `- [${ts}] ${event}`;

    withFileLockSync(this.path, () => {
      this.reload();
      const history = this.getSection("Recent History");
      const lines = history.split("\n").filter((l) => l.startsWith("- "));
      lines.unshift(entry);
      const trimmed = lines.slice(0, MAX_EVENTS);
      this.applySectionUpdate("Recent History", trimmed.join("\n"));
      this.save();
    });
  }

  /** Get a specific user preference by key. */
  getUserPref(key: string): string | null {
    const prefs = this.getSection("User Preferences");
    for (const line of prefs.split("\n")) {
      if (line.trim().startsWith(`- ${key}:`)) {
        return line.split(":").slice(1).join(":").trim();
      }
    }
    return null;
  }

  /** Set a user preference (adds or updates). */
  setUserPref(key: string, value: string): void {
    const prefs = this.getSection("User Preferences");
    const lines = prefs.split("\n").filter((l) => l.trim());

    let updated = false;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim().startsWith(`- ${key}:`)) {
        lines[i] = `- ${key}: ${value}`;
        updated = true;
        break;
      }
    }
    if (!updated) {
      lines.push(`- ${key}: ${value}`);
    }

    this.updateSection("User Preferences", lines.join("\n"));
  }
}

const DEFAULT_TEMPLATE = `# Agent Brain

## Identity
- Name: Atlas
- Role: Personal AI assistant
- Platform: Chat bot (Discord/Telegram)

## User Preferences
(Not yet configured — will be set during first conversation)

## Learned Patterns
No patterns learned yet.

## Recent History
No events yet.
`;
