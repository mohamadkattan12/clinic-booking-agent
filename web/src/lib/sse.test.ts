import { describe, expect, it } from "vitest";
import { parseSSE, type SSEEvent } from "./sse";

const delta = 'event: delta\ndata: {"text": "مرحبا"}\n\n';
const done = 'event: done\ndata: {"answerable": true, "text": "a b"}\n\n';

function feed(chunks: string[]): SSEEvent[] {
  let buffer = "";
  const events: SSEEvent[] = [];
  for (const chunk of chunks) {
    const parsed = parseSSE(buffer + chunk);
    events.push(...parsed.events);
    buffer = parsed.rest;
  }
  return events;
}

describe("parseSSE", () => {
  it.each([delta + done, (delta + done).replaceAll("\n", "\r\n")])(
    "returns every event however the stream is split into chunks",
    (stream) => {
      for (let cut = 0; cut <= stream.length; cut++) {
        const events = feed([stream.slice(0, cut), stream.slice(cut)]);
        expect(events.map((e) => e.event)).toEqual(["delta", "done"]);
      }
    },
  );

  it("keeps U+2028 inside JSON data intact", () => {
    const [, last] = feed([delta + done]);
    expect(JSON.parse(last.data).text).toBe("a b");
  });

  it("keeps an unfinished event for the next chunk", () => {
    expect(parseSSE("event: delta\ndata: {}")).toEqual({ events: [], rest: "event: delta\ndata: {}" });
  });
});
