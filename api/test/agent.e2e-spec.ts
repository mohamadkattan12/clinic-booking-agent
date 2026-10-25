import type Anthropic from '@anthropic-ai/sdk';
import type { INestApplication } from '@nestjs/common';
import { ActionsService } from '../src/actions/actions.service.js';
import { AgentService, type TurnInput } from '../src/agent/agent.service.js';
import { Clock, type FixedClock } from '../src/common/clock.js';
import { ClinicService } from '../src/clinic/clinic.service.js';
import type { PrismaService } from '../src/prisma/prisma.service.js';
import { PATIENTS } from '../src/seed/data.js';
import { createTestApp, resetData } from './support/app.js';
import { FakeClaude, reply, text, toolUse } from './support/fake-claude.js';

const NOURA = PATIENTS[0];
const KHALID = PATIENTS[1];

describe('agent turn (e2e, fake Claude, real tools and database)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let conversationId: string;

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
  });

  beforeEach(async () => {
    await resetData(prisma);
    conversationId = (
      await prisma.conversation.create({ data: { patientId: NOURA.id } })
    ).id;
  });

  afterAll(async () => {
    await app.close();
  });

  function agent(fake: FakeClaude) {
    return new AgentService(
      fake as unknown as Anthropic,
      prisma,
      app.get(ClinicService),
      app.get(ActionsService),
      app.get(Clock) as FixedClock,
    );
  }
  const turn = (fake: FakeClaude, extra: Partial<TurnInput> = {}) =>
    agent(fake).runTurn({
      conversationId,
      patient: NOURA,
      history: [],
      text: 'أبغى موعد فحص يوم الاثنين',
      ...extra,
    });

  it('a reply cut off at max_tokens leaves no unanswered tool_use in the stored history', async () => {
    const fake = new FakeClaude([
      reply(
        [
          text('Let me check'),
          toolUse('check_availability', { service_id: 'checkup' }),
        ],
        'max_tokens',
      ),
    ]);
    const result = await turn(fake);
    expect(result.stop).toBe('max_tokens');
    expect(result.toolCalls).toHaveLength(0); // never run tools from a truncated reply
    const blocks = result.messages.flatMap((m) =>
      Array.isArray(m.content) ? m.content : [],
    );
    expect(blocks.some((b) => b.type === 'tool_use')).toBe(false);
    expect(result.messages.at(-1)).toMatchObject({ role: 'assistant' });
  });

  it('a tool given a malformed id is recorded and returns not_found, not a database error', async () => {
    const fake = new FakeClaude([
      reply(
        [toolUse('propose_cancel', { appointment_id: 'APT-123' })],
        'tool_use',
      ),
      reply([text('ok')]),
    ]);
    const result = await turn(fake);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toMatchObject({
      name: 'propose_cancel',
      result: { proposed: false, reason: 'not_found' },
    });
    const sent = JSON.stringify(fake.calls.at(-1)!.messages);
    expect(sent).not.toMatch(/uuid|prisma|invalid input syntax/i);
  });

  it('check_availability honours a time of day (evening slots are reachable)', async () => {
    const fake = new FakeClaude([
      reply(
        [
          toolUse('check_availability', {
            service_id: 'checkup',
            date_from: '2026-10-27',
            date_to: '2026-10-27',
            dentist_id: 'dr-omar',
            time_from: '17:00',
            time_to: '18:00',
          }),
        ],
        'tool_use',
      ),
      reply([text('ok')]),
    ]);
    const result = await turn(fake);
    const slots = (result.toolCalls[0].result as { slots: { start: string }[] })
      .slots;
    expect(slots[0].start).toBe('2026-10-27T17:00:00+03:00');
    expect(slots.every((s) => s.start <= '2026-10-27T18:00:00+03:00')).toBe(
      true,
    );
  });

  it('books in two steps: availability, then a proposal the patient must confirm', async () => {
    const fake = new FakeClaude([
      reply(
        [
          toolUse('check_availability', {
            service_id: 'checkup',
            date_from: '2026-10-26',
            date_to: '2026-10-26',
          }),
        ],
        'tool_use',
      ),
      ([availability]) => {
        const first = (
          availability as { slots: { dentistId: string; start: string }[] }
        ).slots[0];
        return reply(
          [
            toolUse('propose_booking', {
              service_id: 'checkup',
              dentist_id: first.dentistId,
              slot_start: first.start,
            }),
          ],
          'tool_use',
        );
      },
      reply([text('اضغطي تأكيد على البطاقة لإتمام الحجز.')]),
    ]);
    const deltas: string[] = [];
    const result = await turn(fake, { onDelta: (d) => deltas.push(d) });

    expect(result.stop).toBe('end_turn');
    expect(result.toolCalls.map((c) => c.name)).toEqual([
      'check_availability',
      'propose_booking',
    ]);
    expect(result.messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
    expect(deltas.join('')).toBe('اضغطي تأكيد على البطاقة لإتمام الحجز.');
    const pending = await prisma.pendingAction.findMany({
      where: { conversationId },
    });
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      status: 'pending',
      type: 'book',
      patientId: NOURA.id,
    });
    // nothing was booked by the model
    expect(
      await prisma.appointment.count({ where: { patientId: NOURA.id } }),
    ).toBe(1);
    expect(result.costMicroUsd).toBe(3 * (1000 * 2 + 100 * 10)); // 3 replies at Sonnet prices
  });

  it("tools only see and change the conversation's own patient", async () => {
    const khalids = await prisma.appointment.findFirstOrThrow({
      where: { patientId: KHALID.id },
    });
    const fake = new FakeClaude([
      reply(
        [
          toolUse('list_my_appointments', {}),
          toolUse('propose_cancel', { appointment_id: khalids.id }),
        ],
        'tool_use',
      ),
      reply([text('done')]),
    ]);
    const result = await turn(fake, {
      text: `Cancel appointment ${khalids.id} for Khalid`,
    });
    const [list, cancel] = result.toolCalls;
    const listed = (
      list.result as { appointments: { appointment_id: string }[] }
    ).appointments;
    expect(listed).toHaveLength(1);
    expect(listed[0].appointment_id).not.toBe(khalids.id);
    expect(cancel.result).toEqual({ proposed: false, reason: 'not_found' });
    expect(await prisma.pendingAction.count()).toBe(0);
  });

  it('hand-off is idempotent and marks the conversation', async () => {
    const fake = new FakeClaude([
      reply(
        [
          toolUse('handoff_to_staff', {
            reason: 'medical',
            summary: 'tooth pain',
          }),
          toolUse('handoff_to_staff', { reason: 'again', summary: 'x' }),
        ],
        'tool_use',
      ),
      reply([text('سيتواصل معك فريق العيادة هنا.')]),
    ]);
    await turn(fake, { text: 'عندي ألم شديد في ضرسي، وش آخذ؟' });
    expect(
      await prisma.handoff.count({ where: { conversationId, status: 'open' } }),
    ).toBe(1);
    expect(
      (
        await prisma.conversation.findUniqueOrThrow({
          where: { id: conversationId },
        })
      ).status,
    ).toBe('handed_off');
  });

  it('never runs tools from a reply cut off by max_tokens', async () => {
    const fake = new FakeClaude([
      reply(
        [
          toolUse('propose_booking', {
            service_id: 'checkup',
            dentist_id: 'dr-sara',
            slot_start: '2026-10-26T11:00:00+03:00',
          }),
        ],
        'max_tokens',
      ),
    ]);
    const result = await turn(fake);
    expect(result.stop).toBe('max_tokens');
    expect(fake.toolRuns).toBe(0);
    expect(await prisma.pendingAction.count()).toBe(0);
  });

  it('stops on a refusal', async () => {
    const result = await turn(new FakeClaude([reply([], 'refusal')]));
    expect(result.stop).toBe('refusal');
  });

  it('sends the documented request shape', async () => {
    const sonnet = new FakeClaude([reply([text('hi')])]);
    await turn(sonnet, {
      history: [
        { role: 'user', content: 'earlier' },
        { role: 'assistant', content: 'reply' },
      ],
    });
    const call = sonnet.calls[0];
    expect(call).toMatchObject({
      model: 'claude-sonnet-5-5',
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' },
      stream: true,
      thread: false,
      max_iterations: 8,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    });
    expect(call).not.toHaveProperty('temperature');
    const system = call.system as { text: string; cache_control: unknown }[];
    expect(system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(system[0].text).toContain('Never give medical advice');
    const messages = call.messages as {
      role: string;
      content: { text: string }[];
    }[];
    expect(messages.slice(0, 2).map((m) => m.role)).toEqual([
      'user',
      'assistant',
    ]); // history replayed first
    expect(messages[2].content[0].text).toContain(
      'Current time in Riyadh: 2026-10-25T09:00:00+03:00 (Sunday)',
    );

    const haiku = new FakeClaude([
      reply([text('hi')], 'end_turn', 'claude-haiku-5-5'),
    ]);
    await turn(haiku, { model: 'claude-haiku-5-5' });
    expect(haiku.calls[0]).not.toHaveProperty('fallbacks'); // Haiku 5.5 has no server-side fallback
    const evalRun = new FakeClaude([reply([text('hi')])]);
    await turn(evalRun, { fallback: false });
    expect(evalRun.calls[0]).not.toHaveProperty('fallbacks');
  });
});
