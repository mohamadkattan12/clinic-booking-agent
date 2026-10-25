import { defineConfig } from 'vitest/config';

const admin =
  process.env.TEST_ADMIN_DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5435/postgres';

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    globalSetup: ['./test/support/database.ts'],
    env: { DATABASE_URL: admin.replace(/\/[^/]+$/, '/clinic_test') },
    fileParallelism: false, // the e2e files share one test database
  },
});
