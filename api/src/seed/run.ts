// Applied on container start after `prisma migrate deploy`: node dist/seed/run.js
import { createPrismaClient } from '../prisma/prisma.service.js';
import { seed } from './seed.js';

const prisma = createPrismaClient();
await seed(prisma);
await prisma.$disconnect();
console.log('seed: ok');
