import { Injectable } from '@nestjs/common';
import { Clock } from '../common/clock.js';
import { toRiyadhIso } from '../common/time.js';
import {
  checkChange,
  checkSlot,
  type ChangeViolation,
  type RuleViolation,
} from '../clinic/booking-rules.js';
import { ClinicService } from '../clinic/clinic.service.js';
import type { PendingAction, Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

export const ACTION_TTL_MS = 10 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** What the patient sees on the Confirm button. Frozen when the action is proposed. */
export interface ActionPayload {
  type: 'book' | 'reschedule' | 'cancel';
  serviceId: string;
  serviceNameAr: string;
  serviceNameEn: string;
  dentistId: string;
  dentistNameAr: string;
  dentistNameEn: string;
  startsAt: string; // ISO with +03:00
  endsAt: string;
  priceHalalas: number;
  previousStartsAt?: string; // reschedule only
}

export type ProposeInput =
  | { type: 'book'; serviceId: string; dentistId: string; slotStart: string }
  | { type: 'reschedule'; appointmentId: string; newSlotStart: string }
  | { type: 'cancel'; appointmentId: string };

export type ProposeResult =
  | { ok: true; actionId: string; payload: ActionPayload; expiresAt: string }
  | { ok: false; reason: RuleViolation | ChangeViolation | 'invalid_time' };

export type Outcome =
  | { ok: true; appointmentId: string; payload: ActionPayload }
  | {
      ok: false;
      reason: RuleViolation | ChangeViolation | 'appointment_changed';
    };

export type ResolveResult =
  | { status: 'confirmed' | 'declined'; outcome: Outcome | null }
  | { status: 'failed'; outcome: Outcome }
  | { status: 'not_found' }
  | {
      status: 'gone';
      reason: 'expired' | 'superseded' | 'declined' | 'confirmed';
    };

/** Offset-bearing ISO instant only ("2026-10-26T10:00:00+03:00" or "...Z"). */
export function parseInstant(value: string): Date | null {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(
      value,
    )
  )
    return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

class ConfirmConflict extends Error {
  constructor(readonly reason: Exclude<Outcome, { ok: true }>['reason']) {
    super(reason);
  }
}

const isOverlapViolation = (e: unknown) =>
  String((e as Error)?.message ?? e).includes('appointments_no_overlap');

@Injectable()
export class ActionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clinic: ClinicService,
    private readonly clock: Clock,
  ) {}

  /** Validate and freeze a proposed change. Supersedes the conversation's older pending actions. */
  async propose(
    conversationId: string,
    patientId: string,
    input: ProposeInput,
  ): Promise<ProposeResult> {
    const now = this.clock.now();
    const data = await this.clinic.load();
    let payload: ActionPayload;
    let appointment: { id: string; version: number } | null = null;

    if (input.type === 'book') {
      const start = parseInstant(input.slotStart);
      if (!start) return { ok: false, reason: 'invalid_time' };
      const booked = await this.clinic.booked(
        new Date(start.getTime() - DAY_MS),
        new Date(start.getTime() + DAY_MS),
      );
      const check = checkSlot(
        data,
        booked,
        { serviceId: input.serviceId, dentistId: input.dentistId, start },
        now,
      );
      if (!check.ok) return check;
      payload = await this.describe(
        'book',
        input.serviceId,
        input.dentistId,
        start,
        check.end,
      );
    } else {
      const existing = await this.prisma.appointment.findUnique({
        where: { id: input.appointmentId },
      });
      const violation = checkChange(existing, patientId, now);
      if (violation || !existing)
        return { ok: false, reason: violation ?? 'not_found' };
      appointment = existing;
      if (input.type === 'cancel') {
        payload = await this.describe(
          'cancel',
          existing.serviceId,
          existing.dentistId,
          existing.startsAt,
          existing.endsAt,
        );
      } else {
        const start = parseInstant(input.newSlotStart);
        if (!start) return { ok: false, reason: 'invalid_time' };
        const booked = await this.clinic.booked(
          new Date(start.getTime() - DAY_MS),
          new Date(start.getTime() + DAY_MS),
        );
        const request = {
          serviceId: existing.serviceId,
          dentistId: existing.dentistId,
          start,
        };
        const check = checkSlot(data, booked, request, now, existing.id);
        if (!check.ok) return check;
        payload = {
          ...(await this.describe(
            'reschedule',
            existing.serviceId,
            existing.dentistId,
            start,
            check.end,
          )),
          previousStartsAt: toRiyadhIso(existing.startsAt),
        };
      }
    }

    const expiresAt = new Date(now.getTime() + ACTION_TTL_MS);
    const action = await this.prisma.$transaction(async (tx) => {
      await tx.pendingAction.updateMany({
        where: { conversationId, status: 'pending' },
        data: { status: 'superseded', resolvedAt: now },
      });
      return tx.pendingAction.create({
        data: {
          conversationId,
          patientId,
          type: payload.type,
          payload: payload as unknown as Prisma.InputJsonValue,
          appointmentId: appointment?.id,
          appointmentVersion: appointment?.version,
          expiresAt,
        },
      });
    });
    return {
      ok: true,
      actionId: action.id,
      payload,
      expiresAt: toRiyadhIso(expiresAt),
    };
  }

  /** Execute a pending action the patient confirmed. Idempotent: a retry returns the stored outcome. */
  async confirm(
    conversationId: string,
    actionId: string,
  ): Promise<ResolveResult> {
    const now = this.clock.now();
    try {
      return await this.prisma.$transaction(async (tx) => {
        const claimed = await tx.pendingAction.updateMany({
          where: {
            id: actionId,
            conversationId,
            status: 'pending',
            expiresAt: { gt: now },
          },
          data: { status: 'confirmed', resolvedAt: now },
        });
        if (claimed.count === 0)
          return this.alreadyResolved(conversationId, actionId, now);
        const action = await tx.pendingAction.findUniqueOrThrow({
          where: { id: actionId },
        });
        const outcome = await this.execute(tx, action, now);
        await tx.pendingAction.update({
          where: { id: actionId },
          data: { outcome: outcome as unknown as Prisma.InputJsonValue },
        });
        await this.postOutcome(
          tx,
          conversationId,
          actionId,
          'confirmed',
          outcome,
        );
        return { status: 'confirmed' as const, outcome };
      });
    } catch (error) {
      const reason =
        error instanceof ConfirmConflict
          ? error.reason
          : isOverlapViolation(error)
            ? 'slot_taken'
            : null;
      if (!reason) throw error;
      // The transaction rolled back; record the failure so a retry returns the same answer.
      const outcome: Outcome = { ok: false, reason };
      const marked = await this.prisma.pendingAction.updateMany({
        where: { id: actionId, conversationId, status: 'pending' },
        data: {
          status: 'failed',
          resolvedAt: now,
          outcome: outcome as unknown as Prisma.InputJsonValue,
        },
      });
      if (marked.count === 0)
        return this.alreadyResolved(conversationId, actionId, now);
      await this.postOutcome(
        this.prisma,
        conversationId,
        actionId,
        'failed',
        outcome,
      );
      return { status: 'failed', outcome };
    }
  }

  async decline(
    conversationId: string,
    actionId: string,
  ): Promise<ResolveResult> {
    const now = this.clock.now();
    const declined = await this.prisma.pendingAction.updateMany({
      where: {
        id: actionId,
        conversationId,
        status: 'pending',
        expiresAt: { gt: now },
      },
      data: { status: 'declined', resolvedAt: now },
    });
    if (declined.count === 0)
      return this.alreadyResolved(conversationId, actionId, now, 'declined');
    await this.postOutcome(
      this.prisma,
      conversationId,
      actionId,
      'declined',
      null,
    );
    return { status: 'declined', outcome: null };
  }

  /** Re-run every rule inside the transaction, then write. Throws ConfirmConflict on any change. */
  private async execute(
    tx: Prisma.TransactionClient,
    action: PendingAction,
    now: Date,
  ): Promise<Outcome> {
    const payload = action.payload as unknown as ActionPayload;
    const start = new Date(payload.startsAt);
    const end = new Date(payload.endsAt);

    if (action.type === 'book') {
      const data = await this.clinic.load(tx);
      const booked = await this.clinic.booked(
        new Date(start.getTime() - DAY_MS),
        new Date(end.getTime() + DAY_MS),
        tx,
      );
      const check = checkSlot(
        data,
        booked,
        { serviceId: payload.serviceId, dentistId: payload.dentistId, start },
        now,
      );
      if (!check.ok) throw new ConfirmConflict(check.reason);
      const created = await tx.appointment.create({
        data: {
          patientId: action.patientId,
          dentistId: payload.dentistId,
          serviceId: payload.serviceId,
          startsAt: start,
          endsAt: check.end,
        },
      });
      return { ok: true, appointmentId: created.id, payload };
    }

    const appointmentId = action.appointmentId!;
    const existing = await tx.appointment.findUnique({
      where: { id: appointmentId },
    });
    const violation = checkChange(existing, action.patientId, now);
    if (violation) throw new ConfirmConflict(violation);
    if (existing!.version !== action.appointmentVersion)
      throw new ConfirmConflict('appointment_changed');

    if (action.type === 'reschedule') {
      const data = await this.clinic.load(tx);
      const booked = await this.clinic.booked(
        new Date(start.getTime() - DAY_MS),
        new Date(end.getTime() + DAY_MS),
        tx,
      );
      const request = {
        serviceId: existing!.serviceId,
        dentistId: existing!.dentistId,
        start,
      };
      const check = checkSlot(data, booked, request, now, appointmentId);
      if (!check.ok) throw new ConfirmConflict(check.reason);
    }
    // Version check in the WHERE clause: a concurrent change makes this update a no-op.
    const updated = await tx.appointment.updateMany({
      where: {
        id: appointmentId,
        version: action.appointmentVersion!,
        status: 'booked',
      },
      data:
        action.type === 'cancel'
          ? { status: 'cancelled', version: { increment: 1 } }
          : { startsAt: start, endsAt: end, version: { increment: 1 } },
    });
    if (updated.count === 0) throw new ConfirmConflict('appointment_changed');
    return { ok: true, appointmentId, payload };
  }

  private async alreadyResolved(
    conversationId: string,
    actionId: string,
    now: Date,
    requested: 'confirmed' | 'declined' = 'confirmed',
  ): Promise<ResolveResult> {
    const action = await this.prisma.pendingAction.findFirst({
      where: { id: actionId, conversationId },
    });
    if (!action) return { status: 'not_found' };
    if (action.status === 'pending' && action.expiresAt <= now) {
      await this.prisma.pendingAction.updateMany({
        where: { id: actionId, status: 'pending' },
        data: { status: 'expired', resolvedAt: now },
      });
      return { status: 'gone', reason: 'expired' };
    }
    const outcome = action.outcome as unknown as Outcome | null;
    // Repeating the same request returns its stored result.
    if (action.status === requested) return { status: requested, outcome };
    if (action.status === 'failed' && requested === 'confirmed')
      return { status: 'failed', outcome: outcome! };
    if (action.status === 'pending')
      return { status: 'gone', reason: 'expired' }; // unreachable in practice
    return {
      status: 'gone',
      reason: action.status === 'failed' ? 'confirmed' : action.status,
    };
  }

  private async postOutcome(
    db: Prisma.TransactionClient | PrismaService,
    conversationId: string,
    actionId: string,
    status: 'confirmed' | 'declined' | 'failed',
    outcome: Outcome | null,
  ): Promise<void> {
    await db.message.create({
      data: {
        conversationId,
        role: 'event',
        content: {
          kind: 'action_outcome',
          actionId,
          status,
          outcome,
        } as unknown as Prisma.InputJsonValue,
      },
    });
  }

  private async describe(
    type: ActionPayload['type'],
    serviceId: string,
    dentistId: string,
    start: Date,
    end: Date,
  ): Promise<ActionPayload> {
    const [service, dentist] = await Promise.all([
      this.prisma.service.findUniqueOrThrow({ where: { id: serviceId } }),
      this.prisma.dentist.findUniqueOrThrow({ where: { id: dentistId } }),
    ]);
    return {
      type,
      serviceId,
      serviceNameAr: service.nameAr,
      serviceNameEn: service.nameEn,
      dentistId,
      dentistNameAr: dentist.nameAr,
      dentistNameEn: dentist.nameEn,
      startsAt: toRiyadhIso(start),
      endsAt: toRiyadhIso(end),
      priceHalalas: service.priceHalalas,
    };
  }
}
