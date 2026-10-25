import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module.js';
import { Clock, FixedClock } from '../../src/common/clock.js';
import { riyadhInstant } from '../../src/common/time.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import { seed } from '../../src/seed/seed.js';

/** Sunday 2026-10-25 09:00 in Riyadh. */
export const NOW = riyadhInstant('2026-10-25', 9 * 60);
export const HEADER = { 'X-Requested-By': 'clinic-booking-agent' };

export async function createTestApp(): Promise<{
  app: INestApplication;
  prisma: PrismaService;
  clock: FixedClock;
}> {
  const clock = new FixedClock(NOW);
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(Clock)
    .useValue(clock)
    .compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  const prisma = app.get(PrismaService);
  await resetData(prisma);
  return { app, prisma, clock };
}

/** Clear per-test state and re-seed with the pinned clock. */
export async function resetData(prisma: PrismaService): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE tool_calls, handoffs, pending_actions, messages, turns, conversations, appointments CASCADE',
  );
  await seed(prisma, NOW);
}
