import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import {
  ConversationsService,
  toApiMessages,
} from '../src/conversations/conversations.service.js';
import { AppModule } from '../src/app.module.js';
import type { PrismaService } from '../src/prisma/prisma.service.js';
import { PATIENTS } from '../src/seed/data.js';
import { createTestApp, HEADER, resetData } from './support/app.js';
import type { FakeClaude } from './support/fake-claude.js';
import { reply, text, toolUse } from './support/fake-claude.js';

const NOURA = PATIENTS[0];

function events(
  body: string,
): { event: string; data: Record<string, unknown> }[] {
  return body
    .trim()
    .split('\n\n')
    .filter(Boolean)
    .map((block) => {
      const lines = block.split('\n');
      return {
        event: lines.find((l) => l.startsWith('event: '))!.slice(7),
        data: JSON.parse(lines.find((l) => l.startsWith('data: '))!.slice(6)),
      };
    });
}

describe('conversations and turns (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let claude: FakeClaude;
  let conversationId: string;
  const previousKey = process.env.ANTHROPIC_API_KEY;

  const send = (
    text: string,
    clientMessageId: string = randomUUID(),
    cid = conversationId,
  ) =>
    request(app.getHttpServer())
      .post(`/conversations/${cid}/messages`)
      .set(HEADER)
      .send({ clientMessageId, text });

  beforeAll(async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    ({ app, prisma, claude } = await createTestApp());
  });

  beforeEach(async () => {
    await resetData(prisma);
    claude.calls = [];
    const res = await request(app.getHttpServer())
      .post('/conversations')
      .set(HEADER)
      .send({ patientId: NOURA.id })
      .expect(201);
    conversationId = res.body.id;
  });

  afterAll(async () => {
    process.env.ANTHROPIC_API_KEY = previousKey;
    await app.close();
  });

  it('streams a reply, stores the completed turn, and shows it in the conversation', async () => {
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
      reply([text('Please press Confirm on the card.')]),
    ];
    const res = await send('Book a check-up Monday 11:00 with Dr. Sara').expect(
      200,
    );
    expect(res.headers['content-type']).toContain('text/event-stream');
    const evs = events(res.text);
    expect(evs.map((e) => e.event)).toEqual(['delta', 'done']);
    expect(evs[1].data).toMatchObject({
      status: 'answered',
      handedOff: false,
      stop: 'end_turn',
    });
    expect(evs[1].data.actionIds).toHaveLength(1);

    expect(
      await prisma.turn.count({
        where: { conversationId, status: 'completed' },
      }),
    ).toBe(1);
    expect(await prisma.toolCall.count({ where: { conversationId } })).toBe(1);
    const view = await request(app.getHttpServer())
      .get(`/conversations/${conversationId}`)
      .expect(200);
    expect(view.body.messages.map((m: { role: string }) => m.role)).toEqual([
      'patient',
      'agent',
    ]);
    expect(view.body.messages[0].text).toBe(
      'Book a check-up Monday 11:00 with Dr. Sara',
    ); // context block hidden
    expect(view.body.actions[0]).toMatchObject({
      status: 'pending',
      payload: { dentistNameEn: 'Dr. Sara Al-Qahtani' },
    });
    // The card shows after the turn that proposed it, not above the patient's request.
    const lastOfTurn = view.body.messages.at(-1).sortKey as string;
    expect(view.body.actions[0].sortKey > lastOfTurn).toBe(true);
  });

  it('ignores a repeated clientMessageId without calling the model again', async () => {
    claude.script = [reply([text('hello')])];
    const id = randomUUID();
    await send('hi', id).expect(200);
    const again = await send('hi', id).expect(200);
    expect(events(again.text)[0].data).toEqual({ status: 'duplicate' });
    expect(claude.calls).toHaveLength(1);
  });

  it('allows one turn at a time per conversation (409 for a concurrent message)', async () => {
    // Another turn holds the conversation's lock: a second message is refused and nothing is stored.
    const running = randomUUID();
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { activeTurnId: running },
    });
    const blocked = await send('second').expect(409);
    expect(blocked.body.message).toContain('still being answered');
    expect(await prisma.message.count({ where: { conversationId } })).toBe(0);
    expect(claude.calls).toHaveLength(0);
    // The running turn's lock is untouched by the refused request.
    expect(
      (
        await prisma.conversation.findUniqueOrThrow({
          where: { id: conversationId },
        })
      ).activeTurnId,
    ).toBe(running);
  });

  it('a turn lock left by a crashed or restarted API is released when the API starts', async () => {
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { activeTurnId: randomUUID() }, // the process died mid-turn
    });
    const restarted = (
      await Test.createTestingModule({ imports: [AppModule] }).compile()
    ).createNestApplication();
    await restarted.init();
    await restarted.close();
    expect(
      (
        await prisma.conversation.findUniqueOrThrow({
          where: { id: conversationId },
        })
      ).activeTurnId,
    ).toBeNull();
  });

  it('two simultaneous messages: one is answered, the other gets 409', async () => {
    claude.script = [reply([text('ok')])];
    const [a, b] = await Promise.all([send('one'), send('two')]);
    expect([a.status, b.status].sort((x, y) => x - y)).toEqual([200, 409]);
    expect(await prisma.turn.count({ where: { conversationId } })).toBe(1);
  });

  it('a failure mid-turn stores no messages, releases the lock, and asks to resend', async () => {
    claude.script = [
      reply([toolUse('list_my_appointments', {})], 'tool_use'),
      new Error('overloaded_error'),
    ];
    const res = await send('my appointments?').expect(200);
    const evs = events(res.text);
    expect(evs.at(-1)).toMatchObject({
      event: 'error',
      data: { resend: true },
    });
    expect(await prisma.message.count({ where: { conversationId } })).toBe(0);
    expect(
      await prisma.turn.findFirst({ where: { conversationId } }),
    ).toMatchObject({ status: 'failed' });
    expect(
      (
        await prisma.conversation.findUniqueOrThrow({
          where: { id: conversationId },
        })
      ).activeTurnId,
    ).toBeNull();

    claude.script = [reply([text('Here they are.')])];
    await send('my appointments?').expect(200); // resend works
    expect(await prisma.message.count({ where: { conversationId } })).toBe(2);
  });

  it('a proposal from a failed turn is not shown in the chat', async () => {
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
      new Error('overloaded_error'),
    ];
    await send('book Monday 11').expect(200); // ends with the "please resend" event
    expect(
      await prisma.pendingAction.count({ where: { conversationId } }),
    ).toBe(1);
    const view = await request(app.getHttpServer())
      .get(`/conversations/${conversationId}`)
      .expect(200);
    expect(view.body.actions).toEqual([]); // the patient never saw the agent offer it
  });

  it('a client disconnect mid-turn stores nothing from that turn', async () => {
    const abort = new AbortController();
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
      (() => {
        abort.abort(); // the browser goes away right after the proposal
        return reply([text('never delivered')]);
      }) as never,
      reply([text('never delivered')]),
    ];
    const service = app.get(ConversationsService);
    await expect(
      service.send(
        conversationId,
        randomUUID(),
        'book',
        () => undefined,
        abort.signal,
      ),
    ).rejects.toThrow();
    expect(await prisma.message.count({ where: { conversationId } })).toBe(0);
    // the proposal record exists but was never shown; it simply expires
    expect(
      await prisma.pendingAction.count({
        where: { conversationId, status: 'pending' },
      }),
    ).toBe(1);
    expect(
      (
        await prisma.conversation.findUniqueOrThrow({
          where: { id: conversationId },
        })
      ).activeTurnId,
    ).toBeNull();
  });

  it('after a hand-off the model is not called; messages wait for staff', async () => {
    claude.script = [
      reply(
        [toolUse('handoff_to_staff', { reason: 'medical', summary: 'pain' })],
        'tool_use',
      ),
      reply([text('Staff will reply here.')]),
    ];
    const first = await send(
      'I have strong tooth pain, what medicine should I take?',
    ).expect(200);
    expect(events(first.text).at(-1)!.data).toMatchObject({ handedOff: true });
    const calls = claude.calls.length;
    const next = await send('hello?').expect(200);
    expect(events(next.text)[0].data).toEqual({ status: 'handed_off' });
    expect(claude.calls).toHaveLength(calls);
  });

  it('replays confirm/decline events to the model as clinic messages', async () => {
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
    const first = await send('book Monday 11').expect(200);
    const [actionId] = events(first.text).at(-1)!.data.actionIds as string[];
    await request(app.getHttpServer())
      .post(`/conversations/${conversationId}/actions/${actionId}/confirm`)
      .set(HEADER)
      .expect(200);

    claude.script = [reply([text('You are booked.')])];
    await send('thanks').expect(200);
    const sent = claude.calls.at(-1)!.messages as {
      role: string;
      content: { type: string; text?: string }[];
    }[];
    expect(sent.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
      'user',
    ]);
    const last = sent
      .at(-1)!
      .content.map((b) => b.text ?? '')
      .join(' ');
    expect(last).toContain(
      '[Clinic system] The patient pressed Confirm. Booked: Check-up with Dr. Sara Al-Qahtani',
    );
    expect(last).toContain('thanks');
  });

  it('validates input and the app header', async () => {
    await request(app.getHttpServer())
      .post(`/conversations/${conversationId}/messages`)
      .send({ clientMessageId: randomUUID(), text: 'x' })
      .expect(403);
    await send('').expect(400);
    await request(app.getHttpServer())
      .post(`/conversations/${conversationId}/messages`)
      .set(HEADER)
      .send({ clientMessageId: 'nope', text: 'x' })
      .expect(400);
    await request(app.getHttpServer())
      .post(`/conversations/${conversationId}/messages`)
      .set(HEADER)
      .send({ clientMessageId: randomUUID(), text: 'x', extra: 1 })
      .expect(400);
    await send('hi', randomUUID(), randomUUID()).expect(404);
    await request(app.getHttpServer())
      .post('/conversations')
      .set(HEADER)
      .send({ patientId: randomUUID() })
      .expect(404);
  });

  it('merges consecutive user-side messages when building history', () => {
    const merged = toApiMessages([
      { role: 'assistant', content: [{ type: 'text', text: 'Press Confirm' }] },
      {
        role: 'event',
        content: {
          kind: 'action_outcome',
          actionId: 'a',
          status: 'declined',
          outcome: null,
        },
      },
      { role: 'user', content: [{ type: 'text', text: 'ok' }] },
    ] as never);
    expect(merged.map((m) => m.role)).toEqual(['assistant', 'user']);
    expect(merged[1].content).toHaveLength(2);
  });
});
