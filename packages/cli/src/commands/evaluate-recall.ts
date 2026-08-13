import { existsSync, lstatSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { defineCommand } from 'citty';
import {
  admitWorkingMemory,
  DEFAULT_CONFIG,
  encoderFingerprint,
  evaluateRecallReplayCorpus,
  parseMemoryFile,
  recall as recallMemory,
  resolveProvider,
  SqliteStore,
  type AdmissionPolicy,
  type MemoryObject,
  type RecallReplayCorpusInput,
  type RecallReplayReport,
  type RecallReplayThresholds,
} from '@nacre/core';
import { formatJSON } from '../output.js';
import { nodeEmbeddingText } from '../embed-node.js';
import {
  assertCanonicalTreeUnchanged,
  copyRegularFileBounded,
  MAX_CANONICAL_MEMORY_BYTES,
  MAX_CANONICAL_TOTAL_BYTES,
  readRegularFileBounded,
  scanCanonicalTree,
} from './evaluation-input.js';

const MANIFEST_VERSION = 'nacre.recall-replay-manifest.v1' as const;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_GRAPH_BYTES = 512 * 1024 * 1024;
const MAX_PROBES = 1_000;
const MAX_IDS = 1_000;
const MAX_STRING_BYTES = 4_096;
const MEMORY_ID = /^mem_[0-9a-f]{12}$/;
const THRESHOLD_KEYS = [
  'minRetrievalPrecisionAtK',
  'minRetrievalRecallAtK',
  'minRetrievalNdcgAtK',
  'minAdmissionPrecision',
  'minAdmissionRecall',
  'minProvenanceCompleteness',
  'maxForbiddenRetrievalLeakage',
  'maxForbiddenAdmissionLeakage',
  'maxContextTokens',
] as const;
const POLICY_KEYS = [
  'includeSession',
  'maxSensitivity',
  'minEvidenceConfidence',
  'staleStatefulAfterDays',
  'tokenBudget',
  'maxCandidates',
  'maxClaimBytes',
] as const;
const RECALL_WEIGHTS = { semantic: 0.4, graph: 0.3, recency: 0.2, importance: 0.1 } as const;
const RECALL_HOPS = 2;
const RECALL_MIN_SCORE = 0;
const CLI_OPTIONS = new Set(['graph', 'memory-dir', 'provider', 'format']);

function rejectUnknownOptions(rawArgs: string[]): void {
  let positionals = 0;
  for (let index = 0; index < rawArgs.length; index += 1) {
    const value = rawArgs[index];
    if (!value.startsWith('-')) {
      positionals += 1;
      if (positionals > 1) throw new Error(`Unexpected positional argument: ${value}`);
      continue;
    }
    if (!value.startsWith('--')) throw new Error(`Unknown option: ${value}`);
    const name = value.slice(2).split('=', 1)[0];
    if (!CLI_OPTIONS.has(name)) throw new Error(`Unknown option: --${name}`);
    if (!value.includes('=')) index += 1;
  }
}

function assertHistoricalTime(value: string, evaluatedAt: string, label: string): void {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} is not a valid timestamp`);
  if (parsed > Date.parse(evaluatedAt)) throw new Error(`${label} is later than evaluatedAt`);
}

interface RecallManifestProbe {
  id: string;
  query: string;
  evaluatedAt: string;
  limit: number;
  scopes: string[];
  expectedRelevantMemoryIds: string[];
  forbiddenRetrievalMemoryIds: string[];
  forbiddenAdmissionMemoryIds: string[];
  policy?: Partial<AdmissionPolicy>;
}

interface RecallManifest {
  version: typeof MANIFEST_VERSION;
  id: string;
  encoderFingerprint: string;
  probes: RecallManifestProbe[];
  thresholds?: Partial<RecallReplayThresholds>;
}

export interface ExecuteRecallEvaluationOptions {
  manifestPath: string;
  graphPath: string;
  memoryDir: string;
  provider: string;
}

function exactObject(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !(key in record)) ||
    Object.keys(record).some((key) => !allowed.has(key))
  ) {
    throw new Error(`${label} has an invalid shape`);
  }
  return record;
}

function boundedString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be nonempty`);
  if (Buffer.byteLength(value, 'utf8') > MAX_STRING_BYTES) throw new Error(`${label} is too large`);
  return value;
}

