import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';

export type OpenClawFileKind =
  | 'primary'
  | 'reset'
  | 'deleted'
  | 'backup'
  | 'checkpoint'
  | 'trajectory'
  | 'codex-app-server';

export interface InventoryFile {
  path: string;
  /** Bounded source bytes retained so a selected file is not read a second time. */
  content: string;
  digest: string;
  kind: OpenClawFileKind;
  messageCount: number;
  reason: string;
}

export interface InventorySession {
  sessionId: string;
  selected: InventoryFile;
  excluded: InventoryFile[];
}

export interface OpenClawInventoryOptions {
  recursive?: boolean;
  forensic?: boolean;
  limits?: Partial<OpenClawArchiveLimits>;
}

export interface OpenClawArchiveLimits {
  maxTraversalDepth: number;
  maxFiles: number;
  maxAggregateBytes: number;
  maxFileBytes: number;
  maxLineBytes: number;
  maxRecords: number;
}

export const DEFAULT_OPENCLAW_ARCHIVE_LIMITS: Readonly<OpenClawArchiveLimits> = {
  maxTraversalDepth: 16,
  maxFiles: 10_000,
  maxAggregateBytes: 1024 * 1024 * 1024,
  maxFileBytes: 64 * 1024 * 1024,
  maxLineBytes: 4 * 1024 * 1024,
  maxRecords: 1_000_000,
};

export interface OpenClawInventory {
  sessions: InventorySession[];
  selectedFiles: string[];
  excludedFiles: InventoryFile[];
  duplicateGroups: string[][];
  warnings: string[];
}

interface LimitState {
  files: number;
  aggregateBytes: number;
  records: number;
}

function filesUnder(
  path: string,
  recursive: boolean,
  limits: OpenClawArchiveLimits,
  state: LimitState,
  depth = 0,
): string[] {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error(`OpenClaw inventory rejects symlink source: ${path}`);
  if (!stat.isDirectory()) {
    if (!stat.isFile()) return [];
    state.files++;
    if (state.files > limits.maxFiles)
      throw new Error('OpenClaw archive file count limit exceeded');
    if (stat.size > limits.maxFileBytes) {
      throw new Error(`OpenClaw archive per-file bytes limit exceeded: ${path}`);
    }
    state.aggregateBytes += stat.size;
    if (state.aggregateBytes > limits.maxAggregateBytes) {
      throw new Error('OpenClaw archive aggregate bytes limit exceeded');
    }
    return [path];
  }
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = join(path, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`OpenClaw inventory rejects symlink source: ${child}`);
    }
    if (entry.isDirectory()) {
      if (!recursive) return [];
      if (depth + 1 > limits.maxTraversalDepth) {
        throw new Error(`OpenClaw archive traversal depth limit exceeded: ${child}`);
      }
      return filesUnder(child, true, limits, state, depth + 1);
    }
    return entry.isFile() ? filesUnder(child, recursive, limits, state, depth) : [];
  });
}

function kindOf(path: string): OpenClawFileKind {
  const lower = basename(path).toLowerCase();
  if (/\.trajectory\.jsonl(?:\.|$)/.test(lower)) return 'trajectory';
  if (/\.jsonl\.reset(?:\.|$)/.test(lower)) return 'reset';
  if (/\.jsonl\.deleted(?:\.|$)/.test(lower)) return 'deleted';
  if (/\.jsonl\.(?:bak|backup)(?:\.|$)/.test(lower)) return 'backup';
  if (/(?:\.checkpoint\.jsonl|\.jsonl\.checkpoint)(?:\.|$)/.test(lower)) return 'checkpoint';
  if (/^codex-app-server(?:[._-].*)?\.jsonl$/.test(lower)) return 'codex-app-server';
  return 'primary';
}

