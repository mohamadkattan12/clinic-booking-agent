import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { ActionsService } from '../src/actions/actions.service.js';
import type { FixedClock } from '../src/common/clock.js';
import { riyadhInstant, toRiyadhIso } from '../src/common/time.js';
import type { PrismaService } from '../src/prisma/prisma.service.js';
import { PATIENTS } from '../src/seed/data.js';
import { createTestApp, HEADER, NOW, resetData } from './support/app.js';

const NOURA = PATIENTS[0].id; // has a cleaning with Dr. Sara on Monday 10:00
const KHALID = PATIENTS[1].id;
const slot = (date: string, hh: number, mm = 0) =>
  toRiyadhIso(riyadhInstant(date, hh * 60 + mm));
const MONDAY = '2026-10-26';

describe('pending actions and confirmation (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let clock: FixedClock;
  let actions: ActionsService;
  let conversationId: string;

  const confirm = (aid: string, cid = conversationId) =>
    request(app.getHttpServer())
      .post(`/conversations/${cid}/actions/${aid}/confirm`)
      .set(HEADER);
  const decline = (aid: string, cid = conversationId) =>
    request(app.getHttpServer())
      .post(`/conversations/${cid}/actions/${aid}/decline`)
      .set(HEADER);

  async function proposeBooking(
    start = slot(MONDAY, 11),
    cid = conversationId,
    patientId = NOURA,
  ) {
    const result = await actions.propose(cid, patientId, {
      type: 'book',
      serviceId: 'checkup',
      dentistId: 'dr-sara',
      slotStart: start,
    });
    if (!result.ok) throw new Error(result.reason);
    return result;
  }

  const noura = () =>
    prisma.appointment.findFirstOrThrow({
      where: { patientId: NOURA, serviceId: 'cleaning' },
    });

  beforeAll(async () => {
    ({ app, prisma, clock } = await createTestApp());
    actions = app.get(ActionsService);
  });

  beforeEach(async () => {
    clock.set(NOW);
    await resetData(prisma);
    conversationId = (
      await prisma.conversation.create({ data: { patientId: NOURA } })
    ).id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('a proposal freezes what the patient will confirm, and confirming books it', async () => {
    const proposal = await proposeBooking();
    expect(proposal.payload).toMatchObject({
      type: 'book',
      serviceNameEn: 'Check-up',
      dentistNameEn: 'Dr. Sara Al-Qahtani',
      startsAt: '2026-10-26T11:00:00+03:00',
      endsAt: '2026-10-26T11:20:00+03:00',
      priceHalalas: 15000,
    });
    expect(
      await prisma.appointment.count({ where: { patientId: NOURA } }),
    ).toBe(1); // nothing written yet

    const res = await confirm(proposal.actionId).expect(200);
    expect(res.body).toMatchObject({
      status: 'confirmed',
      outcome: { ok: true },
    });
    expect(
      await prisma.appointment.count({
        where: { patientId: NOURA, status: 'booked' },
      }),
    ).toBe(2);
    const event = await prisma.message.findFirstOrThrow({
      where: { conversationId, role: 'event' },
    });
    expect(event.content).toMatchObject({
      kind: 'action_outcome',
      status: 'confirmed',
    });
  });

  it('rejects requests without the app header', async () => {
    const { actionId } = await proposeBooking();
    await request(app.getHttpServer())
      .post(`/conversations/${conversationId}/actions/${actionId}/confirm`)
      .expect(403);
  });

  it("another conversation cannot confirm this conversation's action (404)", async () => {
    const { actionId } = await proposeBooking();
    const other = await prisma.conversation.create({
      data: { patientId: KHALID },
    });
    await confirm(actionId, other.id).expect(404);
    await decline(actionId, other.id).expect(404);
    expect(
      (
        await prisma.pendingAction.findUniqueOrThrow({
          where: { id: actionId },
        })
      ).status,
    ).toBe('pending');
  });

  it('an expired action cannot be confirmed (410)', async () => {
    const { actionId } = await proposeBooking();
    clock.set(new Date(NOW.getTime() + 10 * 60 * 1000)); // exactly the 10-minute expiry
    const res = await confirm(actionId).expect(410);
    expect(res.body).toMatchObject({ reason: 'expired' });
    expect(
      (
        await prisma.pendingAction.findUniqueOrThrow({
          where: { id: actionId },
        })
      ).status,
    ).toBe('expired');
  });

  it('a newer proposal supersedes the older one (410)', async () => {
    const first = await proposeBooking(slot(MONDAY, 11));
    const second = await proposeBooking(slot(MONDAY, 12));
    expect((await confirm(first.actionId).expect(410)).body).toMatchObject({
      reason: 'superseded',
    });
    await confirm(second.actionId).expect(200);
  });

  it('confirming the same action twice writes once and returns the same outcome', async () => {
    const { actionId } = await proposeBooking();
    const [a, b] = await Promise.all([confirm(actionId), confirm(actionId)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(a.body.outcome.appointmentId).toBe(b.body.outcome.appointmentId);
    expect(
      await prisma.appointment.count({
        where: { patientId: NOURA, serviceId: 'checkup' },
      }),
    ).toBe(1);
    const retry = await confirm(actionId).expect(200);
    expect(retry.body.outcome.appointmentId).toBe(a.body.outcome.appointmentId);
  });

  it('two actions for the same slot: one books, the other gets 409 slot_taken', async () => {
    const mine = await proposeBooking(slot(MONDAY, 11));
    const otherConversation = (
      await prisma.conversation.create({ data: { patientId: KHALID } })
    ).id;
    const theirs = await proposeBooking(
      slot(MONDAY, 11),
      otherConversation,
      KHALID,
    );
    const [a, b] = await Promise.all([
      confirm(mine.actionId),
      confirm(theirs.actionId, otherConversation),
    ]);
    expect([a.status, b.status].sort((x, y) => x - y)).toEqual([200, 409]);
    expect([a, b].find((r) => r.status === 409)!.body).toMatchObject({
      reason: 'slot_taken',
    });
    const contested = {
      dentistId: 'dr-sara',
      startsAt: riyadhInstant(MONDAY, 11 * 60),
      status: 'booked' as const,
    };
    expect(await prisma.appointment.count({ where: contested })).toBe(1);
    // the failure is stored: a retry gives the same answer
    const loser = a.status === 409 ? mine.actionId : theirs.actionId;
    const loserConversation =
      a.status === 409 ? conversationId : otherConversation;
    await confirm(loser, loserConversation).expect(409);
  });

  it('a stale reschedule cannot undo a newer change (409 appointment_changed)', async () => {
    const appointment = await noura();
    const old = await actions.propose(conversationId, NOURA, {
      type: 'reschedule',
      appointmentId: appointment.id,
      newSlotStart: slot(MONDAY, 12),
    });
    if (!old.ok) throw new Error(old.reason);
    // the appointment changes through another conversation in the meantime
    const other = (
      await prisma.conversation.create({ data: { patientId: NOURA } })
    ).id;
    const newer = await actions.propose(other, NOURA, {
      type: 'reschedule',
      appointmentId: appointment.id,
      newSlotStart: slot(MONDAY, 14),
    });
    if (!newer.ok) throw new Error(newer.reason);
    await confirm(newer.actionId, other).expect(200);

    const res = await confirm(old.actionId).expect(409);
    expect(res.body).toMatchObject({ reason: 'appointment_changed' });
    const after = await noura();
    expect(toRiyadhIso(after.startsAt)).toBe('2026-10-26T14:00:00+03:00');
    expect(after.version).toBe(2);
  });

  it('reschedule and cancel racing on one appointment: exactly one wins', async () => {
    const appointment = await noura();
    const c1 = conversationId;
    const c2 = (
      await prisma.conversation.create({ data: { patientId: NOURA } })
    ).id;
    const move = await actions.propose(c1, NOURA, {
      type: 'reschedule',
      appointmentId: appointment.id,
      newSlotStart: slot(MONDAY, 12),
    });
    const cancel = await actions.propose(c2, NOURA, {
      type: 'cancel',
      appointmentId: appointment.id,
    });
    if (!move.ok || !cancel.ok) throw new Error('propose failed');
    const [a, b] = await Promise.all([
      confirm(move.actionId, c1),
      confirm(cancel.actionId, c2),
    ]);
    expect([a.status, b.status].sort((x, y) => x - y)).toEqual([200, 409]);
    expect((await noura()).version).toBe(2);
  });

  it("a patient cannot propose changes to another patient's appointment", async () => {
    const khalids = await prisma.appointment.findFirstOrThrow({
      where: { patientId: KHALID },
    });
    const result = await actions.propose(conversationId, NOURA, {
      type: 'cancel',
      appointmentId: khalids.id,
    });
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it('confirm re-checks the 4-hour cutoff at execution time', async () => {
    const appointment = await noura(); // Monday 10:00 Riyadh
    const fourHours = 4 * 60 * 60 * 1000;
    // proposed 1 minute before the cutoff (allowed), confirmed 1 minute after it (refused)
    clock.set(new Date(appointment.startsAt.getTime() - fourHours - 60_000));
    const cancel = await actions.propose(conversationId, NOURA, {
      type: 'cancel',
      appointmentId: appointment.id,
    });
    if (!cancel.ok) throw new Error(cancel.reason);
    clock.set(new Date(appointment.startsAt.getTime() - fourHours + 60_000));
    const res = await confirm(cancel.actionId).expect(409);
    expect(res.body).toMatchObject({ reason: 'too_late_to_change' });
    expect((await noura()).status).toBe('booked');
  });

  it('declining leaves the appointment untouched; a later confirm gets 410', async () => {
    const { actionId } = await proposeBooking();
    await decline(actionId).expect(200);
    await decline(actionId).expect(200); // idempotent
    expect((await confirm(actionId).expect(410)).body).toMatchObject({
      reason: 'declined',
    });
    expect(
      await prisma.appointment.count({ where: { patientId: NOURA } }),
    ).toBe(1);
  });

  it('rejects malformed ids and offset-free times', async () => {
    await confirm('not-a-uuid').expect(400);
    const result = await actions.propose(conversationId, NOURA, {
      type: 'book',
      serviceId: 'checkup',
      dentistId: 'dr-sara',
      slotStart: '2026-10-26T11:00:00', // no offset: ambiguous
    });
    expect(result).toEqual({ ok: false, reason: 'invalid_time' });
  });
});
