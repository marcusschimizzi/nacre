import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // The deploy-step tests spawn node + tsx and dbmate processes (three per pre-deploy run), and
    // the 5 s default timed them out on a busy machine.
    testTimeout: 20_000,
    // Creates and migrates a scratch database when TEST_DATABASE_URL is set (test/global-setup.ts).
    globalSetup: ['test/global-setup.ts'],
  },
});
