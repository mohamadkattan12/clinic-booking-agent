import Anthropic from '@anthropic-ai/sdk';
import { Module } from '@nestjs/common';
import { ActionsModule } from '../actions/actions.module.js';
import { ClinicModule } from '../clinic/clinic.module.js';
import { AgentService } from './agent.service.js';

/** True when a non-empty key is configured (`.env.example` ships `ANTHROPIC_API_KEY=`). */
export const hasApiKey = () => Boolean(process.env.ANTHROPIC_API_KEY?.trim());

@Module({
  imports: [ClinicModule, ActionsModule],
  providers: [
    AgentService,
    // The SDK only fails at request time without a key; callers check hasApiKey() first.
    {
      provide: Anthropic,
      useFactory: () =>
        new Anthropic({
          apiKey: process.env.ANTHROPIC_API_KEY?.trim() || 'missing',
        }),
    },
  ],
  exports: [AgentService],
})
export class AgentModule {}
