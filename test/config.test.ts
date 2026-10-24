import { describe, expect, it } from 'vitest';
import { loadApiConfig } from '../src/shared/config.js';

const base = {
  DATABASE_URL: 'postgres://nacre_app@localhost:5432/nacre',
  TOKEN_PEPPER: 'p'.repeat(32),
};

describe('api config: public URLs', () => {
  it('production requires https for PUBLIC_API_URL and PUBLIC_APP_URL', () => {
    expect(() =>
      loadApiConfig({ ...base, NODE_ENV: 'production', PUBLIC_API_URL: 'http://api.nacre.so' }),
    ).toThrow('PUBLIC_API_URL: must be https in production');
    expect(() =>
      loadApiConfig({
        ...base,
        NODE_ENV: 'production',
        PUBLIC_API_URL: 'https://api.nacre.so',
        PUBLIC_APP_URL: 'http://app.nacre.so',
      }),
    ).toThrow('PUBLIC_APP_URL: must be https in production');
  });

  it('production with https passes; http is fine outside production', () => {
    expect(
      loadApiConfig({ ...base, NODE_ENV: 'production', PUBLIC_API_URL: 'https://api.nacre.so/' })
        .PUBLIC_API_URL,
    ).toBe('https://api.nacre.so');
    expect(
      loadApiConfig({ ...base, NODE_ENV: 'development', PUBLIC_API_URL: 'http://localhost:3000' })
        .allowedOrigins,
    ).toEqual(['http://localhost:3000']);
  });
});
