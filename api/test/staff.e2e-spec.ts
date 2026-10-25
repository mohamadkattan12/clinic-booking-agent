import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { PrismaService } from '../src/prisma/prisma.service.js';
import { PATIENTS } from '../src/seed/data.js';
import { createTestApp, HEADER, resetData } from './support/app.js';
import {
  type FakeClaude,
  reply,
  text,
  toolUse,
} from './support/fake-claude.js';

describe('staff and trace views (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let claude: FakeClaude;
  const previousKey = process.env.ANTHROPIC_API_KEY;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    ({ app, prisma, claude } = await createTestApp());
  });

  beforeEach(async () => {
    await resetData(prisma);
  });

  afterAll(async () => {
    process.env.ANTHROPIC_API_KEY = previousKey;
    await app.close();
  });

  it('lists booked appointments for the coming days, with dentist and patient', async () => {
    const res = await http().get('/staff/appointments?days=14').expect(200);
    expect(res.body).toHaveLength(4); // the seeded bookings
    expect(res.body[0]).toMatchObject({
      dentist: { id: expect.any(String) },
      patient: { name: expect.any(String) },
    });
    expect(res.body[0].startsAt).toMatch(/\+03:00$/);
    const sorted = [...res.body].sort((a, b) =>
      a.startsAt.localeCompare(b.startsAt),
    );
    expect(res.body).toEqual(sorted);
  });

  it('shows open hand-offs and closing one lets the agent answer again', async () => {
    const cid = (
      await http()
        .post('/conversations')
        .set(HEADER)
        .send({ patientId: PATIENTS[2].id })
        .expect(201)
    ).body.id;
    claude.script = [
      reply(
        [
          toolUse('handoff_to_staff', {
            reason: 'medical',
            summary: 'tooth pain for 2 days',
          }),
        ],
        'tool_use',
      ),
      reply([text('Staff will reply.')]),
    ];
    await http()
      .post(`/conversations/${cid}/messages`)
      .set(HEADER)
      .send({ clientMessageId: randomUUID(), text: 'pain' })
      .expect(200);

    const open = await http().get('/staff/handoffs').expect(200);
    expect(open.body).toHaveLength(1);
    expect(open.body[0]).toMatchObject({
      conversationId: cid,
      summary: 'tooth pain for 2 days',
      patient: { name: PATIENTS[2].name },
    });

    await http().post(`/staff/handoffs/${open.body[0].id}/close`).expect(403); // app header required
    await http()
      .post(`/staff/handoffs/${open.body[0].id}/close`)
      .set(HEADER)
      .expect(200);
    expect((await http().get('/staff/handoffs').expect(200)).body).toHaveLength(
      0,
    );

    claude.script = [reply([text('Hello again.')])];
    const calls = claude.calls.length;
    await http()
      .post(`/conversations/${cid}/messages`)
      .set(HEADER)
      .send({ clientMessageId: randomUUID(), text: 'hi' })
      .expect(200);
    expect(claude.calls.length).toBe(calls + 1); // the agent is back
  });

  it('traces each turn with its tool calls, cost and the pending actions', async () => {
    const cid = (
      await http()
        .post('/conversations')
        .set(HEADER)
        .send({ patientId: PATIENTS[0].id })
        .expect(201)
    ).body.id;
    claude.script = [
      reply(
        [
          toolUse('propose_booking', {
            service_id: 'checkup',
            dentist_id: 'dr-sara',
            slot_start: '2026-10-26T11:00:00+03:00',
          }),
        ],
        'tool_use',
      ),
      reply([text('Press Confirm.')]),
    ];
    await http()
      .post(`/conversations/${cid}/messages`)
      .set(HEADER)
      .send({ clientMessageId: randomUUID(), text: 'book' })
      .expect(200);
    const trace = await http().get(`/trace/${cid}`).expect(200);
    expect(trace.body.totals).toMatchObject({ turns: 1, costUsd: 0.006 });
    expect(trace.body.turns[0].toolCalls[0]).toMatchObject({
      name: 'propose_booking',
      result: { proposed: true },
    });
    expect(trace.body.actions[0]).toMatchObject({
      type: 'book',
      status: 'pending',
    });
    await http().get(`/trace/${randomUUID()}`).expect(404);
  });
});
