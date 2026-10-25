import { Module } from '@nestjs/common';
import { ClinicService } from './clinic.service.js';

@Module({
  providers: [ClinicService],
})
export class ClinicModule {}
