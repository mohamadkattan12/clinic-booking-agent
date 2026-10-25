// The one set of booking rules, shared by availability, proposals and confirmation.
// Pure functions over loaded clinic data, so they are tested without a database.
import {
  addDays,
  riyadhInstant,
  riyadhParts,
  toRiyadhIso,
  weekdayOf,
} from '../common/time.js';

export const SLOT_STEP_MIN = 15;
export const HORIZON_DAYS = 60;
export const MAX_RANGE_DAYS = 14;
export const MAX_SLOTS = 10;
export const MAX_SLOTS_PER_DAY = 4; // spread results across days instead of one morning
export const CHANGE_CUTOFF_MS = 4 * 60 * 60 * 1000;

type Window = { startMinute: number; endMinute: number };

export interface ClinicData {
  hours: Map<number, Window>; // weekday -> opening hours
  services: Map<string, { durationMin: number }>;
  dentists: Map<
    string,
    { services: Set<string>; schedule: Map<number, Window> }
  >;
}

export interface Booked {
  id: string;
  dentistId: string;
  startsAt: Date;
  endsAt: Date;
}

export type SlotRequest = { serviceId: string; dentistId: string; start: Date };

export type RuleViolation =
  | 'unknown_service'
  | 'unknown_dentist'
  | 'dentist_does_not_offer_service'
  | 'not_on_slot_grid'
  | 'in_the_past'
  | 'beyond_booking_horizon'
  | 'clinic_closed'
  | 'dentist_not_working'
  | 'slot_taken';

export type SlotCheck =
  { ok: true; end: Date } | { ok: false; reason: RuleViolation };

/** Is this exact slot bookable? `ignoreAppointmentId` lets a reschedule ignore its own booking. */
export function checkSlot(
  data: ClinicData,
  booked: Booked[],
  req: SlotRequest,
  now: Date,
  ignoreAppointmentId?: string,
): SlotCheck {
  const service = data.services.get(req.serviceId);
  if (!service) return { ok: false, reason: 'unknown_service' };
  const dentist = data.dentists.get(req.dentistId);
  if (!dentist) return { ok: false, reason: 'unknown_dentist' };
  if (!dentist.services.has(req.serviceId))
    return { ok: false, reason: 'dentist_does_not_offer_service' };

  const start = riyadhParts(req.start);
  if (
    start.minute % SLOT_STEP_MIN !== 0 ||
    req.start.getUTCSeconds() ||
    req.start.getUTCMilliseconds()
  ) {
    return { ok: false, reason: 'not_on_slot_grid' };
  }
  if (req.start.getTime() <= now.getTime())
    return { ok: false, reason: 'in_the_past' };
  if (
    req.start.getTime() >
    now.getTime() + HORIZON_DAYS * 24 * 60 * 60 * 1000
  ) {
    return { ok: false, reason: 'beyond_booking_horizon' };
  }

  const endMinute = start.minute + service.durationMin;
  const hours = data.hours.get(start.weekday);
  if (
    !hours ||
    start.minute < hours.startMinute ||
    endMinute > hours.endMinute
  ) {
    return { ok: false, reason: 'clinic_closed' };
  }
  const shift = dentist.schedule.get(start.weekday);
  if (
    !shift ||
    start.minute < shift.startMinute ||
    endMinute > shift.endMinute
  ) {
    return { ok: false, reason: 'dentist_not_working' };
  }

  const end = new Date(req.start.getTime() + service.durationMin * 60_000);
  const clash = booked.some(
    (b) =>
      b.dentistId === req.dentistId &&
      b.id !== ignoreAppointmentId &&
      b.startsAt < end &&
      req.start < b.endsAt, // [start, end) intervals: touching is allowed
  );
  if (clash) return { ok: false, reason: 'slot_taken' };
  return { ok: true, end };
}

export type ChangeViolation = 'not_found' | 'not_booked' | 'too_late_to_change';

/** Can this patient reschedule or cancel this appointment now? */
export function checkChange(
  appointment: { patientId: string; status: string; startsAt: Date } | null,
  patientId: string,
  now: Date,
): ChangeViolation | null {
  // Another patient's appointment is reported exactly like a missing one.
  if (!appointment || appointment.patientId !== patientId) return 'not_found';
  if (appointment.status !== 'booked') return 'not_booked';
  if (appointment.startsAt.getTime() - now.getTime() < CHANGE_CUTOFF_MS)
    return 'too_late_to_change';
  return null;
}

