import { createPrismaClient } from '../src/prisma/prisma.service.js';
import { riyadhInstant, riyadhParts } from '../src/common/time.js';
import { seed } from '../src/seed/seed.js';

const prisma = createPrismaClient();
const NOW = new Date('2026-10-25T09:00:00+03:00'); // a Sunday in Riyadh

beforeAll(async () => {
  // e2e files share one database: start from empty, whatever ran before
  await prisma.$executeRawUnsafe(
    'TRUNCATE tool_calls, handoffs, pending_actions, messages, turns, conversations, appointments CASCADE',
  );
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('schema and seed', () => {
  it('seeding twice leaves the same rows', async () => {
    await seed(prisma, NOW);
    const counts = async () =>
      Promise.all([
        prisma.service.count(),
        prisma.dentist.count(),
        prisma.schedule.count(),
        prisma.patient.count(),
        prisma.appointment.count(),
      ]);
    const first = await counts();
    await seed(prisma, NOW);
    expect(await counts()).toEqual(first);
    expect(first).toEqual([7, 3, 13, 4, 4]);
  });

  it('seeded appointments are in the future and inside the dentist schedule', async () => {
    const appointments = await prisma.appointment.findMany({
      include: { dentist: { include: { schedules: true } } },
    });
    expect(appointments).toHaveLength(4);
    for (const a of appointments) {
      expect(a.startsAt.getTime()).toBeGreaterThan(NOW.getTime());
      const start = riyadhParts(a.startsAt);
      const end = riyadhParts(a.endsAt);
      const day = a.dentist.schedules.find((d) => d.weekday === start.weekday);
      expect(
        day,
        `${a.dentistId} works on weekday ${start.weekday}`,
      ).toBeDefined();
      expect(start.minute).toBeGreaterThanOrEqual(day!.startMinute);
      expect(end.minute).toBeLessThanOrEqual(day!.endMinute);
    }
  });

  it('the database rejects overlapping booked appointments for one dentist', async () => {
    const existing = await prisma.appointment.findFirstOrThrow({
      where: { dentistId: 'dr-sara' },
    });
    const overlapping = {
      patientId: existing.patientId,
      dentistId: existing.dentistId,
      serviceId: existing.serviceId,
      startsAt: new Date(existing.startsAt.getTime() + 10 * 60_000),
      endsAt: new Date(existing.endsAt.getTime() + 10 * 60_000),
    };
    await expect(
      prisma.appointment.create({ data: overlapping }),
    ).rejects.toThrow(/appointments_no_overlap|exclusion/i);
    // a cancelled appointment does not block the slot
    const cancelled = await prisma.appointment.create({
      data: { ...overlapping, status: 'cancelled' },
    });
    await prisma.appointment.delete({ where: { id: cancelled.id } });
  });

  it('adjacent appointments ([start, end) intervals) are allowed', async () => {
    const existing = await prisma.appointment.findFirstOrThrow({
      where: { dentistId: 'dr-sara' },
    });
    const next = await prisma.appointment.create({
      data: {
        patientId: existing.patientId,
        dentistId: existing.dentistId,
        serviceId: 'checkup',
        startsAt: existing.endsAt,
        endsAt: new Date(existing.endsAt.getTime() + 20 * 60_000),
      },
    });
    await prisma.appointment.delete({ where: { id: next.id } });
  });

  it('allows at most one open hand-off per conversation', async () => {
    const conversation = await prisma.conversation.create({
      data: { patientId: (await prisma.patient.findFirstOrThrow()).id },
    });
    await prisma.handoff.create({
      data: { conversationId: conversation.id, reason: 'r', summary: 's' },
    });
    await expect(
      prisma.handoff.create({
        data: { conversationId: conversation.id, reason: 'r', summary: 's' },
      }),
    ).rejects.toThrow();
  });

  it('time helpers convert Riyadh local time', () => {
    expect(riyadhInstant('2026-10-26', 10 * 60).toISOString()).toBe(
      '2026-10-26T07:00:00.000Z',
    );
  });
});
