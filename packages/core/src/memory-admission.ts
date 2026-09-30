import { createHash } from 'node:crypto';
import { beliefAuthority } from './memory-belief-confidence.js';
import {
  isMemoryId,
  MEMORY_OBJECT_TYPES,
  SENSITIVITY_LEVELS,
  type MemoryObject,
  type Sensitivity,
} from './memory-file.js';
import {
  evaluateMemorySalience,
  SALIENCE_WEIGHTS,
  TYPE_RELEVANCE,
  type SalienceReceipt,
} from './memory-salience-evaluator.js';

export const ADMISSION_RECEIPT_VERSION = 'nacre.admission.v1' as const;
export const ADMISSION_POLICY_VERSION = 'nacre.admission-policy.v1' as const;
export const TOKEN_ESTIMATOR_VERSION = 'nacre.utf8-ceil-div4.v1' as const;
export const BRIEF_RENDERER_VERSION = 'nacre.working-brief.v1' as const;

export type AdmissionKind = 'brief' | 'recall';
export type AdmissionRejectionReason =
  | 'wrong_scope'
  | 'session_not_requested'
  | 'inactive_or_outside_validity'
  | 'stale_stateful_claim'
  | 'below_confidence_threshold'
  | 'sensitivity_exceeds_policy'
  | 'invalid_provenance'
  | 'duplicate_information'
  | 'token_budget_displacement';

export interface AdmissionPolicy {
  scopes: string[];
  includeSession: boolean;
  maxSensitivity: Sensitivity;
  minEvidenceConfidence: number;
  staleStatefulAfterDays: number;
  tokenBudget: number;
  maxCandidates: number;
  maxClaimBytes: number;
}

export interface AdmissionCandidate {
  memory: MemoryObject;
  claim: string;
  retrievalRelevance?: number;
}

export interface AdmissionOptions {
  kind: AdmissionKind;
  evaluatedAt: string;
  query?: string;
  policy?: Partial<AdmissionPolicy>;
  entityDegrees?: Readonly<Record<string, number>>;
  degradations?: string[];
}

export interface AdmissionCandidateReceipt {
  memoryId: string;
  normalizedClaim: string;
  renderedClaim: string;
  section: BriefSection;
  scope: string;
  sensitivity: Sensitivity;
  salience: SalienceReceipt;
  retrievalRelevance?: number;
  sourceRefs: string[];
  tokenCost: number;
  decision: 'included' | 'rejected';
  reasons: AdmissionRejectionReason[];
  actionAuthority: { granted: false; reason: 'memory_is_context_not_action_authority' };
}

export interface AdmissionReceipt {
  version: typeof ADMISSION_RECEIPT_VERSION;
  id: string;
  kind: AdmissionKind;
  evaluatedAt: string;
  query?: string;
  scopes: string[];
  policy: AdmissionPolicy & { version: typeof ADMISSION_POLICY_VERSION };
  versions: {
    salience: 'nacre.salience.v1';
    tokenEstimator: typeof TOKEN_ESTIMATOR_VERSION;
    renderer: typeof BRIEF_RENDERER_VERSION;
  };
  degradations: string[];
  candidates: AdmissionCandidateReceipt[];
  included: string[];
  rejected: string[];
  budget: { tokenBudget: number; usedTokens: number; remainingTokens: number };
  renderedBrief: string;
}

export const DEFAULT_ADMISSION_POLICY: Readonly<AdmissionPolicy> = Object.freeze({
  scopes: ['user', 'agent', 'project/*'],
  includeSession: false,
  maxSensitivity: 'personal',
  minEvidenceConfidence: 0.5,
  staleStatefulAfterDays: 180,
  tokenBudget: 2000,
  maxCandidates: 1000,
  maxClaimBytes: 65_536,
});

export function estimateUtf8Tokens(text: string): number {
  const bytes = Buffer.byteLength(text, 'utf8');
  return bytes === 0 ? 0 : Math.ceil(bytes / 4);
}

export function normalizeAdmissionClaim(claim: string): string {
  return claim
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const SECTION_ORDER = [
  'Identity & Relationships',
  'Active Projects',
  'Preferences & Constraints',
  'Decisions',
  'Lessons',
  'Other Context',
] as const;

type BriefSection = (typeof SECTION_ORDER)[number];

function classifyBriefSection(memory: MemoryObject): BriefSection {
  if (memory.type === 'preference') return 'Preferences & Constraints';
  if (memory.type === 'decision') return 'Decisions';
  if (memory.type === 'lesson') return 'Lessons';
  if (memory.scope.startsWith('project/')) return 'Active Projects';
  if (memory.scope === 'user' && (memory.type === 'fact' || memory.type === 'claim')) {
    return 'Identity & Relationships';
  }
  return 'Other Context';
}

function renderClaimLine(claim: string): string {
  return claim.trim().replace(/\s+/g, ' ');
}

function renderBrief(included: Array<{ memory: MemoryObject; claim: string }>): string {
  const lines = ['# Working Memory Brief', ''];
  for (const heading of SECTION_ORDER) {
    lines.push(`## ${heading}`);
    const entries = included.filter(({ memory }) => classifyBriefSection(memory) === heading);
    if (entries.length === 0) lines.push('_None._');
    else for (const entry of entries) lines.push(`- ${renderClaimLine(entry.claim)}`);
    lines.push('');
  }
  return `${lines.slice(0, -1).join('\n')}\n`;
}

function renderReceiptBrief(included: AdmissionCandidateReceipt[]): string {
  const lines = ['# Working Memory Brief', ''];
  for (const heading of SECTION_ORDER) {
    lines.push(`## ${heading}`);
    const entries = included.filter((candidate) => candidate.section === heading);
    if (entries.length === 0) lines.push('_None._');
    else for (const entry of entries) lines.push(`- ${entry.renderedClaim}`);
    lines.push('');
  }
  return `${lines.slice(0, -1).join('\n')}\n`;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

export function stableAdmissionJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function computeAdmissionReceiptId(receiptWithoutId: Omit<AdmissionReceipt, 'id'>): string {
  return `rcpt_${createHash('sha256').update(stableAdmissionJson(receiptWithoutId)).digest('hex')}`;
}

function requireExactKeys(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
  label = 'object',
): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const keys = Object.keys(value as Record<string, unknown>);
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !keys.includes(key)) || keys.some((key) => !allowed.has(key))) {
    throw new Error(`${label} has an invalid shape`);
  }
}

