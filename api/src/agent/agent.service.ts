import Anthropic from '@anthropic-ai/sdk';
import type { BetaMessageParam } from '@anthropic-ai/sdk/resources/beta';
import { Injectable } from '@nestjs/common';
import { ActionsService } from '../actions/actions.service.js';
import { Clock } from '../common/clock.js';
import { riyadhParts, toRiyadhIso } from '../common/time.js';
import { ClinicService } from '../clinic/clinic.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { buildSystemPrompt, turnContext } from './prompt.js';
import { buildTools } from './tools.js';

// Models whose requests can use server-side refusal fallback (Claude Haiku 5.5 has none).
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-sonnet-5-5']);
// USD per million input/output tokens (Anthropic first-party pricing, 2026-10).
export const PRICES: Record<string, [number, number]> = {
  'claude-opus-5-5': [4, 20],
  'claude-sonnet-5-5': [2, 10],
  'claude-haiku-5-5': [0.1, 0.5],
};
export const MAX_ITERATIONS = 8;

/** The API needs alternating roles: if history ends on the user side (e.g. a confirm event),
 * the new message's blocks join that message instead of following it. */
export function appendUserMessage(
  history: BetaMessageParam[],
  message: BetaMessageParam,
): BetaMessageParam[] {
  const last = history.at(-1);
  if (!last || last.role !== 'user') return [...history, message];
  const blocks = (m: BetaMessageParam) =>
    typeof m.content === 'string'
      ? [{ type: 'text' as const, text: m.content }]
      : (m.content ?? []);
  return [
    ...history.slice(0, -1),
    { role: 'user', content: [...blocks(last), ...blocks(message)] },
  ];
}

export interface ToolCallRecord {
  name: string;
  input: unknown;
  result: unknown;
  ms: number;
}

export interface TurnInput {
  conversationId: string;
  patient: { id: string; name: string; phone: string };
  history: BetaMessageParam[]; // earlier completed turns, replayed unchanged
  text: string; // the patient's new message
  onDelta?: (text: string) => void;
  signal?: AbortSignal;
  model?: string;
  effort?: 'low' | 'medium' | 'high';
  fallback?: boolean; // off in the eval, so each model is measured alone
}

export interface TurnResult {
  messages: BetaMessageParam[]; // this turn's messages: user, then assistant/tool results
  toolCalls: ToolCallRecord[];
  model: string;
  inputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  costMicroUsd: number;
  stop: 'end_turn' | 'refusal' | 'max_tokens' | 'max_iterations' | 'other';
}

@Injectable()
export class AgentService {
  constructor(
    private readonly client: Anthropic,
    private readonly prisma: PrismaService,
    private readonly clinic: ClinicService,
    private readonly actions: ActionsService,
    private readonly clock: Clock,
  ) {}

  async systemPrompt(): Promise<string> {
    const [hours, services, dentists] = await Promise.all([
      this.prisma.clinicHours.findMany(),
      this.prisma.service.findMany({ orderBy: { id: 'asc' } }),
      this.prisma.dentist.findMany({
        include: { services: true, schedules: true },
        orderBy: { id: 'asc' },
      }),
    ]);
    return buildSystemPrompt({ hours, services, dentists });
  }

  /** Run one patient turn through the tool loop. Nothing is stored here: the caller commits the turn. */
  async runTurn(input: TurnInput): Promise<TurnResult> {
    const model = input.model ?? process.env.AGENT_MODEL ?? 'claude-sonnet-5-5';
    const now = this.clock.now();
    const userMessage: BetaMessageParam = {
      role: 'user',
      content: [
        {
          type: 'text',
          text: turnContext(
            toRiyadhIso(now),
            riyadhParts(now).weekday,
            input.patient,
          ),
        },
        { type: 'text', text: input.text },
      ],
    };
    const toolCalls: ToolCallRecord[] = [];
    const tools = buildTools({
      conversationId: input.conversationId,
      patientId: input.patient.id,
      actions: this.actions,
      clinic: this.clinic,
      prisma: this.prisma,
      clock: this.clock,
      record: async (name, toolInput, result, ms) => {
        toolCalls.push({ name, input: toolInput, result, ms });
      },
    });

    const useFallback = (input.fallback ?? true) && FALLBACK_MODELS.has(model);
    const runner = this.client.beta.messages.toolRunner(
      {
        model,
        max_tokens: 8000,
        // Stable prefix: cached when it reaches the model's minimum cacheable size.
        system: [
          {
            type: 'text',
            text: await this.systemPrompt(),
            cache_control: { type: 'ephemeral' },
          },
        ],
        thinking: { type: 'adaptive' },
        output_config: { effort: input.effort ?? 'medium' },
        messages: appendUserMessage(input.history, userMessage),
        tools,
        stream: true,
        max_iterations: MAX_ITERATIONS,
        thread: false, // our database holds the history; send it in full each turn
        ...(useFallback
          ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }
          : {}),
      },
      { signal: input.signal },
    );

    const messages: BetaMessageParam[] = [userMessage];
    const totals = { input: 0, cacheRead: 0, output: 0, cost: 0 };
    let stop: TurnResult['stop'] = 'max_iterations';
    let served = model;

    for await (const stream of runner) {
      if (input.onDelta) stream.on('text', (delta) => input.onDelta!(delta));
      const message = await stream.finalMessage();
      served = message.model;
      messages.push({ role: 'assistant', content: message.content });
      const u = message.usage;
      const [priceIn, priceOut] = PRICES[message.model] ?? [0, 0];
      const cacheRead = u.cache_read_input_tokens ?? 0;
      const cacheWrite = u.cache_creation_input_tokens ?? 0;
      totals.input += u.input_tokens + cacheRead + cacheWrite;
      totals.cacheRead += cacheRead;
      totals.output += u.output_tokens;
      // cache reads cost 0.1x, cache writes 1.25x the input price
      totals.cost +=
        u.input_tokens * priceIn +
        cacheRead * priceIn * 0.1 +
        cacheWrite * priceIn * 1.25 +
        u.output_tokens * priceOut;

      if (
        message.stop_reason === 'refusal' ||
        message.stop_reason === 'max_tokens'
      ) {
        // Never run tools from a cut-off reply, and never store a tool_use without its result:
        // the next request would be rejected.
        stop = message.stop_reason;
        const kept = message.content.filter((b) => b.type !== 'tool_use');
        if (kept.length)
          messages[messages.length - 1] = { role: 'assistant', content: kept };
        else messages.pop();
        break;
      }
      const toolResults = await runner.generateToolResponse();
      if (!toolResults) {
        stop = message.stop_reason === 'end_turn' ? 'end_turn' : 'other';
        break;
      }
      messages.push(toolResults);
    }

    return {
      messages,
      toolCalls,
      model: served,
      inputTokens: totals.input,
      cacheReadTokens: totals.cacheRead,
      outputTokens: totals.output,
      costMicroUsd: Math.round(totals.cost), // tokens x USD per million = micro-USD
      stop,
    };
  }
}
