import {
  chmodSync,
  closeSync,
  constants,
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
  writeSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateMemoryCandidate, type MemoryCandidate } from './memory-candidate.js';

const CANDIDATE_DIR = '.candidates';
const STATE_DIR = 'state';
const JOURNAL_DIR = 'journal';

interface CandidateJournalRecord {
  op: 'upsert';
  candidate: MemoryCandidate;
}

function ensurePrivateDir(path: string, create: boolean): void {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat) {
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Candidate durable state requires a real directory: ${path}`);
    }
    chmodSync(path, 0o700);
    return;
  }
  if (!create) throw new Error(`Candidate durable directory is missing: ${path}`);
  mkdirSync(path, { mode: 0o700 });
}

export function ensureCandidateDurableRoot(memoryDir: string, create = true): string {
  const root = resolve(memoryDir);
  ensurePrivateDir(root, create);
  const candidateRoot = resolve(root, CANDIDATE_DIR);
  const rel = relative(root, candidateRoot);
  if (rel.startsWith('..') || rel === '') {
    throw new Error('Candidate durable path escapes the configured memory root');
  }
  ensurePrivateDir(candidateRoot, create);
  ensurePrivateDir(join(candidateRoot, STATE_DIR), create);
  ensurePrivateDir(join(candidateRoot, JOURNAL_DIR), create);
  return candidateRoot;
}

function statePath(memoryDir: string, id: string): string {
  const root = ensureCandidateDurableRoot(memoryDir, true);
  return join(root, STATE_DIR, `${id}.json`);
}

function journalPath(memoryDir: string, ts: string): string {
  const root = ensureCandidateDurableRoot(memoryDir, true);
  return join(root, JOURNAL_DIR, `${ts.slice(0, 10)}.jsonl`);
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function writeDurableMemoryCandidate(memoryDir: string, candidate: MemoryCandidate): void {
  const value = validateMemoryCandidate(candidate);
  const path = statePath(memoryDir, value.id);
  const existingState = lstatSync(path, { throwIfNoEntry: false });
  if (existingState?.isSymbolicLink() || (existingState && !existingState.isFile())) {
    throw new Error(`Candidate durable state must be a regular file: ${path}`);
  }

  // Open the journal with O_NOFOLLOW before replacing canonical state. This
  // preflight makes a hostile journal path fail without changing either view.
  const journal = journalPath(memoryDir, value.updatedAt);
  const existingJournal = lstatSync(journal, { throwIfNoEntry: false });
  if (existingJournal?.isSymbolicLink() || (existingJournal && !existingJournal.isFile())) {
    throw new Error(`Candidate journal must be a regular file: ${journal}`);
  }
  const journalFd = openSync(
    journal,
    constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );

  const tmp = `${path}.tmp-${randomUUID()}`;
  const body = `${JSON.stringify(value)}\n`;
  try {
    writeFileSync(tmp, body, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    const fd = openSync(tmp, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
    chmodSync(path, 0o600);
    fsyncDirectory(dirname(path));

    writeSync(
      journalFd,
      `${JSON.stringify({ op: 'upsert', candidate: value } satisfies CandidateJournalRecord)}\n`,
    );
    fsyncSync(journalFd);
  } finally {
    rmSync(tmp, { force: true });
    closeSync(journalFd);
  }
  chmodSync(journal, 0o600);
  fsyncDirectory(dirname(journal));
}

function readCandidateStateFile(path: string): MemoryCandidate {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Candidate durable state must be a regular file: ${path}`);
  }
  if ((stat.mode & 0o777) !== 0o600) chmodSync(path, 0o600);
  return validateMemoryCandidate(JSON.parse(readFileSync(path, 'utf8')) as MemoryCandidate);
}

function candidateStateFiles(memoryDir: string): string[] {
  const root = ensureCandidateDurableRoot(memoryDir, false);
  const dir = join(root, STATE_DIR);
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => join(dir, name));
}

function journalFiles(memoryDir: string): string[] {
  const root = ensureCandidateDurableRoot(memoryDir, false);
  const dir = join(root, JOURNAL_DIR);
  return readdirSync(dir)
    .filter((name) => name.endsWith('.jsonl'))
    .sort()
    .map((name) => {
      const path = join(dir, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error(`Candidate journal must be a regular file: ${path}`);
      }
      return path;
    });
}

function newest(a: MemoryCandidate, b: MemoryCandidate): MemoryCandidate {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? a : b;
  return a.lifecycle > b.lifecycle ? a : b;
}

export function readDurableMemoryCandidates(memoryDir: string): {
  candidates: MemoryCandidate[];
  errors: string[];
} {
  if (!existsSync(join(resolve(memoryDir), CANDIDATE_DIR))) {
    return { candidates: [], errors: [] };
  }
  const byId = new Map<string, MemoryCandidate>();
  const errors: string[] = [];

  try {
    for (const file of candidateStateFiles(memoryDir)) {
      try {
        const candidate = readCandidateStateFile(file);
        byId.set(candidate.id, candidate);
      } catch (err) {
        errors.push(`${file}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }

  try {
    for (const file of journalFiles(memoryDir)) {
      const lines = readFileSync(file, 'utf8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        try {
          const record = JSON.parse(line) as CandidateJournalRecord;
          if (record.op !== 'upsert') throw new Error('unsupported journal op');
          const candidate = validateMemoryCandidate(record.candidate);
          const existing = byId.get(candidate.id);
          byId.set(candidate.id, existing ? newest(existing, candidate) : candidate);
        } catch (err) {
          errors.push(`${file}:${i + 1}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }

  return {
    candidates: [...byId.values()].sort(
      (a, b) => a.proposedAt.localeCompare(b.proposedAt) || a.id.localeCompare(b.id),
    ),
    errors,
  };
}

export function isDurablyRejected(memoryDir: string, id: string): boolean {
  const { candidates, errors } = readDurableMemoryCandidates(memoryDir);
  if (errors.length > 0) {
    throw new Error(
      `Candidate durable state is corrupt; refusing lifecycle decision:\n${errors.join('\n')}`,
    );
  }
  return candidates.some((candidate) => candidate.id === id && candidate.lifecycle === 'rejected');
}
