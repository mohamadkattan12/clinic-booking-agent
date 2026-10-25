import { Module } from '@nestjs/common';
import { HealthModule } from './health/health.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { ClinicModule } from './clinic/clinic.module.js';

@Module({
  imports: [PrismaModule, HealthModule, ClinicModule],
})
export class AppModule {}
