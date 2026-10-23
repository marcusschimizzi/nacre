import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Creates and migrates a scratch database when TEST_DATABASE_URL is set (test/global-setup.ts).
    globalSetup: ['test/global-setup.ts'],
  },
});
