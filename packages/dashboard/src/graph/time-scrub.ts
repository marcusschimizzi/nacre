import type { ForceLink, GraphConfig } from './types.ts';

const MS_PER_DAY = 86_400_000;

function daysBetween(dateA: string, dateB: string): number {
  return Math.abs(Math.floor(
    (new Date(dateA).getTime() - new Date(dateB).getTime()) / MS_PER_DAY,
  ));
}

export function computeWeightAtDate(link: ForceLink, date: Date, config: GraphConfig): number {
  const dateStr = date.toISOString();
  const daysSince = daysBetween(link.lastReinforced, dateStr);

  if (new Date(link.lastReinforced).getTime() > date.getTime()) {
    return link.baseWeight;
  }

  return Math.max(0, link.baseWeight * Math.exp(
    -(config.decayRate * daysSince) / link.stability,
  ));
}

export function isNodeVisibleAtDate(firstSeen: string, date: Date): boolean {
  return new Date(firstSeen).getTime() <= date.getTime();
}

export function isEdgeVisibleAtDate(firstFormed: string, date: Date): boolean {
  return new Date(firstFormed).getTime() <= date.getTime();
}

export function sliderValueToDate(value: number, earliest: Date, latest: Date): Date {
  const range = latest.getTime() - earliest.getTime();
  return new Date(earliest.getTime() + (value / 100) * range);
}

export function formatDateLabel(date: Date): string {
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}
