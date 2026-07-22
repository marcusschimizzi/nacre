import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { ingestConversationDerived, type IngestOptions, type IngestResult } from './ingest.js';
import { isDurableScope } from './scopes.js';
import type { SqliteStore } from './store.js';
import type { ConversationInput, ImportLedgerEntry } from './types.js';

const ADAPTER_NAME = 'openclaw';
const ADAPTER_VERSION = '1';
const NAMESPACE_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export interface HistoricalImportOptions {
  store: SqliteStore;
  memoryRoot: string;
  scope?: string;
  extractEntities?: IngestOptions['extractEntities'];
  ingestedAt?: string;
  writeEvidence?: boolean;
  recoverEvidenceIngestedAt?: boolean;
}

export interface HistoricalImportResult extends IngestResult {
  importId: string;
  status: 'complete' | 'skipped';
  evidencePath: string;
  sourceDigest: string;
}

export interface HistoricalImportIdentity {
  importId: string;
  sourceDigest: string;
  sourceNamespace: string;
  logicalSourceId: string;
}

interface EvidenceHeader {
  type: 'nacre-conversation-evidence';
  version: 1;
  importId: string;
  ingestedAt: string;
  metadata: NonNullable<ConversationInput['metadata']>;
  integrityDigest: string;
}

function sourceRefSuffix(sourceRef: string | undefined): string | undefined {
  if (!sourceRef) return undefined;
  const marker = sourceRef.indexOf('#');
  return marker >= 0 ? sourceRef.slice(marker) : undefined;
}

function stableWarning(warning: string): string {
  return warning.replace(/^.*(?=:\d+: )/, '<source>');
}

function stablePayload(input: ConversationInput): string {
  return JSON.stringify({
    metadata: {
      sessionId: input.metadata?.sessionId,
      platform: input.metadata?.platform,
      agentId: input.metadata?.agentId,
      sourceNamespace: input.metadata?.sourceNamespace,
      topic: input.metadata?.topic,
      eventStart: input.metadata?.eventStart,
      eventEnd: input.metadata?.eventEnd,
      scope: input.metadata?.scope,
    },
    messages: input.messages.map(({ sourceRef: _sourceRef, ...message }) => message),
    warnings: (input.warnings ?? []).map(stableWarning),
    rawEvidence: input.rawEvidence ?? [],
  });
}

function digestOf(input: ConversationInput): string {
  return createHash('sha256').update(stablePayload(input)).digest('hex');
}

function identityInputOf(input: ConversationInput, scope: string): ConversationInput {
  return { ...input, metadata: { ...input.metadata, scope } };
}

function importIdOf(namespace: string, sessionId: string, digest: string): string {
  return `imp_${createHash('sha256')
    .update(`${namespace}\0${sessionId}\0${digest}\0${ADAPTER_NAME}\0${ADAPTER_VERSION}`)
    .digest('hex')
    .slice(0, 24)}`;
}

function evidenceHeaderDigest(header: Omit<EvidenceHeader, 'integrityDigest'>): string {
  return createHash('sha256').update(JSON.stringify(header)).digest('hex');
}

export function historicalImportIdentity(
  input: ConversationInput,
  scope = input.metadata?.scope ?? 'agent',
): HistoricalImportIdentity {
  const sourceNamespace = input.metadata?.sourceNamespace ?? ADAPTER_NAME;
  const logicalSourceId = input.metadata?.sessionId;
  if (!logicalSourceId) throw new Error('Historical imports require a logical session ID');
  const sourceDigest = digestOf(identityInputOf(input, scope));
  return {
    importId: importIdOf(sourceNamespace, logicalSourceId, sourceDigest),
    sourceDigest,
    sourceNamespace,
    logicalSourceId,
  };
}

function evidencePathFor(
  root: string,
  namespace: string,
  sessionId: string,
  digest: string,
): string {
  if (!NAMESPACE_RE.test(namespace)) {
    throw new Error(`Invalid source namespace: "${namespace}"`);
  }
  const safeSession = sessionId.replaceAll(/[^a-zA-Z0-9._-]/g, '_');
  const evidenceRoot = resolve(root, '.evidence', 'conversations');
  const path = resolve(evidenceRoot, namespace, `${safeSession}-${digest.slice(0, 16)}.jsonl`);
  const rel = relative(evidenceRoot, path);
  if (rel === '' || rel.startsWith('..') || resolve(evidenceRoot, rel) !== path) {
    throw new Error('Evidence path escapes the configured memory root');
  }
  return path;
}

