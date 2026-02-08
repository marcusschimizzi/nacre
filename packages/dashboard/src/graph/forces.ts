import type { ForceNode } from './types.ts';
import { Z_SCALE } from './theme.ts';

function daysBetween(a: string, b: string): number {
  const msPerDay = 86_400_000;
  return Math.abs(
    Math.floor((new Date(a).getTime() - new Date(b).getTime()) / msPerDay),
  );
}

export function createTemporalForce(nodes: ForceNode[], now: string) {
  const strength = 0.3;

  return function temporalForce(alpha: number) {
    for (const node of nodes) {
      const days = daysBetween(node.lastReinforced, now);
      const targetZ = -days * Z_SCALE;
      node.vz = ((node.vz ?? 0) + (targetZ - (node.z ?? 0)) * strength * alpha);
    }
  };
}
