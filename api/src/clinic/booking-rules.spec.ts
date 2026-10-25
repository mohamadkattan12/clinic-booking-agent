import { riyadhInstant } from '../common/time.js';
import { CLINIC_HOURS, DENTISTS, SERVICES } from '../seed/data.js';
import {
  availableSlots,
  type Booked,
  buildClinicData,
  checkChange,
  checkSlot,
  MAX_SLOTS_PER_DAY,
} from './booking-rules.js';

const data = buildClinicData({
  hours: CLINIC_HOURS,
  services: SERVICES,
  dentists: DENTISTS.map((d) => ({
    id: d.id,
    services: d.services.map((serviceId) => ({ serviceId })),
    schedules: d.schedule,
  })),
});
// Sunday 2026-10-25 09:00 Riyadh. Monday is 2026-10-26, Friday 2026-10-30 (closed).
const NOW = riyadhInstant('2026-10-25', 9 * 60);
const at = (date: string, hh: number, mm = 0) =>
  riyadhInstant(date, hh * 60 + mm);
const sara = (start: Date, serviceId = 'checkup') => ({
  serviceId,
  dentistId: 'dr-sara',
  start,
});

describe('checkSlot', () => {
  it('accepts a free slot inside clinic hours and the dentist schedule', () => {
    const result = checkSlot(data, [], sara(at('2026-10-26', 10)), NOW);
    expect(result).toEqual({ ok: true, end: at('2026-10-26', 10, 20) });
  });

  it.each([
    [
      'unknown_service',
      {
        serviceId: 'massage',
        dentistId: 'dr-sara',
        start: at('2026-10-26', 10),
      },
    ],
    [
      'unknown_dentist',
      { serviceId: 'checkup', dentistId: 'dr-x', start: at('2026-10-26', 10) },
    ],
    [
      'dentist_does_not_offer_service',
      {
        serviceId: 'root-canal',
        dentistId: 'dr-sara',
        start: at('2026-10-26', 10),
      },
    ],
    ['not_on_slot_grid', sara(at('2026-10-26', 10, 5))],
    ['in_the_past', sara(at('2026-10-25', 9))],
    ['beyond_booking_horizon', sara(at('2026-12-28', 10))],
    ['clinic_closed', sara(at('2026-10-30', 10))], // Friday
    [
      'dentist_not_working',
      {
        serviceId: 'checkup',
        dentistId: 'dr-omar',
        start: at('2026-10-26', 10),
      },
    ], // Omar starts 13:00
    ['dentist_not_working', sara(at('2026-10-26', 16, 45))], // 20 min ends 17:05 after Sara's 17:00
  ])('rejects %s', (reason, req) => {
    expect(checkSlot(data, [], req, NOW)).toEqual({ ok: false, reason });
  });

  it('allows a slot ending exactly when the dentist stops', () => {
    // 30-minute cleaning at 16:30 ends exactly at Sara's 17:00
    expect(
      checkSlot(data, [], sara(at('2026-10-26', 16, 30), 'cleaning'), NOW).ok,
    ).toBe(true);
  });

  it('treats intervals as [start, end): adjacent is fine, overlap is not', () => {
    const booked: Booked[] = [
      {
        id: 'a',
        dentistId: 'dr-sara',
        startsAt: at('2026-10-26', 10),
        endsAt: at('2026-10-26', 10, 30),
      },
    ];
    expect(
      checkSlot(data, booked, sara(at('2026-10-26', 10, 30)), NOW).ok,
    ).toBe(true);
    expect(checkSlot(data, booked, sara(at('2026-10-26', 9, 45)), NOW)).toEqual(
      { ok: false, reason: 'slot_taken' },
    );
    // another dentist's booking does not block Sara
    expect(
      checkSlot(
        data,
        [{ ...booked[0], dentistId: 'dr-lina' }],
        sara(at('2026-10-26', 10)),
        NOW,
      ).ok,
    ).toBe(true);
    // a reschedule ignores its own appointment
    expect(
      checkSlot(data, booked, sara(at('2026-10-26', 10)), NOW, 'a').ok,
    ).toBe(true);
  });

  it('handles the Riyadh midnight / UTC date crossover', () => {
    // 23:50 Sunday in Riyadh is 20:50 UTC Sunday; Monday 00:15 Riyadh is still Sunday in UTC.
    const lateSunday = riyadhInstant('2026-10-25', 23 * 60 + 50);
    expect(checkSlot(data, [], sara(at('2026-10-26', 9)), lateSunday).ok).toBe(
      true,
    );
    expect(
      checkSlot(data, [], sara(at('2026-10-26', 0, 15)), lateSunday),
    ).toEqual({ ok: false, reason: 'clinic_closed' });
  });
});

