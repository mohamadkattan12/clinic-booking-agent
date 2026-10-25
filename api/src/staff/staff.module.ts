import { Module } from '@nestjs/common';
import { StaffController } from './staff.controller.js';

@Module({
  controllers: [StaffController],
})
export class StaffModule {}
