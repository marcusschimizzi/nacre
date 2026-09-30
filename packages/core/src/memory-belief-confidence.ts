import type { MemoryCandidate, MemoryEvidenceRef } from './memory-candidate.js';

export const BELIEF_CONFIDENCE_FORMULA = '1 - product(1 - support.authority * support.trust)';

export interface BeliefConfidenceInputs {
  independentEvidenceCount: number;
  supports: Array<{
    sourceEventId: string;
    sourceAuthority: string;
    authority: number;
    trust: number;
  }>;
  formula: string;
}

/** Deterministic authority mapping: direct user (1) > assistant inference (0.6) > unknown (0.25). */
export function beliefAuthority(authority?: string): number {
  if (authority === 'direct_user') return 1;
  if (authority === 'assistant_inference') return 0.6;
  return 0.25;
}

export function beliefEvidenceIdentity(ref: MemoryEvidenceRef): string {
  return `${ref.sourceRef}|${ref.messageId}`;
}

export function beliefConfidenceInputs(candidates: MemoryCandidate[]): BeliefConfidenceInputs {
  const byEvent = new Map<string, BeliefConfidenceInputs['supports'][number]>();
  for (const candidate of candidates) {
    for (const ref of candidate.evidence) {
      const sourceEventId = beliefEvidenceIdentity(ref);
      const support = {
        sourceEventId,
        sourceAuthority: candidate.sourceAuthority,
        authority: beliefAuthority(candidate.sourceAuthority),
        trust: candidate.trust,
      };
      const existing = byEvent.get(sourceEventId);
      if (!existing || support.authority * support.trust > existing.authority * existing.trust) {
        byEvent.set(sourceEventId, support);
      }
    }
  }
  const supports = [...byEvent.values()].sort((a, b) =>
    a.sourceEventId.localeCompare(b.sourceEventId),
  );
  return {
    independentEvidenceCount: supports.length,
    supports,
    formula: BELIEF_CONFIDENCE_FORMULA,
  };
}

export function beliefConfidence(inputs: BeliefConfidenceInputs): number {
  return Number(
    (
      1 -
      inputs.supports.reduce(
        (product, support) => product * (1 - support.authority * support.trust),
        1,
      )
    ).toFixed(6),
  );
}
