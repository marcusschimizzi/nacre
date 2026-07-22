import { createHash } from 'node:crypto';
import type { SqliteStore } from './store.js';
import type { ConversationInput, ConversationMessage } from './types.js';
import type { MemoryObjectType, Sensitivity } from './memory-file.js';
import {
  normalizeCandidateClaim,
  type MemoryCandidate,
  type MemoryExtractorIdentity,
} from './memory-candidate.js';
import { isDurablyRejected } from './memory-candidate-durable.js';
import { isDurableScope } from './scopes.js';

const EXTRACTOR: MemoryExtractorIdentity = {
  name: 'nacre-explicit-memory',
  version: '1',
};

export type MemoryExtractionReason =
  | 'recognized_explicit_form'
  | 'ineligible_role'
  | 'ineligible_origin'
  | 'not_extraction_eligible'
  | 'missing_provenance'
  | 'unsupported_form'
  | 'duplicate_evidence'
  | 'secret_zero_retention';

export interface MemoryExtractionReceiptItem {
  messageId?: string;
  candidateId?: string;
  disposition: 'created' | 'skipped' | 'rejected';
  reason: MemoryExtractionReason;
}

export interface MemoryExtractionReceipt {
  extractor: MemoryExtractorIdentity;
  created: number;
  skipped: number;
  rejected: number;
  reasons: MemoryExtractionReceiptItem[];
}

export interface MemoryExtractionOptions {
  now?: string;
  scope?: string;
  sensitivity?: Sensitivity;
  subjectEntityIds?: string[];
  /** Configured memory root used for durable candidate state. */
  memoryDir: string;
}

export function normalizeMemoryClaim(claim: string): string {
  return normalizeCandidateClaim(claim);
}

function explicitType(content: string): MemoryObjectType | undefined {
  if (/^I prefer\s+\S[\s\S]*$/i.test(content)) return 'preference';
  if (/^We decided\s+\S[\s\S]*$/i.test(content)) return 'decision';
  if (/^Remember that\s+\S[\s\S]*$/i.test(content)) return 'fact';
  if (/^(?:Correction:|Actually,|I need to correct that:)\s*\S[\s\S]*$/i.test(content))
    return 'claim';
  return undefined;
}

function candidateId(
  input: ConversationInput,
  message: ConversationMessage,
  normalizedClaim: string,
): string {
  const identity = JSON.stringify({
    sourceNamespace: input.metadata?.sourceNamespace ?? '',
    sessionId: input.metadata?.sessionId ?? '',
    sourceRef: message.sourceRef,
    messageId: message.id,
    sourcePosition: message.sourcePosition,
    contentHash: message.contentHash,
    eventTime: message.timestamp,
    normalizedClaim,
    extractor: EXTRACTOR,
  });
  return `mem_${createHash('sha256').update(identity).digest('hex').slice(0, 24)}`;
}

function skipReason(message: ConversationMessage): MemoryExtractionReason | undefined {
  if (message.role !== 'user') return 'ineligible_role';
  if (message.origin !== 'direct') return 'ineligible_origin';
  if (message.extractionEligible !== true) return 'not_extraction_eligible';
  return undefined;
}

/**
 * Deterministic, deliberately narrow extraction. It recognizes only explicit
 * first-party forms and only from normalized direct USER evidence. It never
 * promotes or treats repetitions as corroboration.
 */
export function extractMemoryCandidates(
  input: ConversationInput,
  store: SqliteStore,
  options: MemoryExtractionOptions,
): MemoryExtractionReceipt {
  const receipt: MemoryExtractionReceipt = {
    extractor: EXTRACTOR,
    created: 0,
    skipped: 0,
    rejected: 0,
    reasons: [],
  };
  const scope = options.scope ?? input.metadata?.scope ?? 'agent';
  if (!isDurableScope(scope))
    throw new Error(`Memory candidates require a durable scope: "${scope}"`);
  const sensitivity = options.sensitivity ?? 'personal';
  const createdAt = options.now ?? new Date().toISOString();

  for (const message of input.messages) {
    const skipped = skipReason(message);
    if (skipped) {
      receipt.skipped++;
      receipt.reasons.push({ messageId: message.id, disposition: 'skipped', reason: skipped });
      continue;
    }
    const claim = message.content.trim();
    if (sensitivity === 'secret') {
      receipt.rejected++;
      receipt.reasons.push({
        messageId: message.id,
        disposition: 'rejected',
        reason: 'secret_zero_retention',
      });
      continue;
    }
    const type = explicitType(claim);
    if (!type) {
      receipt.rejected++;
      receipt.reasons.push({
        messageId: message.id,
        disposition: 'rejected',
        reason: 'unsupported_form',
      });
      continue;
    }
    if (!message.id || !message.sourceRef || !message.timestamp) {
      receipt.rejected++;
      receipt.reasons.push({
        messageId: message.id,
        disposition: 'rejected',
        reason: 'missing_provenance',
      });
      continue;
    }
    const normalizedClaim = normalizeMemoryClaim(claim);
    const id = candidateId(input, message, normalizedClaim);
    if (isDurablyRejected(options.memoryDir, id)) {
      receipt.skipped++;
      receipt.reasons.push({
        messageId: message.id,
        candidateId: id,
        disposition: 'skipped',
        reason: 'duplicate_evidence',
      });
      continue;
    }
    // Normalization already owns timestamp validation/canonicalization. Keep
    // its exact event-time string rather than replacing it with extraction time.
    const eventTime = message.timestamp;
    const evidence = {
      sourceRef: message.sourceRef,
      messageId: message.id,
      ...(message.sourcePosition ? { sourcePosition: message.sourcePosition } : {}),
      span: { start: 0, end: message.content.length, text: message.content },
      ...(message.contentHash ? { contentHash: message.contentHash } : {}),
    };
    const candidate: MemoryCandidate = {
      id,
      type,
      claim,
      normalizedClaim,
      scope,
      sensitivity,
      confidence: 0.99,
      sourceAuthority: 'direct_user',
      trust: 1,
      eventTime,
      proposedAt: eventTime,
      evidence: [evidence],
      subjectEntityIds: [...new Set(options.subjectEntityIds ?? [])].sort(),
      extractor: EXTRACTOR,
      lifecycle: 'candidate',
      createdAt,
      updatedAt: createdAt,
    };
    if (store.createMemoryCandidate(candidate, { memoryDir: options.memoryDir })) {
      receipt.created++;
      receipt.reasons.push({
        messageId: message.id,
        candidateId: id,
        disposition: 'created',
        reason: 'recognized_explicit_form',
      });
    } else {
      receipt.skipped++;
      receipt.reasons.push({
        messageId: message.id,
        candidateId: id,
        disposition: 'skipped',
        reason: 'duplicate_evidence',
      });
    }
  }
  return receipt;
}
