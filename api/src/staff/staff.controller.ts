import {
  Controller,
  HttpCode,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Clock } from '../common/clock.js';
import { AppHeaderGuard } from '../common/app-header.guard.js';
import {
  addDays,
  riyadhInstant,
  riyadhParts,
  toRiyadhIso,
} from '../common/time.js';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * Staff views. Deliberately unauthenticated in this single-user local demo (see README); a real
 * deployment needs staff login before exposing these.
 */
@Controller()
export class StaffController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
  ) {}

  /** Booked appointments by dentist for `days` clinic-local days from `from` (default today). */
  @Get('staff/appointments')
  async appointments(@Query('from') from?: string, @Query('days') days = '7') {
    const start =
      from && /^\d{4}-\d{2}-\d{2}$/.test(from)
        ? from
        : riyadhParts(this.clock.now()).date;
    const span = Math.min(Math.max(Number(days) || 7, 1), 31);
    const rows = await this.prisma.appointment.findMany({
      where: {
        status: 'booked',
        startsAt: {
          gte: riyadhInstant(start, 0),
          lt: riyadhInstant(addDays(start, span), 0),
        },
      },
      include: {
        patient: { select: { name: true, phone: true } },
        service: true,
        dentist: true,
      },
      orderBy: [{ startsAt: 'asc' }],
    });
    return rows.map((a) => ({
      id: a.id,
      startsAt: toRiyadhIso(a.startsAt),
      endsAt: toRiyadhIso(a.endsAt),
      dentist: {
        id: a.dentistId,
        nameEn: a.dentist.nameEn,
        nameAr: a.dentist.nameAr,
      },
      service: {
        id: a.serviceId,
        nameEn: a.service.nameEn,
        nameAr: a.service.nameAr,
      },
      patient: a.patient,
    }));
  }

  @Get('staff/handoffs')
  async handoffs() {
    const rows = await this.prisma.handoff.findMany({
      where: { status: 'open' },
      include: {
        conversation: {
          include: { patient: { select: { name: true, phone: true } } },
        },
      },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((h) => ({
      id: h.id,
      conversationId: h.conversationId,
      reason: h.reason,
      summary: h.summary,
      at: toRiyadhIso(h.createdAt),
      patient: h.conversation.patient,
    }));
  }

  /** Close a hand-off: the agent answers this conversation again. */
  @Post('staff/handoffs/:id/close')
  @HttpCode(200)
  @UseGuards(AppHeaderGuard)
  async close(@Param('id', ParseUUIDPipe) id: string) {
    const handoff = await this.prisma.handoff.findUnique({ where: { id } });
    if (!handoff) throw new NotFoundException('No such hand-off.');
    if (handoff.status === 'open') {
      await this.prisma.$transaction([
        this.prisma.handoff.update({
          where: { id },
          data: { status: 'closed', closedAt: this.clock.now() },
        }),
        this.prisma.conversation.update({
          where: { id: handoff.conversationId },
          data: { status: 'active' },
        }),
      ]);
    }
    return { id, status: 'closed' };
  }

  /** Everything the agent did in a conversation, turn by turn. */
  @Get('trace/:conversationId')
  async trace(@Param('conversationId', ParseUUIDPipe) conversationId: string) {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      include: {
        patient: { select: { name: true, phone: true } },
        turns: {
          orderBy: { createdAt: 'asc' },
          include: {
            toolCalls: { orderBy: { createdAt: 'asc' } },
            messages: { orderBy: { createdAt: 'asc' } },
          },
        },
        actions: { orderBy: { createdAt: 'asc' } },
        handoffs: true,
      },
    });
    if (!conversation) throw new NotFoundException('No such conversation.');
    return {
      id: conversation.id,
      status: conversation.status,
      patient: conversation.patient,
      totals: {
        turns: conversation.turns.length,
        inputTokens: conversation.turns.reduce((a, t) => a + t.inputTokens, 0),
        outputTokens: conversation.turns.reduce(
          (a, t) => a + t.outputTokens,
          0,
        ),
        costUsd:
          conversation.turns.reduce((a, t) => a + t.costMicroUsd, 0) / 1e6,
      },
      turns: conversation.turns.map((t) => ({
        id: t.id,
        at: toRiyadhIso(t.createdAt),
        model: t.model,
        status: t.status,
        error: t.error,
        inputTokens: t.inputTokens,
        outputTokens: t.outputTokens,
        costUsd: t.costMicroUsd / 1e6,
        toolCalls: t.toolCalls.map((c) => ({
          name: c.name,
          input: c.input,
          result: c.result,
          ms: c.ms,
        })),
        messages: t.messages.length,
      })),
      actions: conversation.actions.map((a) => ({
        id: a.id,
        type: a.type,
        status: a.status,
        payload: a.payload,
        outcome: a.outcome,
        at: toRiyadhIso(a.createdAt),
      })),
      handoffs: conversation.handoffs.map((h) => ({
        id: h.id,
        status: h.status,
        reason: h.reason,
        summary: h.summary,
      })),
    };
  }
}
