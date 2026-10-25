export type SSEEvent = { event: string; data: string };

/**
 * Splits buffered Server-Sent Events text into complete events and the unfinished rest.
 * Line endings are normalized on the whole buffer (a "\r\n" can be split across network
 * chunks), and lines are split on "\n" only: JSON data may contain U+2028/U+2029.
 */
export function parseSSE(buffer: string): { events: SSEEvent[]; rest: string } {
  const text = buffer.replaceAll("\r\n", "\n");
  const blocks = text.split("\n\n");
  const rest = blocks.pop() ?? "";
  const events: SSEEvent[] = [];
  for (const block of blocks) {
    const lines = block.split("\n");
    const event = lines.find((l) => l.startsWith("event: "))?.slice(7);
    const data = lines.find((l) => l.startsWith("data: "))?.slice(6);
    if (event && data !== undefined) events.push({ event, data });
  }
  return { events, rest };
}
