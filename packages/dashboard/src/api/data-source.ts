import { NacreAPIClient } from './client.ts';
import type { HealthData } from './types.ts';

export type ApiStatus =
  | { status: 'online'; baseUrl: string; health: HealthData }
  | { status: 'offline'; baseUrl: string | null; error: string };

function getUrlParam(name: string): string | null {
  try {
    const url = new URL(window.location.href);
    return url.searchParams.get(name);
  } catch {
    return null;
  }
}

export function candidateApiBases(): string[] {
  const fromParam = getUrlParam('api');
  const fromEnv = import.meta.env.VITE_NACRE_API_BASE;

  const bases: string[] = [];
  if (fromParam) bases.push(fromParam);
  if (fromEnv) bases.push(fromEnv);

  // Prefer same-origin first.
  bases.push('/api/v1');
  bases.push('http://localhost:3200/api/v1');

  return [...new Set(bases.map((b) => b.replace(/\/$/, '')))].filter(Boolean);
}

export async function detectApi(): Promise<ApiStatus> {
  const bases = candidateApiBases();
  let lastErr = 'No candidates';

  for (const baseUrl of bases) {
    try {
      const api = new NacreAPIClient(baseUrl);
      const health = await api.health();
      return { status: 'online', baseUrl, health };
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
  }

  return { status: 'offline', baseUrl: null, error: lastErr };
}

export function createApiClient(baseUrl: string): NacreAPIClient {
  return new NacreAPIClient(baseUrl);
}
