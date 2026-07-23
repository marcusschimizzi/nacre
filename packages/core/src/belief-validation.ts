import type { ParsedMemoryFile } from './memory-file.js';

export type CanonicalBelief = { path: string; parsed: ParsedMemoryFile };

/** Validate cross-file references, symmetry, validity, and acyclic one-to-one lineage. */
export function validateCanonicalBeliefSet(canonicals: CanonicalBelief[]): void {
  const byId = new Map(canonicals.map((value) => [value.parsed.memory.id, value]));
  for (const { parsed } of canonicals) {
    const memory = parsed.memory;
    if (memory.lifecycle === 'superseded') {
      if (!memory.supersededBy || !memory.validUntil)
        throw new Error(`Superseded belief ${memory.id} requires superseded_by and valid_until`);
      const next = byId.get(memory.supersededBy)?.parsed.memory;
      if (!next)
        throw new Error(
          `Belief ${memory.id} references missing superseded_by ${memory.supersededBy}`,
        );
      if (next.supersedes !== memory.id)
        throw new Error(`Asymmetric lineage between ${memory.id} and ${next.id}`);
      if (next.validFrom !== memory.validUntil)
        throw new Error(`Non-contiguous validity between ${memory.id} and ${next.id}`);
    } else if (memory.lifecycle === 'active' && (memory.supersededBy || memory.validUntil)) {
      throw new Error(`Active belief ${memory.id} cannot have superseded_by or valid_until`);
    }
    if (memory.supersedes) {
      const previous = byId.get(memory.supersedes)?.parsed.memory;
      if (!previous)
        throw new Error(`Belief ${memory.id} references missing supersedes ${memory.supersedes}`);
      if (previous.supersededBy !== memory.id)
        throw new Error(`Asymmetric lineage between ${previous.id} and ${memory.id}`);
    }
    const recordIds = (memory.candidateRecords ?? []).map((value) => value.id);
    if (
      memory.candidateIds &&
      memory.candidateRecords &&
      JSON.stringify(recordIds) !== JSON.stringify(memory.candidateIds)
    ) {
      throw new Error(`Candidate records disagree with candidate_ids for ${memory.id}`);
    }
    if ((memory.candidateRecords ?? []).some((value) => value.resolvedMemoryId !== memory.id)) {
      throw new Error(`Candidate resolution points at the wrong belief for ${memory.id}`);
    }
  }
  for (const id of byId.keys()) {
    const seen = new Set<string>();
    let current: string | undefined = id;
    while (current) {
      if (seen.has(current)) throw new Error(`Cyclic belief lineage at ${current}`);
      seen.add(current);
      current = byId.get(current)?.parsed.memory.supersededBy;
    }
  }
}
