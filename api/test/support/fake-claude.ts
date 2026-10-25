import type {
  BetaMessage,
  BetaMessageParam,
} from '@anthropic-ai/sdk/resources/beta';

type Block = Record<string, unknown>;

/** A scripted assistant reply. */
export function reply(
  content: Block[],
  stop_reason = 'end_turn',
  model = 'claude-sonnet-5-5',
): BetaMessage {
  return {
    id: `msg_${Math.random().toString(36).slice(2)}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason,
    stop_sequence: null,
    usage: {
      input_tokens: 1000,
      output_tokens: 100,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  } as unknown as BetaMessage;
}

export const text = (t: string): Block => ({ type: 'text', text: t });
export const toolUse = (
  name: string,
  input: unknown,
  id = `toolu_${name}_${Math.random().toString(36).slice(2, 8)}`,
): Block => ({
  type: 'tool_use',
  id,
  name,
  input,
});

type ScriptEntry =
  | BetaMessage
  | Error // simulate an API failure mid-turn
  | ((lastToolResults: unknown[]) => BetaMessage);

type RunnableTool = {
  name: string;
  run: (input: unknown) => Promise<string | unknown[]>;
};

/**
 * Stands in for the Anthropic client's tool runner: yields scripted replies as streams and runs the
 * real tools (passed in the request) for each tool_use block. Records every request.
 * A script entry can be a function of the previous tool results, to use ids the tools returned.
 */
export class FakeClaude {
  calls: Record<string, unknown>[] = [];
  toolRuns = 0;

  constructor(public script: ScriptEntry[] = []) {}

  beta = {
    messages: {
      toolRunner: (
        params: Record<string, unknown>,
        options?: { signal?: AbortSignal },
      ) => {
        this.calls.push(params);
        const tools = params.tools as RunnableTool[];
        const script = [...this.script];
        const countRuns = (n: number) => (this.toolRuns += n);
        let current: BetaMessage | null = null;
        let lastResults: unknown[] = [];
        return {
          async *[Symbol.asyncIterator]() {
            for (const entry of script) {
              if (options?.signal?.aborted)
                throw new Error('Request was aborted.');
              if (entry instanceof Error) throw entry;
              current =
                typeof entry === 'function' ? entry(lastResults) : entry;
              const message = current;
              yield {
                on(event: string, cb: (delta: string) => void) {
                  if (event === 'text')
                    for (const b of message.content)
                      if (b.type === 'text') cb(b.text);
                },
                finalMessage: async () => message,
              };
            }
          },
          async generateToolResponse(): Promise<BetaMessageParam | null> {
            const uses = (current?.content ?? []).filter(
              (b) => b.type === 'tool_use',
            ) as unknown as {
              id: string;
              name: string;
              input: unknown;
            }[];
            if (!uses.length) return null;
            countRuns(uses.length);
            const results = [];
            for (const use of uses) {
              const tool = tools.find((t) => t.name === use.name)!;
              const output = await tool.run(use.input);
              results.push({
                type: 'tool_result',
                tool_use_id: use.id,
                content: output,
              });
            }
            lastResults = results.map((r) => JSON.parse(r.content as string));
            return { role: 'user', content: results } as BetaMessageParam;
          },
        };
      },
    },
  };
}