function strictIso(value: unknown, label: string): string {
  const text = boundedString(value, label);
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== text) {
    throw new Error(`${label} must be a strict ISO timestamp`);
  }
  return text;
}

function memoryIds(value: unknown, label: string, nonempty: boolean): string[] {
  if (!Array.isArray(value) || value.length > MAX_IDS || (nonempty && value.length === 0)) {
    throw new Error(`${label} must be a ${nonempty ? 'nonempty ' : ''}bounded array`);
  }
  const ids = value.map((item) => boundedString(item, label));
  if (ids.some((id) => !MEMORY_ID.test(id))) throw new Error(`${label} contains an invalid id`);
  if (new Set(ids).size !== ids.length) throw new Error(`${label} contains duplicate ids`);
  if (ids.some((id, index) => index > 0 && ids[index - 1].localeCompare(id) >= 0)) {
    throw new Error(`${label} must be sorted`);
  }
  return ids;
}

function sortedStrings(value: unknown, label: string, nonempty: boolean): string[] {
  if (!Array.isArray(value) || value.length > MAX_IDS || (nonempty && value.length === 0)) {
    throw new Error(`${label} must be a ${nonempty ? 'nonempty ' : ''}bounded array`);
  }
  const items = value.map((item) => boundedString(item, label));
  if (new Set(items).size !== items.length) throw new Error(`${label} contains duplicates`);
  if (items.some((item, index) => index > 0 && items[index - 1].localeCompare(item) >= 0)) {
    throw new Error(`${label} must be sorted`);
  }
  return items;
}

