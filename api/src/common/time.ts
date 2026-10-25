// Asia/Riyadh is UTC+3 all year (no daylight saving), so a fixed offset is exact.
export const RIYADH_OFFSET_MIN = 180;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Clinic-local calendar date (YYYY-MM-DD), weekday (0 = Sunday) and minute of day for an instant. */
export function riyadhParts(instant: Date): {
  date: string;
  weekday: number;
  minute: number;
} {
  const local = new Date(instant.getTime() + RIYADH_OFFSET_MIN * 60_000);
  return {
    date: local.toISOString().slice(0, 10),
    weekday: local.getUTCDay(),
    minute: local.getUTCHours() * 60 + local.getUTCMinutes(),
  };
}

/** The instant for a clinic-local date (YYYY-MM-DD) and minute of day. */
export function riyadhInstant(date: string, minute: number): Date {
  const midnightUtc = Date.parse(`${date}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(midnightUtc)) {
    throw new Error(`invalid date: ${date}`);
  }
  return new Date(midnightUtc + (minute - RIYADH_OFFSET_MIN) * 60_000);
}

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

export function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

/** ISO 8601 with the +03:00 offset, as shown to the model and the patient. */
export function toRiyadhIso(instant: Date): string {
  const local = new Date(instant.getTime() + RIYADH_OFFSET_MIN * 60_000);
  return `${local.toISOString().slice(0, 19)}+03:00`;
}
