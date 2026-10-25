import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  health(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /** Ready = database reachable, migrations applied and demo data seeded. */
  @Get('ready')
  async ready(): Promise<{
    status: 'ready';
    migrations: number;
    services: number;
  }> {
    try {
      const [{ count }] = await this.prisma.$queryRaw<{ count: bigint }[]>`
        SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL`;
      const services = await this.prisma.service.count();
      if (Number(count) === 0 || services === 0)
        throw new Error('not migrated or not seeded');
      return { status: 'ready', migrations: Number(count), services };
    } catch {
      throw new ServiceUnavailableException('database not ready');
    }
  }
}
