import type { Procedure, ProcedureType } from './types.js';
import type { SqliteStore } from './store.js';
import { extractQueryTerms } from './recall.js';
import { daysBetween } from './decay.js';

export interface TriggerMatchOptions {
  limit?: number;
  minScore?: number;
  types?: ProcedureType[];
}

export interface TriggerMatch {
  procedure: Procedure;
  score: number;
  matchedKeywords: string[];
  matchedContexts: string[];
}

export function findRelevantProcedures(
  store: SqliteStore,
  query: string,
  contexts: string[] = [],
  opts: TriggerMatchOptions = {},
): TriggerMatch[] {
  const limit = opts.limit ?? 5;
  const minScore = opts.minScore ?? 0.3;

  const queryTerms = extractQueryTerms(query);
  if (queryTerms.length === 0 && contexts.length === 0) return [];

  const procedures = store.listProcedures(
    opts.types ? { type: opts.types[0] } : undefined,
  );

  const matches: TriggerMatch[] = [];

  for (const proc of procedures) {
    const keywordHits = proc.triggerKeywords.filter((k) =>
      queryTerms.some((q) => k.includes(q) || q.includes(k)),
    );
    const keywordScore =
      keywordHits.length > 0
        ? keywordHits.length / Math.max(proc.triggerKeywords.length, 1)
        : 0;

    const contextHits = proc.triggerContexts.filter((c) =>
      contexts.some((ctx) => c.toLowerCase() === ctx.toLowerCase()),
    );
    const contextScore =
      contextHits.length > 0
        ? contextHits.length / Math.max(proc.triggerContexts.length, 1)
        : 0;

    let score = (keywordScore * 0.7 + contextScore * 0.3) * proc.confidence;

    if (proc.lastApplied) {
      const daysSince = daysBetween(proc.lastApplied, new Date().toISOString());
      score *= Math.max(0.5, 1 - daysSince / 365);
    }

    if (score >= minScore) {
      matches.push({
        procedure: proc,
        score,
        matchedKeywords: keywordHits,
        matchedContexts: contextHits,
      });
    }
  }

  return matches.sort((a, b) => b.score - a.score).slice(0, limit);
}

export type ProcedureFeedback = 'positive' | 'negative' | 'neutral';

export function applyProcedure(
  store: SqliteStore,
  procedureId: string,
  feedback: ProcedureFeedback,
): Procedure {
  const proc = store.getProcedure(procedureId);
  if (!proc) throw new Error(`Procedure not found: ${procedureId}`);

  const now = new Date().toISOString();
  const updated: Procedure = { ...proc, lastApplied: now, updatedAt: now };

  if (feedback === 'positive') {
    updated.applications += 1;
    updated.confidence = Math.min(0.99, proc.confidence + 0.1 * (1 - proc.confidence));
    updated.stability = Math.min(2, proc.stability + 0.1);
  } else if (feedback === 'negative') {
    updated.contradictions += 1;
    updated.confidence = Math.max(0.01, proc.confidence * 0.8);

    if (updated.contradictions >= 3 && updated.confidence < 0.3) {
      updated.flaggedForReview = true;
    }
  }

  store.putProcedure(updated);
  return updated;
}
