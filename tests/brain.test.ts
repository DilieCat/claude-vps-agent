import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Brain } from "../src/lib/brain.js";

describe("Brain", () => {
  let tmpDir: string;
  let brainPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "brain-test-"));
    brainPath = path.join(tmpDir, "brain.md");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates a default brain file when none exists", () => {
    const brain = new Brain(brainPath);
    expect(fs.existsSync(brainPath)).toBe(true);
    expect(brain.getContext()).toContain("# Agent Brain");
  });

  it("reads existing brain file", () => {
    const content = "# My Brain\n\n## Identity\n- Name: TestBot\n";
    fs.writeFileSync(brainPath, content);
    const brain = new Brain(brainPath);
    expect(brain.getContext()).toBe(content);
  });

  it("getSection extracts content under a heading", () => {
    const content = [
      "# Brain",
      "",
      "## Identity",
      "- Name: TestBot",
      "",
      "## User Preferences",
      "- Language: Dutch",
      "",
    ].join("\n");
    fs.writeFileSync(brainPath, content);
    const brain = new Brain(brainPath);

    expect(brain.getSection("Identity")).toBe("- Name: TestBot");
    expect(brain.getSection("User Preferences")).toBe("- Language: Dutch");
  });

  it("getSection returns empty string for missing section", () => {
    const content = "# Brain\n\n## Identity\n- Name: TestBot\n";
    fs.writeFileSync(brainPath, content);
    const brain = new Brain(brainPath);

    expect(brain.getSection("Nonexistent")).toBe("");
  });

  it("updateSection replaces existing section content", () => {
    const content = [
      "# Brain",
      "",
      "## Identity",
      "- Name: OldName",
      "",
      "## Notes",
      "Some notes",
      "",
    ].join("\n");
    fs.writeFileSync(brainPath, content);
    const brain = new Brain(brainPath);

    brain.updateSection("Identity", "- Name: NewName");
    expect(brain.getSection("Identity")).toBe("- Name: NewName");
    // Other sections remain
    expect(brain.getSection("Notes")).toBe("Some notes");
  });

  it("updateSection adds section if it does not exist", () => {
    const content = "# Brain\n\n## Identity\n- Name: TestBot\n";
    fs.writeFileSync(brainPath, content);
    const brain = new Brain(brainPath);

    brain.updateSection("New Section", "New content here");
    expect(brain.getSection("New Section")).toBe("New content here");
    // Original section still there
    expect(brain.getSection("Identity")).toBe("- Name: TestBot");
  });

  it("addEvent prepends a timestamped event to Recent History", () => {
    const content = [
      "# Brain",
      "",
      "## Recent History",
      "No events yet.",
      "",
    ].join("\n");
    fs.writeFileSync(brainPath, content);
    const brain = new Brain(brainPath);

    brain.addEvent("Test event happened");
    const history = brain.getSection("Recent History");
    expect(history).toContain("Test event happened");
    expect(history).toMatch(/^\- \[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\] Test event happened/);
  });

  it("getContextPrompt returns a prompt-ready string", () => {
    const content = "# Brain\n\n## Identity\n- Name: TestBot\n";
    fs.writeFileSync(brainPath, content);
    const brain = new Brain(brainPath);

    const prompt = brain.getContextPrompt();
    expect(prompt).toContain("<brain>");
    expect(prompt).toContain("</brain>");
    expect(prompt).toContain("# Brain");
  });

  it("getUserPref reads a preference from User Preferences section", () => {
    const content = [
      "# Brain",
      "",
      "## User Preferences",
      "- Language: English",
      "",
    ].join("\n");
    fs.writeFileSync(brainPath, content);
    const brain = new Brain(brainPath);

    expect(brain.getUserPref("Language")).toBe("English");
    expect(brain.getUserPref("Missing")).toBeNull();
  });

  it("setUserPref updates an existing preference", () => {
    const content = [
      "# Brain",
      "",
      "## User Preferences",
      "- Language: English",
      "",
    ].join("\n");
    fs.writeFileSync(brainPath, content);
    const brain = new Brain(brainPath);

    brain.setUserPref("Language", "Dutch");
    expect(brain.getUserPref("Language")).toBe("Dutch");
  });

  it("reload refreshes content from disk", () => {
    const content = "# Brain\n\n## Identity\n- Name: Before\n";
    fs.writeFileSync(brainPath, content);
    const brain = new Brain(brainPath);

    fs.writeFileSync(brainPath, "# Brain\n\n## Identity\n- Name: After\n");
    brain.reload();
    expect(brain.getSection("Identity")).toBe("- Name: After");
  });

  it("save persists content to disk", () => {
    const content = "# Brain\n\n## Identity\n- Name: TestBot\n";
    fs.writeFileSync(brainPath, content);
    const brain = new Brain(brainPath);

    brain.updateSection("Identity", "- Name: Saved");
    // Verify it was written to disk
    const diskContent = fs.readFileSync(brainPath, "utf-8");
    expect(diskContent).toContain("- Name: Saved");
  });
});