function durableInput(
  input: ConversationInput,
  namespace: string,
  sessionId: string,
  sourceDigest: string,
  scope: string,
): ConversationInput {
  return {
    messages: input.messages.map((message) => {
      const suffix = sourceRefSuffix(message.sourceRef);
      return {
        ...message,
        ...(suffix
          ? { sourceRef: `${namespace}:${sessionId}${suffix}` }
          : { sourceRef: undefined }),
      };
    }),
    ...(input.warnings ? { warnings: input.warnings.map(stableWarning) } : {}),
    ...(input.rawEvidence ? { rawEvidence: [...input.rawEvidence] } : {}),
    metadata: {
      ...input.metadata,
      source: `evidence:${namespace}:${sessionId}`,
      sourceNamespace: namespace,
      sourceDigest,
      scope,
    },
  };
}

function serializeEvidence(header: EvidenceHeader, input: ConversationInput): string {
  return [
    JSON.stringify(header),
    ...input.messages.map((message) => JSON.stringify({ type: 'message', message })),
    ...(input.warnings ?? []).map((warning) => JSON.stringify({ type: 'warning', warning })),
    ...(input.rawEvidence ?? []).map((evidence) => JSON.stringify({ type: 'raw', evidence })),
    '',
  ].join('\n');
}

function verifyEvidence(path: string, content: string): void {
  if (!existsSync(path))
    throw new Error(`Evidence integrity failure: ${basename(path)} is missing`);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Evidence integrity failure: ${basename(path)} is not a regular file`);
  }
  if (readFileSync(path, 'utf8') !== content) {
    throw new Error(`Evidence integrity failure: ${basename(path)} content does not match import`);
  }
  if ((stat.mode & 0o777) !== 0o600) chmodSync(path, 0o600);
}

function ensureEvidenceAncestors(memoryRoot: string, path: string, create: boolean): void {
  const resolvedRoot = resolve(memoryRoot);
  const rootStat = lstatSync(resolvedRoot, { throwIfNoEntry: false });
  if (rootStat?.isSymbolicLink() || (rootStat && !rootStat.isDirectory())) {
    throw new Error(`Configured memory root must be a real directory: ${resolvedRoot}`);
  }
  if (!rootStat) {
    if (!create) throw new Error(`Evidence ancestor is missing: ${resolvedRoot}`);
    mkdirSync(resolvedRoot, { recursive: true, mode: 0o700 });
  }
  const rel = relative(resolvedRoot, dirname(path));
  if (rel.startsWith('..')) throw new Error('Evidence path escapes the configured memory root');
  let current = resolvedRoot;
  for (const component of rel.split(/[/\\]/).filter(Boolean)) {
    current = join(current, component);
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (stat) {
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error(`Evidence ancestor must be a real directory, not a symlink: ${current}`);
      }
    } else if (create) {
      mkdirSync(current, { mode: 0o700 });
    } else {
      throw new Error(`Evidence ancestor is missing: ${current}`);
    }
    if (create) chmodSync(current, 0o700);
  }
}

function writeEvidence(memoryRoot: string, path: string, content: string): void {
  ensureEvidenceAncestors(memoryRoot, path, true);
  const destination = lstatSync(path, { throwIfNoEntry: false });
  if (destination) {
    verifyEvidence(path, content);
    return;
  }

  const temporary = `${path}.tmp-${randomUUID()}`;
  try {
    writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    const file = openSync(temporary, 'r');
    try {
      fsyncSync(file);
    } finally {
      closeSync(file);
    }
    renameSync(temporary, path);
    chmodSync(path, 0o600);
    const directory = openSync(dirname(path), 'r');
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } finally {
    rmSync(temporary, { force: true });
  }
}

const emptyResult = (): IngestResult => ({
  chunksProcessed: 0,
  episodesCreated: 0,
  nodesCreated: 0,
  nodesReinforced: 0,
  edgesCreated: 0,
  duplicatesSkipped: 0,
});

export async function importHistoricalConversation(
  input: ConversationInput,
  options: HistoricalImportOptions,
): Promise<HistoricalImportResult> {
  const scope = options.scope ?? input.metadata?.scope ?? 'agent';
  if (!isDurableScope(scope)) {
    throw new Error(`Historical evidence requires a durable scope: "${scope}"`);
  }
  const identityInput = identityInputOf(input, scope);
  // External/archive digests are useful inventory metadata, but durable import
  // identity is authenticated from normalized evidence itself.
  const {
    importId,
    sourceDigest,
    sourceNamespace: namespace,
    logicalSourceId: sessionId,
  } = historicalImportIdentity(input, scope);
  const evidencePath = evidencePathFor(options.memoryRoot, namespace, sessionId, sourceDigest);
  const existing = options.store.getImport(importId);
  let ingestedAt = existing?.ingestedAt ?? options.ingestedAt ?? new Date().toISOString();
  if (!existing && existsSync(evidencePath) && options.recoverEvidenceIngestedAt !== false) {
    const firstLine = readFileSync(evidencePath, 'utf8').split('\n', 1)[0];
    try {
      const persisted = JSON.parse(firstLine) as Partial<EvidenceHeader>;
      if (persisted.type === 'nacre-conversation-evidence' && persisted.importId === importId) {
        ingestedAt = persisted.ingestedAt ?? ingestedAt;
      }
    } catch {
      throw new Error(
        `Evidence integrity failure: ${basename(evidencePath)} has an invalid header`,
      );
    }
  }
  const normalized = durableInput(identityInput, namespace, sessionId, sourceDigest, scope);
  const durableHeader: Omit<EvidenceHeader, 'integrityDigest'> = {
    type: 'nacre-conversation-evidence',
    version: 1,
    importId,
    ingestedAt,
    metadata: normalized.metadata ?? {},
  };
  const header: EvidenceHeader = {
    ...durableHeader,
    integrityDigest: evidenceHeaderDigest(durableHeader),
  };
  const evidence = serializeEvidence(header, normalized);

  if (existing?.status === 'complete') {
    ensureEvidenceAncestors(options.memoryRoot, evidencePath, false);
    verifyEvidence(evidencePath, evidence);
    return {
      ...emptyResult(),
      duplicatesSkipped: existing.episodeCount,
      importId,
      status: 'skipped',
      evidencePath,
      sourceDigest,
    };
  }

  if (options.writeEvidence !== false) writeEvidence(options.memoryRoot, evidencePath, evidence);

  const running: ImportLedgerEntry = {
    id: importId,
    sourceNamespace: namespace,
    logicalSourceId: sessionId,
    sourceDigest,
    adapterName: ADAPTER_NAME,
    adapterVersion: ADAPTER_VERSION,
    status: 'running',
    ingestedAt,
    messageCount: normalized.messages.length,
    episodeCount: 0,
    evidencePath,
  };
  options.store.putImport(running);
  try {
    const result = options.store.transaction(() => {
      const derived = ingestConversationDerived(normalized, {
        store: options.store,
        deduplicateBy: 'none',
        scope,
        extractEntities: options.extractEntities,
      });
      options.store.putImport({
        ...running,
        status: 'complete',
        completedAt: new Date().toISOString(),
        episodeCount: derived.episodesCreated,
        report: {
          origins: Object.fromEntries(
            [...new Set(normalized.messages.map((message) => message.origin ?? 'direct'))].map(
              (origin) => [
                origin,
                normalized.messages.filter((message) => (message.origin ?? 'direct') === origin)
                  .length,
              ],
            ),
          ),
          warningCount: normalized.warnings?.length ?? 0,
        },
      });
      return derived;
    });
    return { ...result, importId, status: 'complete', evidencePath, sourceDigest };
  } catch (error) {
    options.store.putImport({
      ...running,
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

function evidenceFiles(path: string): string[] {
  if (!existsSync(path)) return [];
  const rootStat = lstatSync(path);
  if (rootStat.isSymbolicLink()) throw new Error('Historical evidence root cannot be a symlink');
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = join(path, entry.name);
    if (entry.isSymbolicLink())
      throw new Error(`Historical evidence cannot contain symlinks: ${child}`);
    return entry.isDirectory()
      ? evidenceFiles(child)
      : entry.isFile() && entry.name.endsWith('.jsonl')
        ? [child]
        : [];
  });
}

function parseEvidence(path: string): { header: EvidenceHeader; input: ConversationInput } {
  let records: Array<
    | EvidenceHeader
    | { type: 'message'; message: ConversationInput['messages'][number] }
    | { type: 'warning'; warning: string }
    | { type: 'raw'; evidence: NonNullable<ConversationInput['rawEvidence']>[number] }
  >;
  try {
    records = readFileSync(path, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    throw new Error(`Evidence integrity failure: ${basename(path)} contains invalid JSONL`);
  }
  const header = records[0] as EvidenceHeader;
  if (header.type !== 'nacre-conversation-evidence' || header.version !== 1) {
    throw new Error(`Unsupported historical evidence file: ${basename(path)}`);
  }
  const { integrityDigest, ...durableHeader } = header;
  if (
    typeof integrityDigest !== 'string' ||
    integrityDigest !== evidenceHeaderDigest(durableHeader)
  ) {
    throw new Error(`Evidence integrity failure: ${basename(path)} header digest mismatch`);
  }
  if (!header.metadata?.sourceDigest || !header.metadata.sessionId) {
    throw new Error(`Invalid historical evidence header: ${basename(path)}`);
  }
  for (const record of records.slice(1)) {
    const type = (record as { type?: unknown }).type;
    if (!['message', 'warning', 'raw'].includes(String(type))) {
      throw new Error(`Evidence integrity failure: ${basename(path)} has an unknown record type`);
    }
  }
  const input: ConversationInput = {
    metadata: header.metadata,
    messages: records
      .slice(1)
      .filter((record) => (record as { type?: string }).type === 'message')
      .map(
        (record) =>
          (record as { type: 'message'; message: ConversationInput['messages'][number] }).message,
      ),
    warnings: records
      .slice(1)
      .filter((record) => (record as { type?: string }).type === 'warning')
      .map((record) => (record as { type: 'warning'; warning: string }).warning),
    rawEvidence: records
      .slice(1)
      .filter((record) => (record as { type?: string }).type === 'raw')
      .map(
        (record) =>
          (
            record as {
              type: 'raw';
              evidence: NonNullable<ConversationInput['rawEvidence']>[number];
            }
          ).evidence,
      ),
  };
  const namespace = input.metadata?.sourceNamespace;
  const sessionId = input.metadata?.sessionId;
  if (!namespace || !sessionId || !NAMESPACE_RE.test(namespace)) {
    throw new Error(`Evidence integrity failure: ${basename(path)} has invalid source identity`);
  }
  if (input.metadata?.source !== `evidence:${namespace}:${sessionId}`) {
    throw new Error(`Evidence integrity failure: ${basename(path)} has a non-canonical source`);
  }
  const normalizedDigest = digestOf(input);
  if (normalizedDigest !== header.metadata.sourceDigest) {
    throw new Error(`Evidence integrity failure: ${basename(path)} normalized digest mismatch`);
  }
  const expectedImportId = importIdOf(namespace, sessionId, normalizedDigest);
  if (header.importId !== expectedImportId) {
    throw new Error(`Evidence integrity failure: ${basename(path)} import ID mismatch`);
  }
  const safeSession = sessionId.replaceAll(/[^a-zA-Z0-9._-]/g, '_');
  const expectedFilename = `${safeSession}-${normalizedDigest.slice(0, 16)}.jsonl`;
  if (basename(path) !== expectedFilename) {
    throw new Error(`Evidence integrity failure: filename must be ${expectedFilename}`);
  }
  if (basename(dirname(path)) !== namespace) {
    throw new Error(
      `Evidence integrity failure: namespace directory mismatch for ${basename(path)}`,
    );
  }
  return { header, input };
}

export async function rebuildHistoricalEvidence(
  store: SqliteStore,
  memoryRoot: string,
  options?: Pick<HistoricalImportOptions, 'extractEntities'>,
): Promise<{ importsCompleted: number; episodesCreated: number }> {
  let importsCompleted = 0;
  let episodesCreated = 0;
  const root = join(memoryRoot, '.evidence', 'conversations');
  if (existsSync(root)) ensureEvidenceAncestors(memoryRoot, join(root, '.probe'), false);
  for (const path of evidenceFiles(root).sort()) {
    const { input } = parseEvidence(path);
    const result = await importHistoricalConversation(input, {
      store,
      memoryRoot,
      extractEntities: options?.extractEntities,
      // A rebuild records its own ingestion time. Source chronology comes from
      // message event timestamps, not a self-authored evidence header.
      ingestedAt: new Date().toISOString(),
      writeEvidence: false,
      recoverEvidenceIngestedAt: false,
    });
    if (result.status === 'complete') importsCompleted++;
    episodesCreated += result.episodesCreated;
  }
  return { importsCompleted, episodesCreated };
}
