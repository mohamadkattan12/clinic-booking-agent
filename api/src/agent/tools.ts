import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import type {
  ActionsService,
  ProposeInput,
} from '../actions/actions.service.js';
import type { Clock } from '../common/clock.js';
import { toRiyadhIso } from '../common/time.js';
import { availableSlots } from '../clinic/booking-rules.js';
import type { ClinicService } from '../clinic/clinic.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';

export interface ToolContext {
  conversationId: string;
  patientId: string; // every tool is scoped to this patient; the model cannot change it
  actions: ActionsService;
  clinic: ClinicService;
  prisma: PrismaService;
  clock: Clock;
  /** Called after each tool run (stored for the trace view). */
  record: (
    name: string,
    input: unknown,
    result: unknown,
    ms: number,
  ) => Promise<void>;
}

/** Wrap a tool body: JSON result, timing and recording. */
function tool<S extends z.ZodType>(
  ctx: ToolContext,
  name: string,
  description: string,
  inputSchema: S,
  body: (input: z.infer<S>) => Promise<unknown>,
) {
  return betaZodTool({
    name,
    description,
    inputSchema,
    run: async (input) => {
      const started = Date.now();
      let result: unknown;
      try {
        result = await body(input);
      } catch {
        // Record the failure and keep internals (database errors) away from the model.
        result = { error: 'tool_failed' };
      }
      await ctx.record(name, input, result, Date.now() - started);
      return JSON.stringify(result);
    },
  });
}

const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe('Clinic-local date, YYYY-MM-DD');
const clockTime = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
  .describe('Clinic-local time, HH:MM (24-hour)');
const minutes = (t: string | undefined) =>
  t === undefined ? undefined : Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
const instant = z
  .string()
  .describe(
    'Exact slot start from check_availability, e.g. 2026-10-26T10:00:00+03:00',
  );

export function buildTools(ctx: ToolContext) {
  const propose = (input: ProposeInput) =>
    ctx.actions.propose(ctx.conversationId, ctx.patientId, input);

  return [
    tool(
      ctx,
      'check_availability',
      'Find free appointment slots for a service between two clinic-local dates (inclusive, at most 14 days). Returns up to 10 slots across days, the earliest of each day first: pass time_from/time_to when the patient wants a time of day.',
      z.object({
        service_id: z.string(),
        date_from: date,
        date_to: date,
        dentist_id: z.string().optional().describe('Only this dentist'),
        time_from: clockTime.optional().describe('Earliest start, HH:MM'),
        time_to: clockTime.optional().describe('Latest start, HH:MM'),
      }),
      async (input) => {
        const now = ctx.clock.now();
        const data = await ctx.clinic.load();
        const from = new Date(`${input.date_from}T00:00:00+03:00`);
        const to = new Date(
          new Date(`${input.date_to}T00:00:00+03:00`).getTime() +
            2 * 24 * 60 * 60 * 1000,
        );
        const booked =
          Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())
            ? []
            : await ctx.clinic.booked(from, to);
        const result = availableSlots(
          data,
          booked,
          {
            serviceId: input.service_id,
            dateFrom: input.date_from,
            dateTo: input.date_to,
            dentistId: input.dentist_id,
            fromMinute: minutes(input.time_from),
            toMinute: minutes(input.time_to),
          },
          now,
        );
        return result.ok
          ? {
              slots: result.slots,
              note: result.slots.length
                ? undefined
                : 'no free slots in this range',
            }
          : { error: result.reason };
      },
    ),
    tool(
      ctx,
      'list_my_appointments',
      "List the current patient's upcoming booked appointments.",
      z.object({}),
      async () => {
        const rows = await ctx.prisma.appointment.findMany({
          where: {
            patientId: ctx.patientId,
            status: 'booked',
            startsAt: { gt: ctx.clock.now() },
          },
          include: { service: true, dentist: true },
          orderBy: { startsAt: 'asc' },
        });
        return {
          appointments: rows.map((a) => ({
            appointment_id: a.id,
            service: `${a.service.nameEn} / ${a.service.nameAr}`,
            dentist: `${a.dentist.nameEn} / ${a.dentist.nameAr}`,
            starts_at: toRiyadhIso(a.startsAt),
            ends_at: toRiyadhIso(a.endsAt),
          })),
        };
      },
    ),
    tool(
      ctx,
      'propose_booking',
      'Propose a new appointment. Nothing is booked until the patient presses Confirm on the card shown in the chat.',
      z.object({
        service_id: z.string(),
        dentist_id: z.string(),
        slot_start: instant,
      }),
      async (input) =>
        describeProposal(
          await propose({
            type: 'book',
            serviceId: input.service_id,
            dentistId: input.dentist_id,
            slotStart: input.slot_start,
          }),
        ),
    ),
    tool(
      ctx,
      'propose_reschedule',
      "Propose moving one of the patient's appointments to a new slot (same service and dentist). Nothing changes until the patient presses Confirm.",
      z.object({ appointment_id: z.string(), new_slot_start: instant }),
      async (input) =>
        describeProposal(
          await propose({
            type: 'reschedule',
            appointmentId: input.appointment_id,
            newSlotStart: input.new_slot_start,
          }),
        ),
    ),
    tool(
      ctx,
      'propose_cancel',
      "Propose cancelling one of the patient's appointments. Nothing changes until the patient presses Confirm.",
      z.object({ appointment_id: z.string() }),
      async (input) =>
        describeProposal(
          await propose({
            type: 'cancel',
            appointmentId: input.appointment_id,
          }),
        ),
    ),
    tool(
      ctx,
      'handoff_to_staff',
      'Hand the conversation to clinic staff (medical questions, requests for a person, anything you cannot do). The assistant stops replying until staff close the hand-off.',
      z.object({
        reason: z.string(),
        summary: z.string().describe('Short summary for the staff member'),
      }),
      async (input) => {
        const existing = await ctx.prisma.handoff.findFirst({
          where: { conversationId: ctx.conversationId, status: 'open' },
        });
        if (!existing) {
          await ctx.prisma.$transaction([
            ctx.prisma.handoff.create({
              data: {
                conversationId: ctx.conversationId,
                reason: input.reason,
                summary: input.summary,
              },
            }),
            ctx.prisma.conversation.update({
              where: { id: ctx.conversationId },
              data: { status: 'handed_off' },
            }),
          ]);
        }
        return {
          handed_off: true,
          note: 'Tell the patient that clinic staff will reply in this chat.',
        };
      },
    ),
  ];
}

function describeProposal(
  result: Awaited<ReturnType<ActionsService['propose']>>,
) {
  if (!result.ok) return { proposed: false, reason: result.reason };
  return {
    proposed: true,
    action_id: result.actionId,
    details: result.payload,
    expires_at: result.expiresAt,
    note: 'The patient now sees a card with Confirm and Cancel buttons. It is not done until they press Confirm.',
  };
}
