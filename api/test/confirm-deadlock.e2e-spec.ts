import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { vi } from 'vitest';
import { ActionsService } from '../src/actions/actions.service.js';
import { riyadhInstant, toRiyadhIso } from '../src/common/time.js';
import { Prisma } from '../src/generated/prisma/client.js';
import type { PrismaService } from '../src/prisma/prisma.service.js';
import { PATIENTS } from '../src/seed/data.js';
import { createTestApp, HEADER, resetData } from './support/app.js';

// Regression: two confirms racing for one slot made PostgreSQL abort one transaction with
// 40P01 "deadlock detected" (Prisma P2034) inside the exclusion constraint; that surfaced as a 500.
describe('confirm under database deadlocks (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let actions: ActionsService;

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    actions = app.get(ActionsService);
  });

  beforeEach(async () => {
    await resetData(prisma);
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  const propose = async (cid: string, patientId: string, hh: number) => {
    const result = await actions.propose(cid, patientId, {
      type: 'book',
      serviceId: 'checkup',
      dentistId: 'dr-sara',
      slotStart: toRiyadhIso(riyadhInstant('2026-10-26', hh * 60)),
    });
    if (!result.ok) throw new Error(result.reason);
    return result.actionId;
  };
  const confirm = (cid: string, aid: string) =>
    request(app.getHttpServer())
      .post(`/conversations/${cid}/actions/${aid}/confirm`)
      .set(HEADER);

  it('a deadlock during confirm is retried instead of returning 500', async () => {
    const cid = (
      await prisma.conversation.create({ data: { patientId: PATIENTS[0].id } })
    ).id;
    const aid = await propose(cid, PATIENTS[0].id, 11);

    // The database aborts the first attempt exactly as it did in the race (only the database is faked).
    const real = prisma.$transaction.bind(prisma);
    let injected = false;
    vi.spyOn(prisma, '$transaction').mockImplementation(((
      fn: unknown,
      options?: unknown,
    ) => {
      if (injected || typeof fn !== 'function')
        return real(fn as never, options as never);
      injected = true;
      return real(async (tx: Prisma.TransactionClient) => {
        const proxied = new Proxy(tx, {
          get(target, prop, receiver) {
            if (prop !== 'appointment')
              return Reflect.get(target, prop, receiver);
            return {
              ...target.appointment,
              create: () => {
                throw new Prisma.PrismaClientKnownRequestError(
                  'Transaction failed due to a write conflict or a deadlock. Please retry your transaction',
                  { code: 'P2034', clientVersion: Prisma.prismaVersion.client },
                );
              },
            };
          },
        });
        return (fn as (t: Prisma.TransactionClient) => Promise<unknown>)(
          proxied,
        );
      }, options as never);
    }) as never);

    const res = await confirm(cid, aid);
    vi.restoreAllMocks();
    expect(injected).toBe(true);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'confirmed',
      outcome: { ok: true },
    });
  });

  it('many simultaneous confirms for one slot never return 500', async () => {
    for (let round = 0; round < 40; round++) {
      await resetData(prisma);
      const c1 = (
        await prisma.conversation.create({
          data: { patientId: PATIENTS[0].id },
        })
      ).id;
      const c2 = (
        await prisma.conversation.create({
          data: { patientId: PATIENTS[1].id },
        })
      ).id;
      const [a1, a2] = [
        await propose(c1, PATIENTS[0].id, 11),
        await propose(c2, PATIENTS[1].id, 11),
      ];
      const [r1, r2] = await Promise.all([confirm(c1, a1), confirm(c2, a2)]);
      expect([r1.status, r2.status].sort((x, y) => x - y)).toEqual([200, 409]);
    }
  });
});