function parseManifest(path: string): RecallManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      readRegularFileBounded(path, MAX_MANIFEST_BYTES, 'Recall replay manifest').toString('utf8'),
    );
  } catch (error) {
    throw new Error(
      `Unable to parse recall replay manifest: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const manifest = exactObject(
    parsed,
    ['version', 'id', 'encoderFingerprint', 'probes'],
    ['thresholds'],
    'manifest',
  );
  if (manifest.version !== MANIFEST_VERSION) {
    throw new Error(`Recall replay manifest version must be ${MANIFEST_VERSION}`);
  }
  boundedString(manifest.id, 'manifest id');
  boundedString(manifest.encoderFingerprint, 'manifest encoderFingerprint');
  if (
    !Array.isArray(manifest.probes) ||
    manifest.probes.length === 0 ||
    manifest.probes.length > MAX_PROBES
  ) {
    throw new Error(`Recall replay manifest requires 1-${MAX_PROBES} probes`);
  }
  if (manifest.thresholds !== undefined) {
    const thresholds = exactObject(manifest.thresholds, [], THRESHOLD_KEYS, 'manifest thresholds');
    for (const [key, value] of Object.entries(thresholds)) {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`manifest threshold ${key} must be finite`);
      }
    }
  }
  const probeIds = new Set<string>();
  for (const [index, value] of manifest.probes.entries()) {
    const label = `probe ${index}`;
    const probe = exactObject(
      value,
      [
        'id',
        'query',
        'evaluatedAt',
        'limit',
        'scopes',
        'expectedRelevantMemoryIds',
        'forbiddenRetrievalMemoryIds',
        'forbiddenAdmissionMemoryIds',
      ],
      ['policy'],
      label,
    );
    const id = boundedString(probe.id, `${label} id`);
    if (probeIds.has(id)) throw new Error('Recall replay probe ids must be unique');
    probeIds.add(id);
    boundedString(probe.query, `${label} query`);
    strictIso(probe.evaluatedAt, `${label} evaluatedAt`);
    if (
      !Number.isSafeInteger(probe.limit) ||
      (probe.limit as number) < 1 ||
      (probe.limit as number) > MAX_IDS
    ) {
      throw new Error(`${label} limit must be an integer from 1 to ${MAX_IDS}`);
    }
    const expected = memoryIds(probe.expectedRelevantMemoryIds, `${label} expected ids`, true);
    const forbiddenRetrieval = memoryIds(
      probe.forbiddenRetrievalMemoryIds,
      `${label} forbidden retrieval ids`,
      false,
    );
    const forbiddenAdmission = memoryIds(
      probe.forbiddenAdmissionMemoryIds,
      `${label} forbidden admission ids`,
      false,
    );
    sortedStrings(probe.scopes, `${label} scopes`, true);
    if (
      expected.some(
        (memoryId) =>
          forbiddenRetrieval.includes(memoryId) || forbiddenAdmission.includes(memoryId),
      )
    ) {
      throw new Error(`${label} expected and forbidden ids overlap`);
    }
    if (probe.policy !== undefined) exactObject(probe.policy, [], POLICY_KEYS, `${label} policy`);
  }
  return manifest as unknown as RecallManifest;
}

export async function executeRecallEvaluation(
  options: ExecuteRecallEvaluationOptions,
): Promise<RecallReplayReport> {
  const manifest = parseManifest(options.manifestPath);
  if (options.provider !== 'mock') {
    throw new Error('Deterministic recall evaluation currently requires the mock provider');
  }
  const graphStat = lstatSync(options.graphPath);
  if (graphStat.isSymbolicLink() || !graphStat.isFile()) {
    throw new Error('Recall evaluation graph must be a regular file, not a symbolic link');
  }
  if (
    existsSync(`${options.graphPath}-wal`) ||
    existsSync(`${options.graphPath}-shm`) ||
    existsSync(`${options.graphPath}-journal`)
  ) {
    throw new Error(
      'Recall evaluation requires a closed, checkpointed graph without SQLite sidecars',
    );
  }
  const canonicalRoot = realpathSync(resolve(options.memoryDir));
  const files = scanCanonicalTree(options.memoryDir);
  if (files.length === 0) throw new Error('Recall evaluation requires nonempty canonical memory');
  const canonicalById = new Map<
    string,
    { memory: MemoryObject; claim: string; canonicalPath: string }
  >();
  let canonicalBytes = 0;
  for (const { file, path, identity } of files) {
    const actualBefore = realpathSync(file);
    if (!actualBefore.startsWith(`${canonicalRoot}${sep}`)) {
      throw new Error(`Canonical memory path resolves outside the memory root: ${path}`);
    }
    const bytes = readRegularFileBounded(
      file,
      MAX_CANONICAL_MEMORY_BYTES,
      `Canonical memory ${path}`,
      identity,
    );
    const actualAfter = realpathSync(file);
    if (actualAfter !== actualBefore) {
      throw new Error(`Canonical memory path changed while it was read: ${path}`);
    }
    canonicalBytes += bytes.length;
    if (canonicalBytes > MAX_CANONICAL_TOTAL_BYTES) {
      throw new Error('Canonical memory tree exceeds the 64 MiB aggregate input limit');
    }
    const parsed = parseMemoryFile(bytes.toString('utf8'), path);
    if (canonicalById.has(parsed.memory.id)) {
      throw new Error(`Duplicate canonical memory id: ${parsed.memory.id}`);
    }
    canonicalById.set(parsed.memory.id, {
      memory: parsed.memory,
      claim: parsed.claim,
      canonicalPath: path,
    });
  }
  assertCanonicalTreeUnchanged(options.memoryDir, files);

  const provider = resolveProvider({
    provider: options.provider,
    graphPath: options.graphPath,
    allowNull: false,
  });
  if (!provider) throw new Error('Recall evaluation requires an embedding provider');
  const activeFingerprint = encoderFingerprint(provider);
  if (activeFingerprint !== manifest.encoderFingerprint) {
    throw new Error(
      `Recall replay encoder fingerprint mismatch: manifest ${manifest.encoderFingerprint}, active ${activeFingerprint}`,
    );
  }

  // SQLite may create WAL shared-memory sidecars even for a read-only connection.
  // Evaluate an isolated byte copy so the source graph remains untouched.
  const isolatedRoot = mkdtempSync(join(tmpdir(), 'nacre-recall-evaluation-'));
  const isolatedGraph = join(isolatedRoot, 'graph.db');
  let store: SqliteStore | undefined;
  try {
    copyRegularFileBounded(
      options.graphPath,
      isolatedGraph,
      MAX_GRAPH_BYTES,
      'Recall evaluation graph',
      {
        dev: graphStat.dev,
        ino: graphStat.ino,
        size: graphStat.size,
        mtimeMs: graphStat.mtimeMs,
        ctimeMs: graphStat.ctimeMs,
      },
    );
    if (
      existsSync(`${options.graphPath}-wal`) ||
      existsSync(`${options.graphPath}-shm`) ||
      existsSync(`${options.graphPath}-journal`)
    ) {
      throw new Error('Recall evaluation graph acquired SQLite sidecars while it was copied');
    }
    store = SqliteStore.openReadOnly(isolatedGraph);
    const probes: RecallReplayCorpusInput['probes'] = [];
    for (const probe of manifest.probes) {
      const eligibleSnapshots = store.listSnapshots({ until: probe.evaluatedAt, limit: 2 });
      const selectedSnapshot = eligibleSnapshots[0];
      if (!selectedSnapshot) {
        throw new Error(`No snapshot found before ${probe.evaluatedAt}`);
      }
      if (eligibleSnapshots[1]?.createdAt === selectedSnapshot.createdAt) {
        throw new Error(`Ambiguous snapshots at ${selectedSnapshot.createdAt}`);
      }
      const graph = { ...store.getSnapshotGraph(selectedSnapshot.id), config: DEFAULT_CONFIG };
      const graphNodes = Object.values(graph.nodes).sort((left, right) =>
        left.id.localeCompare(right.id),
      );
      if (graphNodes.length === 0) {
        throw new Error('Recall evaluation requires a nonempty snapshot graph');
      }
      for (const node of graphNodes) {
        assertHistoricalTime(node.firstSeen, probe.evaluatedAt, `Node ${node.id} firstSeen`);
        assertHistoricalTime(
          node.lastReinforced,
          probe.evaluatedAt,
          `Node ${node.id} lastReinforced`,
        );
        for (const excerpt of node.excerpts) {
          assertHistoricalTime(excerpt.date, probe.evaluatedAt, `Node ${node.id} excerpt date`);
        }
      }
      for (const edge of Object.values(graph.edges)) {
        assertHistoricalTime(edge.firstFormed, probe.evaluatedAt, `Edge ${edge.id} firstFormed`);
        assertHistoricalTime(
          edge.lastReinforced,
          probe.evaluatedAt,
          `Edge ${edge.id} lastReinforced`,
        );
        for (const evidence of edge.evidence) {
          assertHistoricalTime(evidence.date, probe.evaluatedAt, `Edge ${edge.id} evidence date`);
        }
      }
      const canonicalByPath = new Map(
        [...canonicalById.entries()].map(([id, canonical]) => [canonical.canonicalPath, id]),
      );
      for (const node of graphNodes) {
        if (node.status === 'promoted' || node.canonicalPath !== undefined) {
          const pathOwner = node.canonicalPath && canonicalByPath.get(node.canonicalPath);
          if (node.status !== 'promoted' || pathOwner !== node.id) {
            throw new Error(`Graph node ${node.id} has an incoherent canonical mapping`);
          }
        }
      }
      for (const [id, canonical] of canonicalById) {
        const node = graph.nodes[id];
        if (node?.status !== 'promoted' || node.canonicalPath !== canonical.canonicalPath) {
          throw new Error(`Canonical memory ${id} has an incoherent graph mapping`);
        }
      }
      const canonicalForNode = (nodeId: string) => {
        const canonical = canonicalById.get(nodeId);
        if (!canonical) return undefined;
        return canonical;
      };
      const replayStore = SqliteStore.open();
      let response: Awaited<ReturnType<typeof recallMemory>>;
      try {
        replayStore.importGraph(graph);
        for (const node of graphNodes) {
          const content = nodeEmbeddingText(node);
          replayStore.putEmbedding(
            node.id,
            'node',
            content,
            await provider.embed(content),
            provider.name,
            probe.evaluatedAt,
          );
        }
        replayStore.createSnapshot(
          'manual',
          { sourceSnapshotId: selectedSnapshot.id },
          probe.evaluatedAt,
        );
        response = await recallMemory(replayStore, provider, {
          query: probe.query,
          limit: probe.limit,
          asOf: probe.evaluatedAt,
          requireSnapshot: true,
          includeProcedures: false,
          hops: RECALL_HOPS,
          minScore: RECALL_MIN_SCORE,
          weights: RECALL_WEIGHTS,
          scopes: probe.scopes,
        });
      } finally {
        replayStore.close();
      }
      const candidates = response.results.flatMap((result) => {
        const canonical = canonicalForNode(result.id);
        return canonical ? [{ ...canonical, retrievalRelevance: result.score }] : [];
      });
      probes.push({
        id: probe.id,
        query: probe.query,
        evaluatedAt: probe.evaluatedAt,
        expectedRelevantMemoryIds: probe.expectedRelevantMemoryIds,
        forbiddenRetrievalMemoryIds: probe.forbiddenRetrievalMemoryIds,
        forbiddenAdmissionMemoryIds: probe.forbiddenAdmissionMemoryIds,
        retrieval: {
          kind: 'nacre_hybrid_recall',
          limit: probe.limit,
          hops: RECALL_HOPS,
          minScore: RECALL_MIN_SCORE,
          scopes: probe.scopes,
          includeProcedures: false,
          graphConfig: DEFAULT_CONFIG,
          weights: RECALL_WEIGHTS,
          results: response.results.map((result, index) => {
            const canonical = canonicalForNode(result.id);
            return {
              rank: index + 1,
              nodeId: result.id,
              canonicalMemoryId: canonical?.memory.id ?? null,
              canonicalPath: canonical?.canonicalPath ?? null,
              score: result.score,
              scores: { ...result.scores },
            };
          }),
        },
        admissionReceipt: admitWorkingMemory(candidates, {
          kind: 'recall',
          query: probe.query,
          evaluatedAt: probe.evaluatedAt,
          policy: { ...probe.policy, scopes: probe.scopes },
        }),
      });
    }
    assertCanonicalTreeUnchanged(options.memoryDir, files);
    return evaluateRecallReplayCorpus({
      version: 'nacre.recall-replay-corpus.v1',
      id: manifest.id,
      candidateSet: 'complete_canonical',
      encoderFingerprint: activeFingerprint,
      canonicalMemoryIds: [...canonicalById.keys()].sort((left, right) =>
        left.localeCompare(right),
      ),
      probes,
      thresholds: manifest.thresholds,
    });
  } finally {
    try {
      store?.close();
    } finally {
      rmSync(isolatedRoot, { recursive: true, force: true });
    }
  }
}

export default defineCommand({
  meta: {
    name: 'recall',
    description: 'Evaluate deterministic explicit-recall traces separately from admission',
  },
  args: {
    manifest: {
      type: 'positional',
      description: 'Explicit-recall corpus manifest JSON',
      required: true,
    },
    graph: { type: 'string', description: 'Read-only Nacre graph database', required: true },
    'memory-dir': { type: 'string', description: 'Canonical memory root', required: true },
    provider: {
      type: 'string',
      description: 'Embedding provider matching the manifest fingerprint',
      required: true,
    },
    format: { type: 'string', description: 'Output format: text or json', default: 'text' },
  },
  async run({ args, rawArgs }) {
    rejectUnknownOptions(rawArgs);
    const format = args.format as string;
    if (format !== 'text' && format !== 'json') throw new Error(`Invalid format: ${format}`);
    const report = await executeRecallEvaluation({
      manifestPath: args.manifest as string,
      graphPath: args.graph as string,
      memoryDir: args['memory-dir'] as string,
      provider: args.provider as string,
    });
    if (format === 'json') console.log(formatJSON(report));
    else {
      console.log(
        `${report.passed ? 'PASS' : 'FAIL'} ${report.summary.passedProbeCount}/${report.summary.probeCount} recall probes; ` +
          `${report.summary.totalForbiddenRetrievalLeakage} retrieval leaks; ` +
          `${report.summary.totalForbiddenAdmissionLeakage} admission leaks`,
      );
    }
    if (!report.passed) process.exitCode = 1;
  },
});