export type AvailabilityQuery = {
  serviceId: string;
  dateFrom: string;
  dateTo: string;
  dentistId?: string;
  fromMinute?: number; // earliest start, minutes after clinic-local midnight
  toMinute?: number; // latest start
};
export type Slot = { dentistId: string; start: string; end: string };

export type RangeViolation =
  | 'invalid_date'
  | 'date_to_before_date_from'
  | 'range_too_long'
  | 'outside_booking_horizon';

/** Free slots (clinic-local dates, inclusive), earliest first: at most MAX_SLOTS_PER_DAY per day and MAX_SLOTS in total. */
export function availableSlots(
  data: ClinicData,
  booked: Booked[],
  q: AvailabilityQuery,
  now: Date,
):
  | { ok: true; slots: Slot[] }
  | { ok: false; reason: RangeViolation | RuleViolation } {
  const valid = (d: string) =>
    /^\d{4}-\d{2}-\d{2}$/.test(d) && addDays(d, 0) === d;
  if (!valid(q.dateFrom) || !valid(q.dateTo))
    return { ok: false, reason: 'invalid_date' };
  if (q.dateTo < q.dateFrom)
    return { ok: false, reason: 'date_to_before_date_from' };
  if (addDays(q.dateFrom, MAX_RANGE_DAYS - 1) < q.dateTo)
    return { ok: false, reason: 'range_too_long' };
  const today = riyadhParts(now).date;
  if (q.dateTo < today || q.dateFrom > addDays(today, HORIZON_DAYS)) {
    return { ok: false, reason: 'outside_booking_horizon' };
  }
  if (!data.services.has(q.serviceId))
    return { ok: false, reason: 'unknown_service' };
  if (q.dentistId && !data.dentists.has(q.dentistId))
    return { ok: false, reason: 'unknown_dentist' };

  const slots: Slot[] = [];
  for (
    let date = q.dateFrom;
    date <= q.dateTo && slots.length < MAX_SLOTS;
    date = addDays(date, 1)
  ) {
    const hours = data.hours.get(weekdayOf(date));
    if (!hours) continue;
    const candidates: Slot[] = [];
    for (const [dentistId] of data.dentists) {
      if (q.dentistId && dentistId !== q.dentistId) continue;
      for (
        let minute = hours.startMinute;
        minute < hours.endMinute;
        minute += SLOT_STEP_MIN
      ) {
        // The window applies before the per-day cap, or later times could never be returned.
        if (q.fromMinute !== undefined && minute < q.fromMinute) continue;
        if (q.toMinute !== undefined && minute > q.toMinute) continue;
        const start = riyadhInstant(date, minute);
        const check = checkSlot(
          data,
          booked,
          { serviceId: q.serviceId, dentistId, start },
          now,
        );
        if (check.ok)
          candidates.push({
            dentistId,
            start: toRiyadhIso(start),
            end: toRiyadhIso(check.end),
          });
      }
    }
    candidates.sort(
      (a, b) =>
        a.start.localeCompare(b.start) ||
        a.dentistId.localeCompare(b.dentistId),
    );
    slots.push(
      ...candidates.slice(
        0,
        Math.min(MAX_SLOTS_PER_DAY, MAX_SLOTS - slots.length),
      ),
    );
  }
  return { ok: true, slots };
}

type ClinicRows = {
  hours: ({ weekday: number } & Window)[];
  services: { id: string; durationMin: number }[];
  dentists: {
    id: string;
    services: { serviceId: string }[];
    schedules: ({ weekday: number } & Window)[];
  }[];
};

export function buildClinicData(rows: ClinicRows): ClinicData {
  const window = (w: Window): Window => ({
    startMinute: w.startMinute,
    endMinute: w.endMinute,
  });
  return {
    hours: new Map(rows.hours.map((h) => [h.weekday, window(h)])),
    services: new Map(
      rows.services.map((s) => [s.id, { durationMin: s.durationMin }]),
    ),
    dentists: new Map(
      rows.dentists.map((d) => [
        d.id,
        {
          services: new Set(d.services.map((s) => s.serviceId)),
          schedule: new Map(d.schedules.map((w) => [w.weekday, window(w)])),
        },
      ]),
    ),
  };
}