describe('checkChange', () => {
  const appointment = {
    patientId: 'p1',
    status: 'booked',
    startsAt: at('2026-10-25', 13),
  };

  it('allows a change exactly 4 hours before the start', () => {
    expect(checkChange(appointment, 'p1', NOW)).toBeNull();
  });

  it('rejects a change less than 4 hours before the start', () => {
    expect(checkChange(appointment, 'p1', new Date(NOW.getTime() + 1000))).toBe(
      'too_late_to_change',
    );
  });

  it("reports another patient's appointment as not found", () => {
    expect(checkChange(appointment, 'p2', NOW)).toBe('not_found');
    expect(checkChange(null, 'p1', NOW)).toBe('not_found');
  });

  it('rejects cancelled appointments', () => {
    expect(
      checkChange({ ...appointment, status: 'cancelled' }, 'p1', NOW),
    ).toBe('not_booked');
  });
});

describe('availableSlots', () => {
  it('returns free slots on working days only, spread across days', () => {
    const result = availableSlots(
      data,
      [],
      { serviceId: 'cleaning', dateFrom: '2026-10-26', dateTo: '2026-10-31' },
      NOW,
    );
    if (!result.ok) throw new Error(result.reason);
    expect(result.slots.length).toBe(10);
    expect(result.slots[0]).toEqual({
      dentistId: 'dr-sara',
      start: '2026-10-26T09:00:00+03:00',
      end: '2026-10-26T09:30:00+03:00',
    });
    const perDay = new Map<string, number>();
    for (const s of result.slots)
      perDay.set(
        s.start.slice(0, 10),
        (perDay.get(s.start.slice(0, 10)) ?? 0) + 1,
      );
    expect(Math.max(...perDay.values())).toBeLessThanOrEqual(MAX_SLOTS_PER_DAY);
    expect(perDay.has('2026-10-30')).toBe(false); // Friday closed
    expect(result.slots.every((s) => s.dentistId !== 'dr-omar')).toBe(true); // Omar doesn't clean teeth
  });

  it('skips booked times and can filter by dentist', () => {
    const booked: Booked[] = [
      {
        id: 'a',
        dentistId: 'dr-lina',
        startsAt: at('2026-10-26', 10),
        endsAt: at('2026-10-26', 11),
      },
    ];
    const result = availableSlots(
      data,
      booked,
      {
        serviceId: 'cleaning',
        dateFrom: '2026-10-26',
        dateTo: '2026-10-26',
        dentistId: 'dr-lina',
      },
      NOW,
    );
    if (!result.ok) throw new Error(result.reason);
    expect(result.slots[0].start).toBe('2026-10-26T11:00:00+03:00');
  });

  it.each([
    ['invalid_date', { dateFrom: '2026-02-30', dateTo: '2026-03-01' }],
    ['invalid_date', { dateFrom: 'tomorrow', dateTo: '2026-10-27' }],
    [
      'date_to_before_date_from',
      { dateFrom: '2026-10-28', dateTo: '2026-10-27' },
    ],
    ['range_too_long', { dateFrom: '2026-10-26', dateTo: '2026-11-09' }],
    [
      'outside_booking_horizon',
      { dateFrom: '2026-10-01', dateTo: '2026-10-02' },
    ],
  ])('rejects %s', (reason, range) => {
    expect(
      availableSlots(data, [], { serviceId: 'cleaning', ...range }, NOW),
    ).toEqual({ ok: false, reason });
  });

  it('can find evening slots: a time window is applied before the per-day cap', () => {
    // Without a window only the first slots of each day come back, so a patient asking for
    // "after 17:00" could never be offered one.
    const result = availableSlots(
      data,
      [],
      {
        serviceId: 'checkup',
        dateFrom: '2026-10-27',
        dateTo: '2026-10-27',
        dentistId: 'dr-omar',
        fromMinute: 17 * 60,
      },
      NOW,
    );
    if (!result.ok) throw new Error(result.reason);
    expect(result.slots[0].start).toBe('2026-10-27T17:00:00+03:00');
    const until = availableSlots(
      data,
      [],
      {
        serviceId: 'cleaning',
        dateFrom: '2026-10-26',
        dateTo: '2026-10-26',
        dentistId: 'dr-sara',
        fromMinute: 13 * 60,
        toMinute: 14 * 60,
      },
      NOW,
    );
    if (!until.ok) throw new Error(until.reason);
    expect(until.slots.map((s) => s.start.slice(11, 16))).toEqual([
      '13:00',
      '13:15',
      '13:30',
      '13:45',
    ]);
  });

  it('allows a 14-day range', () => {
    expect(
      availableSlots(
        data,
        [],
        { serviceId: 'cleaning', dateFrom: '2026-10-26', dateTo: '2026-11-08' },
        NOW,
      ).ok,
    ).toBe(true);
  });
});
