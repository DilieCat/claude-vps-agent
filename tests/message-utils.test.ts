import { describe, it, expect } from "vitest";
import { splitMessage } from "../src/lib/message-utils.js";

describe("splitMessage", () => {
  it("returns single-element array for short messages", () => {
    expect(splitMessage("hello", 100)).toEqual(["hello"]);
  });

  it("returns original message when exactly at limit", () => {
    const msg = "a".repeat(100);
    expect(splitMessage(msg, 100)).toEqual([msg]);
  });

  it("splits at newline boundaries", () => {
    const msg = "line1\nline2\nline3";
    const chunks = splitMessage(msg, 10);
    expect(chunks.length).toBeGreaterThan(1);
    // All chunks should be within limit
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(10);
    }
  });

  it("splits at space boundaries when no newline available", () => {
    const msg = "word1 word2 word3 word4";
    const chunks = splitMessage(msg, 12);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(12);
    }
  });

  it("hard-splits when no good break point exists", () => {
    const msg = "a".repeat(20);
    const chunks = splitMessage(msg, 8);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(8);
    }
  });

  it("handles empty string", () => {
    expect(splitMessage("", 100)).toEqual([""]);
  });

  it("preserves all content across chunks", () => {
    const msg = "Hello world! This is a test message that should be split.";
    const chunks = splitMessage(msg, 20);
    const joined = chunks.join("");
    // Content should be preserved (minus stripped newlines)
    expect(joined.length).toBeLessThanOrEqual(msg.length);
    // Each word from the original should appear somewhere
    for (const word of ["Hello", "world", "test", "message", "split"]) {
      expect(chunks.some((c) => c.includes(word))).toBe(true);
    }
  });
});
