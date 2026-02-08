import type { ForceNode } from '../graph/types.ts';

const MS_PER_DAY = 86_400_000;

export function formatNumber(n: number, digits: number = 1): string {
  if (!Number.isFinite(n)) return '—';
  return n.toFixed(digits);
}

export function formatAgeStats(nodes: ForceNode[]): { avgDays: number; medianDays: number; oldestLabel: string } {
  const now = Date.now();
  const ages: number[] = [];

  let oldest = { days: -1, label: '' };
  for (const n of nodes) {
    const first = new Date(n.firstSeen).getTime();
    const days = Math.max(0, (now - first) / MS_PER_DAY);
    ages.push(days);
    if (days > oldest.days) oldest = { days, label: n.label };
  }

  ages.sort((a, b) => a - b);
  const avg = ages.length ? ages.reduce((s, a) => s + a, 0) / ages.length : 0;
  const median = ages.length ? ages[Math.floor(ages.length / 2)] : 0;
  return { avgDays: avg, medianDays: median, oldestLabel: oldest.label || '—' };
}
