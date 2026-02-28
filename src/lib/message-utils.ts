/**
 * message-utils.ts — Shared message splitting utility for bot modules.
 *
 * Splits long messages into chunks that fit within platform character limits,
 * preferring to break at newlines or spaces for readability.
 */

/**
 * Split a long message into chunks that fit within `limit` characters.
 * Prefers splitting at newline boundaries, falls back to spaces, then hard cuts.
 */
export function splitMessage(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }

    // Try to find a good split point
    let splitAt = remaining.lastIndexOf("\n", limit);
    if (splitAt === -1 || splitAt < limit / 2) {
      splitAt = remaining.lastIndexOf(" ", limit);
    }
    if (splitAt === -1 || splitAt < limit / 2) {
      splitAt = limit;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n+/, "");
  }

  return chunks;
}
