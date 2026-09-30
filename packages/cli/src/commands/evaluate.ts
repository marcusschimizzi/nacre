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
import recall from './evaluate-recall.js';
import {
  assertCanonicalTreeUnchanged,
  MAX_CANONICAL_MEMORY_BYTES,
  readRegularFileBounded,
  scanCanonicalTree,
} from './evaluation-input.js';

const MANIFEST_VERSION = 'nacre.replay-manifest.v1' as const;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;

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
const REPLAY_CLI_OPTIONS = new Set(['memory-dir', 'format']);

function rejectUnknownReplayOptions(rawArgs: string[]): void {
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
    if (!REPLAY_CLI_OPTIONS.has(name)) throw new Error(`Unknown option: --${name}`);
    if (!value.includes('=')) index += 1;
  }
}

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
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      readRegularFileBounded(path, MAX_MANIFEST_BYTES, 'Replay manifest (4 MiB limit)').toString(
        'utf8',
      ),
    );
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

export function executeReplayEvaluation(
  options: ExecuteReplayEvaluationOptions,
): ReplayEvaluationReport {
  const manifest = parseManifest(options.manifestPath);
  const files = scanCanonicalTree(options.memoryDir);
  const candidates = files.map(({ file, path, identity }) => {
    const parsed = parseMemoryFile(
      readRegularFileBounded(
        file,
        MAX_CANONICAL_MEMORY_BYTES,
        `Canonical memory ${path}`,
        identity,
      ).toString('utf8'),
      path,
    );
    return { memory: parsed.memory, claim: parsed.claim };
  });
  assertCanonicalTreeUnchanged(options.memoryDir, files);
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
  const report = evaluateReplayCorpus(corpus);
  assertCanonicalTreeUnchanged(options.memoryDir, files);
  return report;
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
  run({ args, rawArgs }) {
    rejectUnknownReplayOptions(rawArgs);
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
  subCommands: { replay, recall },
});
