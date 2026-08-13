import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
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
import { hostname } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  ensureCandidateDurableRoot,
  writeDurableMemoryCandidate,
} from './memory-candidate-durable.js';
import { validateMemoryCandidate, type MemoryCandidate } from './memory-candidate.js';
import { parseMemoryFile } from './memory-file.js';
import type { SqliteStore } from './store.js';

export type MemoryResolutionFailurePoint =
  | 'after_intent'
  | 'after_file_1'
  | 'after_file_2'
  | 'after_candidate_sidecars'
  | 'after_database';

export interface MemoryResolutionWrite {
  path: string;
  content: string;
}

interface ResolutionIntent {
  version: 1;
  id: string;
  files: MemoryResolutionWrite[];
  candidates: MemoryCandidate[];
}

function syncDir(path: string): void {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function resolverLockIsStale(lockPath: string): boolean {
  const ownerPath = join(lockPath, 'owner.json');
  const stat = lstatSync(ownerPath, { throwIfNoEntry: false });
  if (!stat || stat.isSymbolicLink() || !stat.isFile()) return false;
  try {
    const owner = JSON.parse(readFileSync(ownerPath, 'utf8')) as {
      pid?: unknown;
      hostname?: unknown;
    };
    if (
      owner.hostname !== hostname() ||
      typeof owner.pid !== 'number' ||
      !Number.isSafeInteger(owner.pid) ||
      owner.pid <= 0
    ) {
      return false;
    }
    try {
      process.kill(owner.pid, 0);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ESRCH';
    }
  } catch {
    return false;
  }
}

export function withMemoryResolutionLock<T>(memoryDir: string, operation: () => T): T {
  const lockPath = join(ensureCandidateDurableRoot(memoryDir, true), 'resolution.lock');
  try {
    mkdirSync(lockPath, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !resolverLockIsStale(lockPath)) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error(
          `Memory resolver lock is already held; resolution in progress: ${lockPath}`,
        );
      }
      throw error;
    }
    rmSync(lockPath, { recursive: true, force: true });
    mkdirSync(lockPath, { mode: 0o700 });
  }
  try {
    writeFileSync(
      join(lockPath, 'owner.json'),
      `${JSON.stringify({ pid: process.pid, hostname: hostname() })}\n`,
      { encoding: 'utf8', flag: 'wx', mode: 0o600 },
    );
  } catch (error) {
    rmSync(lockPath, { recursive: true, force: true });
    throw error;
  }
  try {
    return operation();
  } finally {
    rmSync(lockPath, { recursive: true, force: true });
  }
}

function transactionDir(memoryDir: string): string {
  const root = ensureCandidateDurableRoot(memoryDir, true);
  const path = join(root, 'transactions');
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat?.isSymbolicLink() || (stat && !stat.isDirectory())) {
    throw new Error(`Resolution transaction root must be a real directory: ${path}`);
  }
  if (!stat) {
    mkdirSync(path, { mode: 0o700 });
    syncDir(root);
  }
  chmodSync(path, 0o700);
  return path;
}

function validateConfinedDestination(memoryDir: string, relPath: string): void {
  const root = resolve(memoryDir);
  const destination = resolve(root, relPath);
  const rel = relative(root, destination);
  if (!rel || rel.startsWith('..') || destination !== resolve(root, rel)) {
    throw new Error(`Resolution path escapes memory root: ${relPath}`);
  }
  let current = root;
  for (const part of relative(root, dirname(destination)).split(/[/\\]/).filter(Boolean)) {
    current = join(current, part);
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink() || (stat && !stat.isDirectory())) {
      throw new Error(`Canonical ancestor must be a real directory: ${current}`);
    }
  }
}

function confinedDestination(memoryDir: string, relPath: string): string {
  validateConfinedDestination(memoryDir, relPath);
  const root = resolve(memoryDir);
  const destination = resolve(root, relPath);
  let current = root;
  for (const part of relative(root, dirname(destination)).split(/[/\\]/).filter(Boolean)) {
    current = join(current, part);
    if (!lstatSync(current, { throwIfNoEntry: false })) mkdirSync(current, { mode: 0o700 });
  }
  return destination;
}

