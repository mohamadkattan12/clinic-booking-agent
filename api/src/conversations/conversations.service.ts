import type { BetaMessageParam } from '@anthropic-ai/sdk/resources/beta';
import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { ActionPayload, Outcome } from '../actions/actions.service.js';
import { hasApiKey } from '../agent/agent.module.js';
import { AgentService, type TurnResult } from '../agent/agent.service.js';
import type { Message, Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

type Json = Prisma.InputJsonValue;

export type SendResult =
  | {
      status: 'answered';
      turnId: string;
      actionIds: string[];
      handedOff: boolean;
      stop: TurnResult['stop'];
    }
  | { status: 'duplicate' }
  | { status: 'handed_off' } // stored for staff; the agent does not reply
  | { status: 'busy' }
  | { status: 'not_found' }
  | { status: 'no_api_key' };

interface ActionEvent {
  kind: 'action_outcome';
  actionId: string;
  status: 'confirmed' | 'declined' | 'failed';
  outcome: Outcome | null;
}

/** Text the model sees for a clinic event (confirm/decline/failure), sent as a user-side message. */
export function eventText(event: ActionEvent): string {
  if (event.status === 'declined')
    return '[Clinic system] The patient pressed Cancel on the proposal. Nothing was changed.';
  if (event.status === 'failed' || !event.outcome?.ok) {
    const reason =
      event.outcome && !event.outcome.ok ? event.outcome.reason : 'unknown';
    return `[Clinic system] The patient pressed Confirm, but the change could not be made (${reason}). Nothing was changed; offer other options.`;
  }
  const p: ActionPayload = event.outcome.payload;
  const verb =
    p.type === 'book'
      ? 'Booked'
      : p.type === 'reschedule'
        ? 'Rescheduled'
        : 'Cancelled';
  return `[Clinic system] The patient pressed Confirm. ${verb}: ${p.serviceNameEn} with ${p.dentistNameEn}, ${p.startsAt}.`;
}

/** Stored rows -> API messages, replayed unchanged; consecutive user-side messages are merged. */
export function toApiMessages(
  rows: Pick<Message, 'role' | 'content'>[],
): BetaMessageParam[] {
  const out: BetaMessageParam[] = [];
  for (const row of rows) {
    const message: BetaMessageParam =
      row.role === 'event'
        ? {
            role: 'user',
            content: [
              {
                type: 'text',
                text: eventText(row.content as unknown as ActionEvent),
              },
            ],
          }
        : ({
            role: row.role,
            content: row.content,
          } as unknown as BetaMessageParam);
    const last = out.at(-1);
    if (last && last.role === 'user' && message.role === 'user') {
      const blocks = (m: BetaMessageParam) =>
        typeof m.content === 'string'
          ? [{ type: 'text' as const, text: m.content }]
          : (m.content ?? []);
      out[out.length - 1] = {
        role: 'user',
        content: [...blocks(last), ...blocks(message)],
      };
    } else {
      out.push(message);
    }
  }
  return out;
}

@Injectable()
export class ConversationsService {
  private readonly log = new Logger('Turn');

  constructor(
    private readonly prisma: PrismaService,
    private readonly agent: AgentService,
  ) {}

  async create(patientId: string): Promise<{ id: string } | null> {
    const patient = await this.prisma.patient.findUnique({
      where: { id: patientId },
    });
    if (!patient) return null;
    return this.prisma.conversation.create({
      data: { patientId },
      select: { id: true },
    });
  }

  /**
   * Run one patient turn. One turn at a time per conversation; a repeated clientMessageId is ignored;
   * only a completed turn is stored (a failure or disconnect stores nothing but a failed-turn record).
   */
  async send(
    conversationId: string,
    clientMessageId: string,
    text: string,
    onDelta: (text: string) => void,
    signal?: AbortSignal,
    options: {
      model?: string;
      fallback?: boolean;
      /** Called once the turn owns the conversation; later failures must reach the client. */
      onStart?: () => void;
    } = {},
  ): Promise<SendResult> {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      include: { patient: true },
    });
    if (!conversation) return { status: 'not_found' };
    if (
      await this.prisma.message.findFirst({
        where: { conversationId, clientMessageId },
      })
    ) {
      return { status: 'duplicate' };
    }

    const turnId = randomUUID();
    const locked = await this.prisma.conversation.updateMany({
      where: { id: conversationId, activeTurnId: null },
      data: { activeTurnId: turnId },
    });
    if (locked.count === 0) return { status: 'busy' };
    options.onStart?.();

    try {
      if (conversation.status === 'handed_off') {
        await this.prisma.message.create({
          data: {
            conversationId,
            role: 'user',
            clientMessageId,
            content: [{ type: 'text', text }] as Json,
          },
        });
        return { status: 'handed_off' };
      }
      if (!hasApiKey()) return { status: 'no_api_key' };

      const rows = await this.prisma.message.findMany({
        where: { conversationId },
        orderBy: { createdAt: 'asc' },
        select: { role: true, content: true },
      });
      const started = Date.now();
      let result: TurnResult;
      try {
        result = await this.agent.runTurn({
          conversationId,
          patient: conversation.patient,
          history: toApiMessages(rows),
          text,
          onDelta,
          signal,
          model: options.model,
          fallback: options.fallback,
        });
      } catch (error) {
        await this.prisma.turn.create({
          data: {
            id: turnId,
            conversationId,
            model: options.model ?? 'unknown',
            status: 'failed',
            error: String((error as Error)?.message ?? error).slice(0, 500),
          },
        });
        throw error;
      }
      if (signal?.aborted) throw new Error('client disconnected');

      await this.commit(conversationId, turnId, clientMessageId, result);
      this.log.log(
        JSON.stringify({
          turnId,
          conversationId,
          model: result.model,
          stop: result.stop,
          tools: result.toolCalls.map((t) => t.name),
          inputTokens: result.inputTokens,
          cacheReadTokens: result.cacheReadTokens,
          outputTokens: result.outputTokens,
          costMicroUsd: result.costMicroUsd,
          ms: Date.now() - started,
        }),
      );
      const actionIds = result.toolCalls
        .map(
          (c) => (c.result as { proposed?: boolean; action_id?: string }) ?? {},
        )
        .filter((r) => r.proposed && r.action_id)
        .map((r) => r.action_id!);
      const after = await this.prisma.conversation.findUniqueOrThrow({
        where: { id: conversationId },
      });
      return {
        status: 'answered',
        turnId,
        actionIds,
        handedOff: after.status === 'handed_off',
        stop: result.stop,
      };
    } finally {
      await this.prisma.conversation.updateMany({
        where: { id: conversationId, activeTurnId: turnId },
        data: { activeTurnId: null },
      });
    }
  }

  private async commit(
    conversationId: string,
    turnId: string,
    clientMessageId: string,
    result: TurnResult,
  ): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.turn.create({
        data: {
          id: turnId,
          conversationId,
          model: result.model,
          status: 'completed',
          inputTokens: result.inputTokens,
          cacheReadTokens: result.cacheReadTokens,
          outputTokens: result.outputTokens,
          costMicroUsd: result.costMicroUsd,
        },
      }),
      ...result.messages.map((m, i) =>
        this.prisma.message.create({
          data: {
            conversationId,
            turnId,
            role: m.role === 'assistant' ? 'assistant' : 'user', // this app never sends system turns
            content: m.content as unknown as Json,
            clientMessageId: i === 0 ? clientMessageId : null,
            createdAt: new Date(Date.now() + i), // keep replay order stable within the turn
          },
        }),
      ),
      ...result.toolCalls.map((c) =>
        this.prisma.toolCall.create({
          data: {
            conversationId,
            turnId,
            name: c.name,
            input: c.input as Json,
            result: c.result as Json,
            ms: c.ms,
          },
        }),
      ),
    ]);
  }
}
