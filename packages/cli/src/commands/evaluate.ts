import { lstatSync, opendirSync, readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { defineCommand } from 'citty';
import {
  admitWorkingMemory,
  evaluateReplayCorpus,
  parseMemoryFile,
  type AdmissionPolicy,
  type ReplayCorpusInput,
  type ReplayEvaluationReport,
  type ReplayEvaluationThresholds,
} from '@nacre/core';
import { formatJSON } from '../output.js';

const MANIFEST_VERSION = 'nacre.replay-manifest.v1' as const;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_CANONICAL_MEMORY_BYTES = 1024 * 1024;
const MAX_CANONICAL_MEMORY_FILES = 10_000;
const MAX_CANONICAL_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_CANONICAL_TREE_ENTRIES = 20_000;
const MAX_CANONICAL_TREE_DEPTH = 64;
const MAX_REPLAY_PROBES = 1_000;
const MAX_REPLAY_IDS_PER_SET = 1_000;
const THRESHOLD_KEYS = [
  'minCandidatePrecisionAtK',
  'minCandidateRecallAtK',
  'minCandidateNdcgAtK',
  'minAdmissionPrecision',
  'minAdmissionRecall',
  'minProvenanceCompleteness',
  'maxUnsupportedIncluded',
  'maxForbiddenLeakage',
  'maxContextTokensPerProbe',
] as const;
const POLICY_KEYS = [
  'scopes',
  'includeSession',
  'maxSensitivity',
  'minEvidenceConfidence',
  'staleStatefulAfterDays',
  'tokenBudget',
  'maxCandidates',
  'maxClaimBytes',
] as const;

interface ReplayManifestProbe {
  id: string;
  evaluatedAt: string;
  expectedRelevantMemoryIds: string[];
  forbiddenMemoryIds: string[];
  policy?: Partial<AdmissionPolicy>;
}

interface ReplayManifest {
  version: typeof MANIFEST_VERSION;
  id: string;
  probes: ReplayManifestProbe[];
  thresholds?: Partial<ReplayEvaluationThresholds>;
}

export interface ExecuteReplayEvaluationOptions {
  manifestPath: string;
  memoryDir: string;
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

function parseManifest(path: string): ReplayManifest {
  const manifestStat = lstatSync(path);
  if (manifestStat.isSymbolicLink() || !manifestStat.isFile()) {
    throw new Error('Replay manifest must be a regular file, not a symbolic link');
  }
  if (manifestStat.size > MAX_MANIFEST_BYTES) {
    throw new Error('Replay manifest exceeds the 4 MiB input limit');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(
      `Unable to parse replay manifest: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const manifest = exactObject(parsed, ['version', 'id', 'probes'], ['thresholds'], 'manifest');
  if (manifest.version !== MANIFEST_VERSION) {
    throw new Error(`Replay manifest version must be ${MANIFEST_VERSION}`);
  }
  if (!Array.isArray(manifest.probes) || manifest.probes.length === 0) {
    throw new Error('Replay manifest requires at least one probe');
  }
  if (manifest.probes.length > MAX_REPLAY_PROBES) {
    throw new Error(`Replay manifest supports at most ${MAX_REPLAY_PROBES} probes`);
  }
  if (manifest.thresholds !== undefined) {
    exactObject(manifest.thresholds, [], THRESHOLD_KEYS, 'manifest thresholds');
  }
  for (const [index, value] of manifest.probes.entries()) {
    const probe = exactObject(
      value,
      ['id', 'evaluatedAt', 'expectedRelevantMemoryIds', 'forbiddenMemoryIds'],
      ['policy'],
      `probe ${index}`,
    );
    if (probe.policy !== undefined)
      exactObject(probe.policy, [], POLICY_KEYS, `probe ${index} policy`);
    for (const field of ['expectedRelevantMemoryIds', 'forbiddenMemoryIds'] as const) {
      const ids = probe[field];
      if (!Array.isArray(ids) || ids.length > MAX_REPLAY_IDS_PER_SET) {
        throw new Error(`probe ${index} ${field} must be an array of at most 1000 ids`);
      }
    }
    const expectedIds = probe.expectedRelevantMemoryIds;
    if (!Array.isArray(expectedIds) || expectedIds.length === 0) {
      throw new Error(`probe ${index} requires at least one expected relevant memory`);
    }
  }
  return manifest as unknown as ReplayManifest;
}

interface CanonicalInputFile {
  path: string;
  file: string;
}

function scanCanonicalTree(rootInput: string): CanonicalInputFile[] {
  const root = resolve(rootInput);
  const rootStat = lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error('Canonical memory root must be a real directory, not a symbolic link');
  }
  const pending = [{ directory: root, relative: '', depth: 0, ignored: false }];
  const files: CanonicalInputFile[] = [];
  let entries = 0;
  let totalBytes = 0;

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    const directory = opendirSync(current.directory);
    try {
      for (;;) {
        const entry = directory.readSync();
        if (!entry) break;
        entries += 1;
        if (entries > MAX_CANONICAL_TREE_ENTRIES) {
          throw new Error(
            `Canonical memory tree exceeds the ${MAX_CANONICAL_TREE_ENTRIES} entry limit`,
          );
        }
        const child = current.relative ? `${current.relative}/${entry.name}` : entry.name;
        const absolute = resolve(current.directory, entry.name);
        if (!absolute.startsWith(`${root}${sep}`)) {
          throw new Error(`Canonical memory path escapes the memory root: ${child}`);
        }
        const childStat = lstatSync(absolute);
        if (childStat.isSymbolicLink()) {
          throw new Error(`Canonical memory tree contains a symbolic link: ${child}`);
        }
        if (childStat.isDirectory()) {
          const depth = current.depth + 1;
          if (depth > MAX_CANONICAL_TREE_DEPTH) {
            throw new Error(
              `Canonical memory tree exceeds the ${MAX_CANONICAL_TREE_DEPTH} level depth limit`,
            );
          }
          pending.push({
            directory: absolute,
            relative: child,
            depth,
            ignored: current.ignored || entry.name.startsWith('.'),
          });
          continue;
        }
        if (!childStat.isFile()) {
          throw new Error(`Canonical memory tree contains a special file: ${child}`);
        }
        if (current.ignored || entry.name.startsWith('.') || !entry.name.endsWith('.md')) continue;
        if (files.length >= MAX_CANONICAL_MEMORY_FILES) {
          throw new Error(
            `Canonical memory tree exceeds the ${MAX_CANONICAL_MEMORY_FILES} file limit`,
          );
        }
        if (childStat.size > MAX_CANONICAL_MEMORY_BYTES) {
          throw new Error(`Canonical memory must be no larger than 1 MiB: ${child}`);
        }
        totalBytes += childStat.size;
        if (totalBytes > MAX_CANONICAL_TOTAL_BYTES) {
          throw new Error('Canonical memory tree exceeds the 64 MiB aggregate input limit');
        }
        files.push({ file: absolute, path: child });
      }
    } finally {
      directory.closeSync();
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export function executeReplayEvaluation(
  options: ExecuteReplayEvaluationOptions,
): ReplayEvaluationReport {
  const manifest = parseManifest(options.manifestPath);
  const files = scanCanonicalTree(options.memoryDir);
  const candidates = files.map(({ file, path }) => {
    const parsed = parseMemoryFile(readFileSync(file, 'utf8'), path);
    return { memory: parsed.memory, claim: parsed.claim };
  });
  const corpus: ReplayCorpusInput = {
    version: 'nacre.replay-corpus.v1',
    id: manifest.id,
    thresholds: manifest.thresholds,
    probes: manifest.probes.map((probe) => ({
      id: probe.id,
      candidateSet: 'complete_canonical',
      receipt: admitWorkingMemory(candidates, {
        kind: 'brief',
        evaluatedAt: probe.evaluatedAt,
        policy: probe.policy,
      }),
      expectedRelevantMemoryIds: probe.expectedRelevantMemoryIds,
      forbiddenMemoryIds: probe.forbiddenMemoryIds,
    })),
  };
  return evaluateReplayCorpus(corpus);
}

const replay = defineCommand({
  meta: {
    name: 'replay',
    description: 'Evaluate deterministic working-memory replay probes against canonical memory',
  },
  args: {
    manifest: {
      type: 'positional',
      description: 'Replay corpus manifest JSON',
      required: true,
    },
    'memory-dir': {
      type: 'string',
      description: 'Canonical memory root',
      required: true,
    },
    format: {
      type: 'string',
      description: 'Output format: text or json',
      default: 'text',
    },
  },
  run({ args }) {
    const format = args.format as string;
    if (format !== 'text' && format !== 'json') throw new Error(`Invalid format: ${format}`);
    const report = executeReplayEvaluation({
      manifestPath: args.manifest as string,
      memoryDir: args['memory-dir'] as string,
    });
    if (format === 'json') console.log(formatJSON(report));
    else {
      console.log(
        `${report.passed ? 'PASS' : 'FAIL'} ${report.summary.passedProbes}/${report.summary.probeCount} probes; ` +
          `${report.summary.totalForbiddenLeakage} forbidden leaks; ${report.summary.totalContextTokens} context tokens`,
      );
    }
    if (!report.passed) process.exitCode = 1;
  },
});

export default defineCommand({
  meta: { name: 'evaluate', description: 'Run deterministic memory quality evaluations' },
  subCommands: { replay },
});
