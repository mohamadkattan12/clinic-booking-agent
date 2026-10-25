import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  type Booked,
  buildClinicData,
  type ClinicData,
} from './booking-rules.js';

type Db = PrismaService | Prisma.TransactionClient;

@Injectable()
export class ClinicService {
  constructor(private readonly prisma: PrismaService) {}

  async load(db: Db = this.prisma): Promise<ClinicData> {
    const [hours, services, dentists] = await Promise.all([
      db.clinicHours.findMany(),
      db.service.findMany(),
      db.dentist.findMany({ include: { services: true, schedules: true } }),
    ]);
    return buildClinicData({ hours, services, dentists });
  }

  /** Booked appointments overlapping [from, to). */
  async booked(from: Date, to: Date, db: Db = this.prisma): Promise<Booked[]> {
    return db.appointment.findMany({
      where: { status: 'booked', startsAt: { lt: to }, endsAt: { gt: from } },
      select: { id: true, dentistId: true, startsAt: true, endsAt: true },
    });
  }
}
