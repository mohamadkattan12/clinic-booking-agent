import { Module } from '@nestjs/common';
import { ClinicService } from './clinic.service.js';

@Module({
  providers: [ClinicService],
  exports: [ClinicService],
})
export class ClinicModule {}
