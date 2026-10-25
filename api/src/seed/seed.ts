import type { PrismaClient } from '../generated/prisma/client.js';
import { addDays, riyadhInstant, riyadhParts } from '../common/time.js';
import {
  CLINIC_HOURS,
  DENTISTS,
  EXISTING_APPOINTMENTS,
  PATIENTS,
  SERVICES,
} from './data.js';

/** Idempotent: reference data is upserted; demo appointments are added only to an empty table. */
export async function seed(
  prisma: PrismaClient,
  now: Date = new Date(),
): Promise<void> {
  for (const hours of CLINIC_HOURS) {
    await prisma.clinicHours.upsert({
      where: { weekday: hours.weekday },
      create: hours,
      update: hours,
    });
  }
  for (const service of SERVICES) {
    await prisma.service.upsert({
      where: { id: service.id },
      create: service,
      update: service,
    });
  }
  for (const { services, schedule, ...dentist } of DENTISTS) {
    await prisma.dentist.upsert({
      where: { id: dentist.id },
      create: dentist,
      update: dentist,
    });
    for (const serviceId of services) {
      await prisma.dentistService.upsert({
        where: { dentistId_serviceId: { dentistId: dentist.id, serviceId } },
        create: { dentistId: dentist.id, serviceId },
        update: {},
      });
    }
    for (const day of schedule) {
      const row = { dentistId: dentist.id, ...day };
      await prisma.schedule.upsert({
        where: {
          dentistId_weekday: { dentistId: dentist.id, weekday: day.weekday },
        },
        create: row,
        update: row,
      });
    }
  }
  for (const patient of PATIENTS) {
    await prisma.patient.upsert({
      where: { id: patient.id },
      create: patient,
      update: patient,
    });
  }

  if ((await prisma.appointment.count()) > 0) return;
  const today = riyadhParts(now);
  const durations = new Map(SERVICES.map((s) => [s.id, s.durationMin]));
  for (const [
    patientId,
    dentistId,
    serviceId,
    weekday,
    minute,
    weeks,
  ] of EXISTING_APPOINTMENTS) {
    const daysAhead =
      ((weekday - today.weekday + 7) % 7 || 7) + 7 * (weeks - 1);
    const startsAt = riyadhInstant(addDays(today.date, daysAhead), minute);
    const endsAt = new Date(
      startsAt.getTime() + durations.get(serviceId)! * 60_000,
    );
    await prisma.appointment.create({
      data: { patientId, dentistId, serviceId, startsAt, endsAt },
    });
  }
}