function atomicWrite(memoryDir: string, write: MemoryResolutionWrite): void {
  parseMemoryFile(write.content, write.path);
  const destination = confinedDestination(memoryDir, write.path);
  const temporary = join(dirname(destination), `.resolution-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, write.content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    const fd = openSync(temporary, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, destination);
    chmodSync(destination, 0o600);
    syncDir(dirname(destination));
  } finally {
    rmSync(temporary, { force: true });
  }
}

function parseIntent(path: string): ResolutionIntent {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile())
    throw new Error(`Resolution intent must be a regular file: ${path}`);
  const value = JSON.parse(readFileSync(path, 'utf8')) as ResolutionIntent;
  if (
    value.version !== 1 ||
    typeof value.id !== 'string' ||
    !Array.isArray(value.files) ||
    !Array.isArray(value.candidates)
  ) {
    throw new Error(`Malformed resolution intent: ${path}`);
  }
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.id) ||
    basename(path) !== `${value.id}.json`
  ) {
    throw new Error(`Malformed resolution intent identity: ${path}`);
  }
  if (value.files.length < 1 || value.files.length > 2 || value.candidates.length < 1) {
    throw new Error(`Malformed resolution intent cardinality: ${path}`);
  }
  if (new Set(value.files.map((write) => write?.path)).size !== value.files.length) {
    throw new Error(`Duplicate resolution write path: ${path}`);
  }
  const parsedFiles = value.files.map((write) => {
    if (!write || typeof write.path !== 'string' || typeof write.content !== 'string')
      throw new Error(`Malformed resolution write: ${path}`);
    return { write, parsed: parseMemoryFile(write.content, write.path) };
  });
  value.candidates = value.candidates.map(validateMemoryCandidate);
  if (new Set(value.candidates.map((candidate) => candidate.id)).size !== value.candidates.length) {
    throw new Error(`Duplicate resolution intent candidate: ${path}`);
  }
  for (const candidate of value.candidates) {
    const owners = parsedFiles.filter(
      ({ write, parsed }) =>
        candidate.canonicalPath === write.path &&
        candidate.resolvedMemoryId === parsed.memory.id &&
        (parsed.memory.candidateRecords ?? []).some((record) =>
          isDeepStrictEqual(record, candidate),
        ),
    );
    if (owners.length !== 1) {
      throw new Error(`Resolution intent candidate ownership mismatch: ${candidate.id}`);
    }
  }
  return value;
}

function applyIntent(
  store: SqliteStore,
  memoryDir: string,
  path: string,
  intent: ResolutionIntent,
  failAt?: MemoryResolutionFailurePoint,
): void {
  for (const write of intent.files) validateConfinedDestination(memoryDir, write.path);
  intent.files.forEach((write, index) => {
    atomicWrite(memoryDir, write);
    if (failAt === `after_file_${index + 1}`)
      throw new Error(`Injected resolution failure: ${failAt}`);
  });
  for (const candidate of intent.candidates) writeDurableMemoryCandidate(memoryDir, candidate);
  if (failAt === 'after_candidate_sidecars')
    throw new Error(`Injected resolution failure: ${failAt}`);
  store.immediateTransaction(() => {
    for (const candidate of intent.candidates) {
      if (store.getMemoryCandidate(candidate.id)) store.updateMemoryCandidate(candidate);
      else store.createMemoryCandidate(candidate);
    }
  });
  if (failAt === 'after_database') throw new Error(`Injected resolution failure: ${failAt}`);
  rmSync(path);
  syncDir(dirname(path));
}

function recoverMemoryResolutionTransactionsLocked(store: SqliteStore, memoryDir: string): number {
  const dir = transactionDir(memoryDir);
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort();
  for (const name of files) {
    const path = join(dir, name);
    applyIntent(store, memoryDir, path, parseIntent(path));
  }
  return files.length;
}

export function recoverMemoryResolutionTransactions(
  store: SqliteStore,
  memoryDir: string,
  options: { lockHeld?: boolean } = {},
): number {
  if (options.lockHeld) return recoverMemoryResolutionTransactionsLocked(store, memoryDir);
  return withMemoryResolutionLock(memoryDir, () =>
    recoverMemoryResolutionTransactionsLocked(store, memoryDir),
  );
}

export function commitMemoryResolution(
  store: SqliteStore,
  memoryDir: string,
  files: MemoryResolutionWrite[],
  candidates: MemoryCandidate[],
  failAt?: MemoryResolutionFailurePoint,
  options: { lockHeld?: boolean } = {},
): void {
  if (!options.lockHeld) {
    withMemoryResolutionLock(memoryDir, () =>
      commitMemoryResolution(store, memoryDir, files, candidates, failAt, { lockHeld: true }),
    );
    return;
  }
  recoverMemoryResolutionTransactionsLocked(store, memoryDir);
  const dir = transactionDir(memoryDir);
  const intent: ResolutionIntent = {
    version: 1,
    id: randomUUID(),
    files: [...files].sort((a, b) => a.path.localeCompare(b.path)),
    candidates: [...candidates]
      .map(validateMemoryCandidate)
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
  const path = join(dir, `${intent.id}.json`);
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(intent)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  const fd = openSync(temporary, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
  syncDir(dir);
  if (failAt === 'after_intent') throw new Error(`Injected resolution failure: ${failAt}`);
  applyIntent(store, memoryDir, path, intent, failAt);
}
