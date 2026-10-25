import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ActionPayload } from '../src/actions/actions.service.js';
import { addDays, riyadhInstant } from '../src/common/time.js';
import {
  availableSlots,
  buildClinicData,
} from '../src/clinic/booking-rules.js';
import {
  CLINIC_HOURS,
  DENTISTS,
  EXISTING_APPOINTMENTS,
  PATIENTS,
  SERVICES,
} from '../src/seed/data.js';
import { matches } from './oracle.js';
import type { Scenario } from './types.js';

const scenarios: Scenario[] = JSON.parse(
  readFileSync(join(__dirname, 'scenarios.json'), 'utf-8'),
);
const NOW = riyadhInstant('2026-10-25', 9 * 60); // the runner's pinned clock
const data = buildClinicData({
  hours: CLINIC_HOURS,
  services: SERVICES,
  dentists: DENTISTS.map((d) => ({
    id: d.id,
    services: d.services.map((serviceId) => ({ serviceId })),
    schedules: d.schedule,
  })),
});

// shortcut: ignores existing bookings, so a slot could still be taken; the eval itself would show it.
function achievable(
  serviceId: string,
  dentists: string[],
  want: Parameters<typeof matches>[1],
) {
  for (let day = 0; day < 14; day++) {
    const date = addDays('2026-10-25', day);
    for (const dentistId of dentists) {
      const r = availableSlots(
        data,
        [],
        {
          serviceId,
          dentistId,
          dateFrom: date,
          dateTo: date,
          ...(want.type !== 'cancel' && {
            fromMinute: want.fromMinute,
            toMinute: want.toMinute,
          }),
        },
        NOW,
      );
      if (!r.ok) continue;
      const hit = r.slots.some((s) =>
        matches(
          {
            type: want.type,
            serviceId,
            dentistId,
            startsAt: s.start,
          } as ActionPayload,
          want,
        ),
      );
      if (hit) return true;
    }
  }
  return false;
}

describe('eval scenarios', () => {
  it('have unique ids and either scripted messages or a persona', () => {
    expect(new Set(scenarios.map((s) => s.id)).size).toBe(scenarios.length);
    for (const s of scenarios)
      expect(Boolean(s.messages) !== Boolean(s.persona)).toBe(true);
  });

  it.each(scenarios.filter((s) => s.expect.actions.length))(
    '$id: every expected change is possible with the seeded schedule',
    (s) => {
      const patient = PATIENTS[s.patient];
      for (const want of s.expect.actions) {
        const owned = EXISTING_APPOINTMENTS.filter(
          ([p, , service]) => p === patient.id && service === want.serviceId,
        );
        if (want.type === 'cancel') {
          expect(owned).toHaveLength(1);
          continue;
        }
        if (want.type === 'reschedule') expect(owned).toHaveLength(1);
        const dentists =
          want.type === 'reschedule'
            ? [owned[0][1]] // a reschedule keeps the dentist
            : want.dentistId
              ? [want.dentistId]
              : DENTISTS.filter((d) => d.services.includes(want.serviceId)).map(
                  (d) => d.id,
                );
        expect(achievable(want.serviceId, dentists, want)).toBe(true);
      }
    },
  );
});
