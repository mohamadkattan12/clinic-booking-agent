import { Module } from '@nestjs/common';
import { ActionsModule } from './actions/actions.module.js';
import { ClinicModule } from './clinic/clinic.module.js';
import { CommonModule } from './common/common.module.js';
import { HealthModule } from './health/health.module.js';
import { PrismaModule } from './prisma/prisma.module.js';

@Module({
  imports: [
    CommonModule,
    PrismaModule,
    HealthModule,
    ClinicModule,
    ActionsModule,
  ],
})
export class AppModule {}
