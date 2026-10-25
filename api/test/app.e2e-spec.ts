import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from './../src/app.module.js';
import { createPrismaClient } from '../src/prisma/prisma.service.js';
import { seed } from '../src/seed/seed.js';

describe('health (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const prisma = createPrismaClient();
    await seed(prisma); // idempotent; this file must not depend on test order
    await prisma.$disconnect();
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health', () => {
    return request(app.getHttpServer())
      .get('/health')
      .expect(200)
      .expect({ status: 'ok' });
  });

  it('GET /health/ready reports migrations and seed', async () => {
    const res = await request(app.getHttpServer())
      .get('/health/ready')
      .expect(200);
    expect(res.body).toMatchObject({ status: 'ready', services: 7 });
    expect(res.body.migrations).toBeGreaterThan(0);
  });
});