const REJECTION_REASONS: readonly AdmissionRejectionReason[] = [
  'session_not_requested',
  'wrong_scope',
  'inactive_or_outside_validity',
  'stale_stateful_claim',
  'below_confidence_threshold',
  'sensitivity_exceeds_policy',
  'invalid_provenance',
  'duplicate_information',
  'token_budget_displacement',
];

/** Strict persisted-receipt boundary. Derived data is untrusted on both put and read. */
export function validateAdmissionReceipt(value: unknown): AdmissionReceipt {
  const fail = (message: string): never => {
    throw new Error(`invalid admission receipt: ${message}`);
  };
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('expected object');
  const receipt = value as AdmissionReceipt;
  try {
    requireExactKeys(
      receipt,
      [
        'version',
        'id',
        'kind',
        'evaluatedAt',
        'scopes',
        'policy',
        'versions',
        'degradations',
        'candidates',
        'included',
        'rejected',
        'budget',
        'renderedBrief',
      ],
      ['query'],
      'receipt',
    );
    requireExactKeys(
      receipt.policy,
      [
        'version',
        'scopes',
        'includeSession',
        'maxSensitivity',
        'minEvidenceConfidence',
        'staleStatefulAfterDays',
        'tokenBudget',
        'maxCandidates',
        'maxClaimBytes',
      ],
      [],
      'policy',
    );
    requireExactKeys(receipt.versions, ['salience', 'tokenEstimator', 'renderer'], [], 'versions');
    requireExactKeys(
      receipt.budget,
      ['tokenBudget', 'usedTokens', 'remainingTokens'],
      [],
      'budget',
    );
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  if (receipt.version !== ADMISSION_RECEIPT_VERSION) fail('version');
  if (typeof receipt.id !== 'string' || !/^rcpt_[0-9a-f]{64}$/.test(receipt.id)) fail('id');
  if (receipt.kind !== 'brief' && receipt.kind !== 'recall') fail('kind');
  if (typeof receipt.evaluatedAt !== 'string' || !strictIso(receipt.evaluatedAt))
    fail('evaluatedAt');
  if (receipt.kind === 'recall' && (typeof receipt.query !== 'string' || !receipt.query.trim()))
    fail('recall query');
  if (
    receipt.query !== undefined &&
    (Buffer.byteLength(receipt.query, 'utf8') > MAX_QUERY_BYTES ||
      hasForbiddenControlCharacter(receipt.query))
  )
    fail('query bound');
  if (receipt.kind === 'brief' && receipt.query !== undefined) fail('brief query');
  if (
    !Array.isArray(receipt.scopes) ||
    receipt.scopes.length === 0 ||
    receipt.scopes.some(
      (scope) =>
        typeof scope !== 'string' ||
        (scope !== 'user' &&
          scope !== 'agent' &&
          scope !== 'session' &&
          scope !== 'project/*' &&
          !/^project\/[a-z0-9][a-z0-9._-]*$/.test(scope)),
    ) ||
    stableAdmissionJson(receipt.scopes) !== stableAdmissionJson([...new Set(receipt.scopes)].sort())
  )
    fail('scopes');
  if (
    !receipt.policy ||
    typeof receipt.policy !== 'object' ||
    receipt.policy.version !== ADMISSION_POLICY_VERSION
  )
    fail('policy');
  if (stableAdmissionJson(receipt.scopes) !== stableAdmissionJson(receipt.policy.scopes))
    fail('policy scopes');
  if (
    typeof receipt.policy.includeSession !== 'boolean' ||
    !SENSITIVITY_LEVELS.includes(receipt.policy.maxSensitivity)
  )
    fail('policy enums');
  if (
    !Number.isFinite(receipt.policy.minEvidenceConfidence) ||
    receipt.policy.minEvidenceConfidence < 0 ||
    receipt.policy.minEvidenceConfidence > 1
  )
    fail('policy confidence');
  for (const [field, number, min, max] of [
    ['staleStatefulAfterDays', receipt.policy.staleStatefulAfterDays, 0, MAX_STALE_DAYS],
    ['tokenBudget', receipt.policy.tokenBudget, 1, MAX_TOKEN_BUDGET],
    ['maxCandidates', receipt.policy.maxCandidates, 1, MAX_CANDIDATES],
    ['maxClaimBytes', receipt.policy.maxClaimBytes, 1, MAX_CLAIM_BYTES],
  ] as const) {
    if (!Number.isSafeInteger(number) || number < min || number > max) fail(`policy ${field}`);
  }
  if (
    receipt.versions?.salience !== 'nacre.salience.v1' ||
    receipt.versions.tokenEstimator !== TOKEN_ESTIMATOR_VERSION ||
    receipt.versions.renderer !== BRIEF_RENDERER_VERSION
  )
    fail('versions');
  if (
    !Array.isArray(receipt.degradations) ||
    receipt.degradations.some(
      (item) =>
        typeof item !== 'string' ||
        !item.trim() ||
        Buffer.byteLength(item, 'utf8') > 4096 ||
        hasForbiddenControlCharacter(item),
    )
  )
    fail('degradations');
  if (
    stableAdmissionJson(receipt.degradations) !==
    stableAdmissionJson([...new Set(receipt.degradations)].sort())
  )
    fail('degradations order');
  if (
    !Array.isArray(receipt.candidates) ||
    receipt.candidates.length > receipt.policy.maxCandidates
  )
    fail('candidates');
  const ids = new Set<string>();
  for (const candidate of receipt.candidates) {
    try {
      requireExactKeys(
        candidate,
        [
          'memoryId',
          'normalizedClaim',
          'renderedClaim',
          'section',
          'scope',
          'sensitivity',
          'salience',
          'sourceRefs',
          'tokenCost',
          'decision',
          'reasons',
          'actionAuthority',
        ],
        ['retrievalRelevance'],
        'candidate',
      );
      requireExactKeys(candidate.actionAuthority, ['granted', 'reason'], [], 'action authority');
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
    if (
      !candidate ||
      typeof candidate !== 'object' ||
      !isMemoryId(candidate.memoryId) ||
      ids.has(candidate.memoryId)
    )
      fail('candidate id');
    ids.add(candidate.memoryId);
    if (
      typeof candidate.normalizedClaim !== 'string' ||
      !candidate.normalizedClaim ||
      Buffer.byteLength(candidate.normalizedClaim, 'utf8') > receipt.policy.maxClaimBytes ||
      hasForbiddenControlCharacter(candidate.normalizedClaim)
    )
      fail('candidate claim');
    if (
      typeof candidate.renderedClaim !== 'string' ||
      candidate.renderedClaim !== renderClaimLine(candidate.renderedClaim) ||
      normalizeAdmissionClaim(candidate.renderedClaim) !== candidate.normalizedClaim ||
      !SECTION_ORDER.includes(candidate.section) ||
      hasForbiddenControlCharacter(candidate.renderedClaim)
    )
      fail('candidate rendered claim');
    if (
      typeof candidate.scope !== 'string' ||
      (candidate.scope !== 'user' &&
        candidate.scope !== 'agent' &&
        candidate.scope !== 'session' &&
        !/^project\/[a-z0-9][a-z0-9._-]*$/.test(candidate.scope)) ||
      !SENSITIVITY_LEVELS.includes(candidate.sensitivity)
    )
      fail('candidate scope/sensitivity');
    if (
      candidate.salience?.version !== 'nacre.salience.v1' ||
      candidate.salience.memoryId !== candidate.memoryId ||
      candidate.salience.evaluatedAt !== receipt.evaluatedAt
    )
      fail('candidate salience identity');
    try {
      validateFiniteSalience(candidate.salience);
    } catch {
      fail('candidate salience finite');
    }
    if (
      candidate.retrievalRelevance !== undefined &&
      (!Number.isFinite(candidate.retrievalRelevance) ||
        candidate.retrievalRelevance < 0 ||
        candidate.retrievalRelevance > 1)
    )
      fail('candidate retrieval relevance');
    if (
      !Array.isArray(candidate.sourceRefs) ||
      candidate.sourceRefs.length > 10_000 ||
      candidate.sourceRefs.some(
        (ref) =>
          typeof ref !== 'string' ||
          !ref ||
          Buffer.byteLength(ref, 'utf8') > MAX_CLAIM_BYTES ||
          hasForbiddenControlCharacter(ref),
      )
    )
      fail('candidate source refs');
    if (
      stableAdmissionJson(candidate.sourceRefs) !==
      stableAdmissionJson([...new Set(candidate.sourceRefs)].sort())
    )
      fail('candidate source refs order');
    if (receipt.kind === 'brief' && candidate.retrievalRelevance !== undefined)
      fail('brief candidate retrieval relevance');
    if (receipt.kind === 'recall' && candidate.retrievalRelevance === undefined)
      fail('recall candidate retrieval relevance');
    if (!Number.isSafeInteger(candidate.tokenCost) || candidate.tokenCost < 0)
      fail('candidate token cost');
    if (candidate.decision !== 'included' && candidate.decision !== 'rejected')
      fail('candidate decision');
    if (
      !Array.isArray(candidate.reasons) ||
      candidate.reasons.some((reason) => !REJECTION_REASONS.includes(reason))
    )
      fail('candidate reasons');
    if (
      stableAdmissionJson(candidate.reasons) !==
      stableAdmissionJson(REJECTION_REASONS.filter((reason) => candidate.reasons.includes(reason)))
    )
      fail('candidate reasons order');
    if (
      candidate.reasons.includes('invalid_provenance') !==
      (candidate.salience.gates.provenance === 0)
    )
      fail('candidate provenance decision');
    if ((candidate.decision === 'included') !== (candidate.reasons.length === 0))
      fail('candidate decision/reasons');
    if (
      candidate.actionAuthority?.granted !== false ||
      candidate.actionAuthority.reason !== 'memory_is_context_not_action_authority'
    )
      fail('candidate action authority');
    if (candidate.sensitivity === 'secret') fail('secret candidate retained');
  }
  if (!Array.isArray(receipt.included) || !Array.isArray(receipt.rejected)) fail('decision lists');
  const expectedIncluded = receipt.candidates
    .filter((candidate) => candidate.decision === 'included')
    .map((candidate) => candidate.memoryId);
  const expectedRejected = receipt.candidates
    .filter((candidate) => candidate.decision === 'rejected')
    .map((candidate) => candidate.memoryId);
  if (
    stableAdmissionJson(receipt.included) !== stableAdmissionJson(expectedIncluded) ||
    stableAdmissionJson(receipt.rejected) !== stableAdmissionJson(expectedRejected)
  )
    fail('decision lists disagree');
  const replayedIncluded: AdmissionCandidateReceipt[] = [];
  for (const candidate of receipt.candidates) {
    const currentTokens = estimateUtf8Tokens(renderReceiptBrief(replayedIncluded));
    const prospectiveTokens = estimateUtf8Tokens(
      renderReceiptBrief([...replayedIncluded, candidate]),
    );
    if (candidate.tokenCost !== Math.max(0, prospectiveTokens - currentTokens)) {
      fail('candidate token cost');
    }
    if (candidate.decision === 'included') replayedIncluded.push(candidate);
  }
  const expectedRenderedBrief = renderReceiptBrief(replayedIncluded);
  if (receipt.renderedBrief !== expectedRenderedBrief) fail('rendered brief coherence');
  if (
    !receipt.budget ||
    receipt.budget.tokenBudget !== receipt.policy.tokenBudget ||
    !Number.isSafeInteger(receipt.budget.usedTokens) ||
    receipt.budget.usedTokens < 0 ||
    receipt.budget.usedTokens > receipt.budget.tokenBudget ||
    receipt.budget.remainingTokens !== receipt.budget.tokenBudget - receipt.budget.usedTokens
  )
    fail('budget');
  if (
    typeof receipt.renderedBrief !== 'string' ||
    hasForbiddenControlCharacter(receipt.renderedBrief) ||
    estimateUtf8Tokens(receipt.renderedBrief) !== receipt.budget.usedTokens
  )
    fail('rendered brief budget');
  const { id: _id, ...withoutId } = receipt;
  if (computeAdmissionReceiptId(withoutId) !== receipt.id) fail('hash');
  return receipt;
}

function strictIso(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function strictDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

function hasForbiddenControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if ((code <= 31 && code !== 9 && code !== 10 && code !== 13) || (code >= 127 && code <= 159)) {
      return true;
    }
  }
  return false;
}

const MAX_TOKEN_BUDGET = 1_000_000;
const MAX_CANDIDATES = 10_000;
const MAX_CLAIM_BYTES = 65_536;
const MAX_STALE_DAYS = 36_500;
const MAX_QUERY_BYTES = 16_384;

function requireSafeIntegerInRange(value: number, field: string, min: number, max: number): void {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${field} must be a safe integer from ${min} to ${max}`);
  }
}

function validateFiniteSalience(receipt: SalienceReceipt): void {
  requireExactKeys(
    receipt,
    [
      'version',
      'formula',
      'memoryId',
      'evaluatedAt',
      'inputs',
      'weights',
      'components',
      'gates',
      'reasons',
      'rawScore',
      'score',
      'tieBreak',
    ],
    [],
    'salience',
  );
  const componentKeys = Object.keys(SALIENCE_WEIGHTS);
  requireExactKeys(receipt.weights, componentKeys, [], 'salience weights');
  requireExactKeys(receipt.components, componentKeys, [], 'salience components');
  requireExactKeys(receipt.gates, ['validity', 'provenance'], [], 'salience gates');
  requireExactKeys(
    receipt.inputs,
    [
      'type',
      'lifecycle',
      'provenanceMode',
      'supports',
      'entityDegrees',
      'explicitConfirmation',
      'explicitCorrection',
      'freshnessPolicy',
    ],
    ['validFrom', 'validUntil', 'legacyFallback'],
    'salience inputs',
  );
  for (const support of receipt.inputs.supports) {
    requireExactKeys(
      support,
      ['sourceEventId', 'sourceAuthority', 'authority', 'trust', 'eventTime'],
      [],
      'salience support',
    );
  }
  for (const degree of receipt.inputs.entityDegrees) {
    requireExactKeys(degree, ['entityId', 'degree'], [], 'salience entity degree');
  }
  if (receipt.inputs.legacyFallback) {
    requireExactKeys(
      receipt.inputs.legacyFallback,
      ['confidence', 'sourceAuthority', 'authority', 'trust'],
      ['eventTime'],
      'salience legacy fallback',
    );
  }
  if (
    !MEMORY_OBJECT_TYPES.includes(receipt.inputs.type) ||
    !['active', 'superseded', 'legacy_active'].includes(receipt.inputs.lifecycle ?? '') ||
    !['candidate_records', 'legacy_fallback'].includes(receipt.inputs.provenanceMode) ||
    typeof receipt.inputs.explicitConfirmation !== 'boolean' ||
    typeof receipt.inputs.explicitCorrection !== 'boolean' ||
    !['event_time_exponential_180d', 'not_applicable'].includes(receipt.inputs.freshnessPolicy)
  ) {
    throw new Error(`salience input enums are invalid for ${receipt.memoryId}`);
  }
  const validityMalformed =
    (receipt.inputs.validFrom !== undefined && !strictIso(receipt.inputs.validFrom)) ||
    (receipt.inputs.validUntil !== undefined && !strictIso(receipt.inputs.validUntil)) ||
    (receipt.inputs.validFrom !== undefined &&
      receipt.inputs.validUntil !== undefined &&
      receipt.inputs.validUntil <= receipt.inputs.validFrom);
  if (
    validityMalformed !== receipt.reasons.includes('invalid_validity_interval') ||
    (validityMalformed && receipt.gates.validity !== 0)
  ) {
    throw new Error(`salience validity is invalid for ${receipt.memoryId}`);
  }
  const supportIds = new Set<string>();
  for (const support of receipt.inputs.supports) {
    let identity: unknown;
    try {
      identity = JSON.parse(support.sourceEventId);
    } catch {
      throw new Error(`salience support identity is invalid for ${receipt.memoryId}`);
    }
    if (
      !Array.isArray(identity) ||
      identity.length !== 2 ||
      identity.some((part) => typeof part !== 'string' || !part) ||
      typeof support.sourceAuthority !== 'string' ||
      !support.sourceAuthority ||
      support.authority !== beliefAuthority(support.sourceAuthority) ||
      !strictIso(support.eventTime) ||
      support.eventTime > receipt.evaluatedAt ||
      supportIds.has(support.sourceEventId)
    ) {
      throw new Error(`salience support is invalid for ${receipt.memoryId}`);
    }
    supportIds.add(support.sourceEventId);
  }
  if (
    stableAdmissionJson(receipt.inputs.supports.map((support) => support.sourceEventId)) !==
    stableAdmissionJson([...supportIds].sort((a, b) => a.localeCompare(b)))
  ) {
    throw new Error(`salience supports are not sorted for ${receipt.memoryId}`);
  }
  const degreeIds = receipt.inputs.entityDegrees.map((degree) => degree.entityId);
  if (
    degreeIds.some((entityId) => typeof entityId !== 'string' || !entityId) ||
    stableAdmissionJson(degreeIds) !==
      stableAdmissionJson([...new Set(degreeIds)].sort((a, b) => a.localeCompare(b)))
  ) {
    throw new Error(`salience entity identities are invalid for ${receipt.memoryId}`);
  }
  if (
    receipt.inputs.legacyFallback &&
    (typeof receipt.inputs.legacyFallback.sourceAuthority !== 'string' ||
      !receipt.inputs.legacyFallback.sourceAuthority ||
      receipt.inputs.legacyFallback.authority !==
        beliefAuthority(receipt.inputs.legacyFallback.sourceAuthority) ||
      (receipt.inputs.legacyFallback.eventTime !== undefined &&
        (!strictIso(receipt.inputs.legacyFallback.eventTime) ||
          receipt.inputs.legacyFallback.eventTime > receipt.evaluatedAt)))
  ) {
    throw new Error(`salience legacy provenance is invalid for ${receipt.memoryId}`);
  }
  const supports = receipt.inputs.supports;
  const legacy = receipt.inputs.legacyFallback;
  const eventTimes = legacy?.eventTime
    ? [Date.parse(legacy.eventTime)]
    : supports.map((support) => Date.parse(support.eventTime));
  const newestEvent = eventTimes.length === 0 ? undefined : Math.max(...eventTimes);
  const expectedComponents: typeof receipt.components = {
    confidence: legacy
      ? legacy.confidence
      : 1 -
        supports.reduce((product, support) => product * (1 - support.authority * support.trust), 1),
    authority: legacy
      ? legacy.authority * legacy.trust
      : supports.length === 0
        ? 0
        : Math.max(...supports.map((support) => support.authority * support.trust)),
    corroboration: 1 - Math.exp(-Math.max(0, supports.length - 1) / 2),
    typeRelevance: TYPE_RELEVANCE[receipt.inputs.type],
    temporalPersistence:
      eventTimes.length < 2
        ? 0
        : Math.min(1, (Math.max(...eventTimes) - Math.min(...eventTimes)) / (180 * 86_400_000)),
    freshness:
      receipt.inputs.type === 'claim' || receipt.inputs.type === 'fact'
        ? newestEvent === undefined
          ? 0
          : Math.exp(-(Date.parse(receipt.evaluatedAt) - newestEvent) / (180 * 86_400_000))
        : 1,
    centrality: receipt.inputs.entityDegrees.reduce(
      (maximum, input) => Math.max(maximum, 1 - Math.exp(-input.degree / 4)),
      0,
    ),
    explicitConfirmationCorrection: receipt.inputs.explicitCorrection
      ? 1
      : receipt.inputs.explicitConfirmation
        ? 0.5
        : 0,
  };
  for (const key of Object.keys(expectedComponents) as Array<keyof typeof expectedComponents>) {
    if (Math.abs(receipt.components[key] - expectedComponents[key]) > 1e-12) {
      throw new Error(`salience component ${key} disagrees with inputs for ${receipt.memoryId}`);
    }
  }
  const expectedValidity = validityMalformed
    ? 0
    : (!receipt.inputs.validFrom || receipt.evaluatedAt >= receipt.inputs.validFrom) &&
        (!receipt.inputs.validUntil || receipt.evaluatedAt < receipt.inputs.validUntil)
      ? 1
      : 0;
  const expectedProvenance = receipt.reasons.some(
    (reason) =>
      reason === 'provenance_gate_failed' ||
      reason === 'invalid_provenance' ||
      reason === 'invalid_centrality_input',
  )
    ? 0
    : receipt.inputs.provenanceMode === 'candidate_records'
      ? 1
      : 0.5;
  if (
    receipt.gates.validity !== expectedValidity ||
    receipt.gates.provenance !== expectedProvenance
  ) {
    throw new Error(`salience gates disagree with inputs for ${receipt.memoryId}`);
  }
  const allowedReasons = new Set([
    'invalid_validity_interval',
    'outside_validity_interval',
    'invalid_centrality_input',
    'invalid_provenance',
    'provenance_gate_failed',
    'legacy_provenance_fallback',
  ]);
  if (
    !Array.isArray(receipt.reasons) ||
    receipt.reasons.some((reason) => typeof reason !== 'string' || !allowedReasons.has(reason))
  ) {
    throw new Error(`salience reasons are invalid for ${receipt.memoryId}`);
  }
  if (receipt.formula !== 'sum(weight * component) * validity * provenance') {
    throw new Error(`salience formula is invalid for ${receipt.memoryId}`);
  }
  if (stableAdmissionJson(receipt.weights) !== stableAdmissionJson(SALIENCE_WEIGHTS)) {
    throw new Error(`salience weights are invalid for ${receipt.memoryId}`);
  }
  const unitValues = [
    ...Object.values(receipt.components),
    receipt.gates.validity,
    receipt.gates.provenance,
    receipt.rawScore,
    receipt.score,
    ...receipt.inputs.supports.flatMap((support) => [support.authority, support.trust]),
  ];
  if (
    unitValues.some((value) => !Number.isFinite(value) || value < 0 || value > 1) ||
    (receipt.gates.validity !== 0 && receipt.gates.validity !== 1) ||
    ![0, 0.5, 1].includes(receipt.gates.provenance)
  ) {
    throw new Error(`salience output must be finite and bounded for ${receipt.memoryId}`);
  }
  if (
    receipt.inputs.entityDegrees.some(({ degree }) => !Number.isSafeInteger(degree) || degree < 0)
  ) {
    throw new Error(`salience entity degree is invalid for ${receipt.memoryId}`);
  }
  if (receipt.inputs.legacyFallback) {
    const legacy = [
      receipt.inputs.legacyFallback.confidence,
      receipt.inputs.legacyFallback.authority,
      receipt.inputs.legacyFallback.trust,
    ];
    if (legacy.some((value) => !Number.isFinite(value) || value < 0 || value > 1)) {
      throw new Error(`salience legacy input must be finite and bounded for ${receipt.memoryId}`);
    }
  }
  const weighted = Object.entries(SALIENCE_WEIGHTS).reduce(
    (sum, [component, weight]) =>
      sum + weight * receipt.components[component as keyof SalienceReceipt['components']],
    0,
  );
  const expectedRaw = weighted * receipt.gates.validity * receipt.gates.provenance;
  if (
    Math.abs(expectedRaw - receipt.rawScore) > 1e-12 ||
    receipt.score !== Number(receipt.rawScore.toFixed(6)) ||
    receipt.tieBreak !== receipt.memoryId
  ) {
    throw new Error(`salience score is inconsistent for ${receipt.memoryId}`);
  }
}

function validateAdmissionInputs(
  candidates: readonly AdmissionCandidate[],
  options: AdmissionOptions,
): AdmissionPolicy {
  if (options.kind !== 'brief' && options.kind !== 'recall')
    throw new Error('kind must be brief or recall');
  if (!strictIso(options.evaluatedAt))
    throw new Error('evaluatedAt must be a strict ISO timestamp');
  if (options.kind === 'recall' && (typeof options.query !== 'string' || !options.query.trim())) {
    throw new Error('recall admission requires a non-empty query');
  }
  if (options.query !== undefined && Buffer.byteLength(options.query, 'utf8') > MAX_QUERY_BYTES) {
    throw new Error(`query exceeds byte bound (${MAX_QUERY_BYTES})`);
  }
  if (options.kind === 'brief' && options.query !== undefined)
    throw new Error('brief admission does not accept query');
  if (options.degradations !== undefined) {
    if (!Array.isArray(options.degradations) || options.degradations.length > 100)
      throw new Error('degradations must be a bounded array');
    const seen = new Set<string>();
    for (const degradation of options.degradations) {
      if (
        typeof degradation !== 'string' ||
        !degradation.trim() ||
        Buffer.byteLength(degradation, 'utf8') > 4096
      ) {
        throw new Error('degradation must be a non-empty bounded string');
      }
      if (seen.has(degradation)) throw new Error('degradations must be unique');
      seen.add(degradation);
    }
  }
  const policy: AdmissionPolicy = {
    ...DEFAULT_ADMISSION_POLICY,
    ...options.policy,
    scopes: [...(options.policy?.scopes ?? DEFAULT_ADMISSION_POLICY.scopes)].sort(),
  };
  if (
    policy.scopes.length === 0 ||
    policy.scopes.some(
      (scope) =>
        typeof scope !== 'string' ||
        (scope !== 'user' &&
          scope !== 'agent' &&
          scope !== 'session' &&
          scope !== 'project/*' &&
          !/^project\/[a-z0-9][a-z0-9._-]*$/.test(scope)),
    )
  ) {
    throw new Error('scopes must be a non-empty list of supported scopes');
  }
  if (new Set(policy.scopes).size !== policy.scopes.length)
    throw new Error('scopes must be unique');
  if (typeof policy.includeSession !== 'boolean') throw new Error('includeSession must be boolean');
  if (!SENSITIVITY_LEVELS.includes(policy.maxSensitivity))
    throw new Error('maxSensitivity must be a sensitivity enum value');
  if (
    !Number.isFinite(policy.minEvidenceConfidence) ||
    policy.minEvidenceConfidence < 0 ||
    policy.minEvidenceConfidence > 1
  ) {
    throw new Error('minEvidenceConfidence must be finite and in [0, 1]');
  }
  requireSafeIntegerInRange(
    policy.staleStatefulAfterDays,
    'staleStatefulAfterDays',
    0,
    MAX_STALE_DAYS,
  );
  requireSafeIntegerInRange(policy.tokenBudget, 'tokenBudget', 1, MAX_TOKEN_BUDGET);
  requireSafeIntegerInRange(policy.maxCandidates, 'maxCandidates', 1, MAX_CANDIDATES);
  requireSafeIntegerInRange(policy.maxClaimBytes, 'maxClaimBytes', 1, MAX_CLAIM_BYTES);
  if (candidates.length > policy.maxCandidates)
    throw new Error('candidate count exceeds policy bound');
  const ids = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate?.memory) throw new Error('candidate must contain a memory');
    if (!isMemoryId(candidate.memory.id)) throw new Error('candidate memory id is malformed');
    if (ids.has(candidate.memory.id))
      throw new Error(`duplicate memory id: ${candidate.memory.id}`);
    ids.add(candidate.memory.id);
    if (!MEMORY_OBJECT_TYPES.includes(candidate.memory.type))
      throw new Error(`memory type is invalid: ${candidate.memory.id}`);
    if (!strictDate(candidate.memory.created) || !strictDate(candidate.memory.lastConfirmed))
      throw new Error(`memory dates are invalid: ${candidate.memory.id}`);
    if (!SENSITIVITY_LEVELS.includes(candidate.memory.sensitivity))
      throw new Error(`memory sensitivity is invalid: ${candidate.memory.id}`);
    if (candidate.memory.sensitivity === 'secret')
      throw new Error(`secret sensitivity is zero-retention: ${candidate.memory.id}`);
    if (
      candidate.memory.lifecycle !== undefined &&
      candidate.memory.lifecycle !== 'active' &&
      candidate.memory.lifecycle !== 'superseded'
    )
      throw new Error(`memory lifecycle is invalid: ${candidate.memory.id}`);
    if (typeof candidate.claim !== 'string')
      throw new Error(`claim must be a string: ${candidate.memory.id}`);
    if (hasForbiddenControlCharacter(candidate.claim))
      throw new Error(`claim contains a forbidden control character: ${candidate.memory.id}`);
    if (Buffer.byteLength(candidate.claim, 'utf8') > policy.maxClaimBytes)
      throw new Error(`claim exceeds byte bound: ${candidate.memory.id}`);
    if (!normalizeAdmissionClaim(candidate.claim))
      throw new Error(`claim normalizes to empty: ${candidate.memory.id}`);
    if (
      candidate.retrievalRelevance !== undefined &&
      (!Number.isFinite(candidate.retrievalRelevance) ||
        candidate.retrievalRelevance < 0 ||
        candidate.retrievalRelevance > 1)
    ) {
      throw new Error(`retrievalRelevance must be finite and in [0, 1]: ${candidate.memory.id}`);
    }
  }
  return policy;
}

export function admitWorkingMemory(
  candidates: readonly AdmissionCandidate[],
  options: AdmissionOptions,
): AdmissionReceipt {
  const policy = validateAdmissionInputs(candidates, options);

  const ranked = candidates
    .map((candidate) => {
      const salience = evaluateMemorySalience(candidate.memory, {
        evaluatedAt: options.evaluatedAt,
        entityDegrees: options.entityDegrees,
      });
      validateFiniteSalience(salience);
      return { ...candidate, salience };
    })
    .sort((a, b) =>
      options.kind === 'recall'
        ? (b.retrievalRelevance ?? 0) - (a.retrievalRelevance ?? 0) ||
          b.salience.rawScore - a.salience.rawScore ||
          a.memory.id.localeCompare(b.memory.id)
        : b.salience.rawScore - a.salience.rawScore || a.memory.id.localeCompare(b.memory.id),
    );

  const emptyBriefTokens = estimateUtf8Tokens(renderBrief([]));
  if (policy.tokenBudget < emptyBriefTokens) {
    throw new Error(`tokenBudget must fit fixed briefing sections (${emptyBriefTokens} tokens)`);
  }
  const includedInputs: Array<{ memory: MemoryObject; claim: string }> = [];
  const receipts: AdmissionCandidateReceipt[] = [];
  const sensitivityRank: Record<Sensitivity, number> = {
    low: 0,
    personal: 1,
    sensitive: 2,
    secret: 3,
  };
  const scopeAllowed = (scope: string): boolean =>
    policy.scopes.includes(scope) ||
    (scope.startsWith('project/') && policy.scopes.includes('project/*'));
  const seenClaims = new Set<string>();
  for (const candidate of ranked) {
    const reasons: AdmissionRejectionReason[] = [];
    if (candidate.memory.scope === 'session' && !policy.includeSession) {
      reasons.push('session_not_requested');
    }
    if (!scopeAllowed(candidate.memory.scope)) {
      reasons.push('wrong_scope');
    }
    const futureLegacyCreation =
      candidate.memory.candidateRecords === undefined &&
      candidate.memory.validFrom === undefined &&
      candidate.memory.created > options.evaluatedAt.slice(0, 10);
    if (candidate.salience.gates.validity === 0 || futureLegacyCreation) {
      reasons.push('inactive_or_outside_validity');
    }
    if (candidate.memory.type === 'claim' || candidate.memory.type === 'fact') {
      const eventTimes = candidate.salience.inputs.supports.map((support) => support.eventTime);
      const legacyTime = candidate.salience.inputs.legacyFallback?.eventTime;
      if (legacyTime) eventTimes.push(legacyTime);
      const newest = eventTimes.length === 0 ? undefined : Math.max(...eventTimes.map(Date.parse));
      if (
        newest === undefined ||
        Date.parse(options.evaluatedAt) - newest > policy.staleStatefulAfterDays * 86_400_000
      ) {
        reasons.push('stale_stateful_claim');
      }
    }
    const evidenceConfidence = candidate.memory.candidateRecords
      ? candidate.salience.components.confidence
      : candidate.memory.confidence;
    if (!Number.isFinite(evidenceConfidence) || evidenceConfidence < policy.minEvidenceConfidence) {
      reasons.push('below_confidence_threshold');
    }
    if (
      candidate.memory.sensitivity === 'secret' ||
      sensitivityRank[candidate.memory.sensitivity] > sensitivityRank[policy.maxSensitivity]
    ) {
      reasons.push('sensitivity_exceeds_policy');
    }
    if (candidate.salience.gates.provenance === 0) reasons.push('invalid_provenance');
    const normalizedClaim = normalizeAdmissionClaim(candidate.claim);
    if (reasons.length === 0 && seenClaims.has(normalizedClaim)) {
      reasons.push('duplicate_information');
    }
    const currentTokens = estimateUtf8Tokens(renderBrief(includedInputs));
    const prospectiveTokens = estimateUtf8Tokens(renderBrief([...includedInputs, candidate]));
    const tokenCost = Math.max(0, prospectiveTokens - currentTokens);
    if (reasons.length === 0 && prospectiveTokens > policy.tokenBudget) {
      reasons.push('token_budget_displacement');
    }
    if (reasons.length === 0) {
      seenClaims.add(normalizedClaim);
      includedInputs.push(candidate);
    }
    receipts.push({
      memoryId: candidate.memory.id,
      normalizedClaim,
      renderedClaim: renderClaimLine(candidate.claim),
      section: classifyBriefSection(candidate.memory),
      scope: candidate.memory.scope,
      sensitivity: candidate.memory.sensitivity,
      salience: candidate.salience,
      ...(candidate.retrievalRelevance === undefined
        ? {}
        : { retrievalRelevance: candidate.retrievalRelevance }),
      sourceRefs: Array.from(
        new Set(
          candidate.memory.candidateRecords
            ? candidate.salience.inputs.supports.map((support) => {
                const identity = JSON.parse(support.sourceEventId) as unknown;
                if (
                  !Array.isArray(identity) ||
                  identity.length !== 2 ||
                  typeof identity[0] !== 'string'
                ) {
                  throw new Error(`malformed source event identity: ${candidate.memory.id}`);
                }
                return identity[0];
              })
            : candidate.memory.sources,
        ),
      ).sort(),
      tokenCost,
      decision: reasons.length === 0 ? 'included' : 'rejected',
      reasons,
      actionAuthority: {
        granted: false,
        reason: 'memory_is_context_not_action_authority',
      },
    });
  }
  const renderedBrief = renderBrief(includedInputs);
  const usedTokens = estimateUtf8Tokens(renderedBrief);
  const withoutId: Omit<AdmissionReceipt, 'id'> = {
    version: ADMISSION_RECEIPT_VERSION,
    kind: options.kind,
    evaluatedAt: options.evaluatedAt,
    ...(options.query === undefined ? {} : { query: options.query }),
    scopes: [...policy.scopes],
    policy: { version: ADMISSION_POLICY_VERSION, ...policy },
    versions: {
      salience: 'nacre.salience.v1',
      tokenEstimator: TOKEN_ESTIMATOR_VERSION,
      renderer: BRIEF_RENDERER_VERSION,
    },
    degradations: [...(options.degradations ?? [])].sort(),
    candidates: receipts,
    included: receipts
      .filter((receipt) => receipt.decision === 'included')
      .map((receipt) => receipt.memoryId),
    rejected: receipts
      .filter((receipt) => receipt.decision === 'rejected')
      .map((receipt) => receipt.memoryId),
    budget: {
      tokenBudget: policy.tokenBudget,
      usedTokens,
      remainingTokens: policy.tokenBudget - usedTokens,
    },
    renderedBrief,
  };
  return { ...withoutId, id: computeAdmissionReceiptId(withoutId) };
}