function inspect(
  path: string,
  warnings: string[],
  limits: OpenClawArchiveLimits,
  state: LimitState,
): (InventoryFile & { sessionId: string }) | undefined {
  if (basename(path) === 'sessions.json' || !path.toLowerCase().includes('.jsonl'))
    return undefined;
  const content = readFileSync(path, 'utf8');
  const records: Array<Record<string, unknown>> = [];
  for (const [index, line] of content.split('\n').entries()) {
    if (!line.trim()) continue;
    if (Buffer.byteLength(line) > limits.maxLineBytes) {
      throw new Error(`OpenClaw archive line bytes limit exceeded: ${path}:${index + 1}`);
    }
    state.records++;
    if (state.records > limits.maxRecords) {
      throw new Error(`OpenClaw archive record count limit exceeded: ${path}:${index + 1}`);
    }
    try {
      const parsed = JSON.parse(line) as unknown;
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        warnings.push(`${path}:${index + 1}: JSONL record must be an object`);
        continue;
      }
      records.push(parsed as Record<string, unknown>);
    } catch {
      warnings.push(`${path}:${index + 1}: malformed JSONL record`);
    }
  }
  const session = records.find(
    (record) => record.type === 'session' && typeof record.id === 'string' && record.id.length > 0,
  );
  if (typeof session?.id !== 'string') {
    warnings.push(`${path}: no valid OpenClaw session header; file excluded`);
    return undefined;
  }
  const kind = kindOf(path);
  return {
    path,
    content,
    digest: createHash('sha256').update(content).digest('hex'),
    kind,
    messageCount: records.filter((record) => record.type === 'message').length,
    reason:
      kind === 'primary' ? 'canonical primary candidate' : `${kind} alternate excluded by default`,
    sessionId: session.id,
  };
}

export function inventoryOpenClawSessions(
  path: string,
  options: OpenClawInventoryOptions = {},
): OpenClawInventory {
  const warnings: string[] = [];
  const limits = { ...DEFAULT_OPENCLAW_ARCHIVE_LIMITS, ...options.limits };
  const state: LimitState = { files: 0, aggregateBytes: 0, records: 0 };
  const inspectedFiles = filesUnder(path, options.recursive ?? false, limits, state)
    .sort()
    .flatMap((file) => {
      const inspected = inspect(file, warnings, limits, state);
      return inspected ? [inspected] : [];
    });
  const grouped = new Map<string, Array<InventoryFile & { sessionId: string }>>();
  for (const inspected of inspectedFiles) {
    const group = grouped.get(inspected.sessionId) ?? [];
    group.push(inspected);
    grouped.set(inspected.sessionId, group);
  }

  const sessions: InventorySession[] = [];
  const policyExcluded: InventoryFile[] = [];
  for (const [sessionId, files] of [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const candidates = options.forensic ? files : files.filter((file) => file.kind === 'primary');
    if (candidates.length === 0) {
      policyExcluded.push(
        ...files.map((file) => ({
          ...file,
          reason: `${file.kind} alternate excluded because no primary exists (use forensic override to select)`,
        })),
      );
      continue;
    }
    const orderedCandidates = [...candidates].sort(
      (a, b) => b.messageCount - a.messageCount || a.path.localeCompare(b.path),
    );
    const selected = {
      ...orderedCandidates[0],
      reason: options.forensic
        ? 'selected by explicit forensic override'
        : 'selected as most complete valid primary',
    };
    const excluded = files
      .filter((file) => file.path !== selected.path)
      .map((file) => ({
        ...file,
        reason:
          file.digest === selected.digest
            ? 'byte-identical duplicate of selected source'
            : `${file.kind} alternate excluded by canonical policy`,
      }));
    sessions.push({ sessionId, selected, excluded });
  }

  const byDigest = new Map<string, string[]>();
  for (const file of inspectedFiles) {
    const paths = byDigest.get(file.digest) ?? [];
    paths.push(file.path);
    byDigest.set(file.digest, paths);
  }
  const excludedFiles = [...sessions.flatMap((session) => session.excluded), ...policyExcluded];
  return {
    sessions,
    selectedFiles: sessions.map((session) => session.selected.path),
    excludedFiles,
    duplicateGroups: [...byDigest.values()].filter((paths) => paths.length > 1),
    warnings,
  };
}
