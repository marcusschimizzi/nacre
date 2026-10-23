import { readFileSync } from 'node:fs';

// Two levels up from both src/shared and dist/shared.
const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
  version: string;
};

export const buildInfo = {
  version: pkg.version,
  // Railway sets RAILWAY_GIT_COMMIT_SHA on deploys from GitHub; GIT_COMMIT covers other builds.
  commit: process.env.RAILWAY_GIT_COMMIT_SHA ?? process.env.GIT_COMMIT ?? null,
} as const;
