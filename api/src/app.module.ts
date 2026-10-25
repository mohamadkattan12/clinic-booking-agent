import { Module, ValidationPipe } from '@nestjs/common';
import { APP_PIPE } from '@nestjs/core';
import { ActionsModule } from './actions/actions.module.js';
import { AgentModule } from './agent/agent.module.js';
import { ClinicModule } from './clinic/clinic.module.js';
import { CommonModule } from './common/common.module.js';
import { ConversationsModule } from './conversations/conversations.module.js';
import { HealthModule } from './health/health.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { StaffModule } from './staff/staff.module.js';

@Module({
  imports: [
    CommonModule,
    PrismaModule,
    HealthModule,
    ClinicModule,
    ActionsModule,
    AgentModule,
    ConversationsModule,
    StaffModule,
  ],
  providers: [
    // Validate every request body against its DTO; unknown fields are rejected.
    {
      provide: APP_PIPE,
      useValue: new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    },
  ],
})
export class AppModule {}
