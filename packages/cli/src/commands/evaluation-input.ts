import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  readSync,
  writeSync,
} from 'node:fs';
import { resolve, sep } from 'node:path';

export const MAX_CANONICAL_MEMORY_BYTES = 1024 * 1024;
const MAX_CANONICAL_MEMORY_FILES = 10_000;
export const MAX_CANONICAL_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_CANONICAL_TREE_ENTRIES = 20_000;
const MAX_CANONICAL_TREE_DEPTH = 64;

export interface CanonicalInputFile {
  path: string;
  file: string;
  identity: FileIdentity;
}

export interface FileIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

export function readRegularFileBounded(
  source: string,
  maxBytes: number,
  label: string,
  expectedIdentity?: FileIdentity,
): Buffer {
  let fd: number | undefined;
  try {
    fd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(fd);
    if (!before.isFile()) throw new Error(`${label} must be a regular file`);
    if (before.size > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes`);
    if (expectedIdentity && !sameFileIdentity(before, expectedIdentity)) {
      throw new Error(`${label} changed after the canonical tree was scanned`);
    }
    const namedBefore = lstatSync(source);
    if (namedBefore.isSymbolicLink() || !sameFileIdentity(before, namedBefore)) {
      throw new Error(`${label} changed before it was read`);
    }
    const chunks: Buffer[] = [];
    let total = 0;
    const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, maxBytes + 1));
    for (;;) {
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      total += count;
      if (total > maxBytes) throw new Error(`${label} grew beyond ${maxBytes} bytes`);
      chunks.push(Buffer.from(buffer.subarray(0, count)));
    }
    const after = fstatSync(fd);
    const namedAfter = lstatSync(source);
    if (
      !sameFileIdentity(before, after) ||
      namedAfter.isSymbolicLink() ||
      !sameFileIdentity(after, namedAfter) ||
      total !== before.size
    ) {
      throw new Error(`${label} changed while it was read`);
    }
    return Buffer.concat(chunks, total);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function copyRegularFileBounded(
  source: string,
  destination: string,
  maxBytes: number,
  label: string,
  expectedIdentity?: FileIdentity,
): void {
  let sourceFd: number | undefined;
  let destinationFd: number | undefined;
  try {
    sourceFd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(sourceFd);
    if (expectedIdentity && !sameFileIdentity(opened, expectedIdentity)) {
      throw new Error(`${label} changed before it was copied`);
    }
    const namedBefore = lstatSync(source);
    if (namedBefore.isSymbolicLink() || !sameFileIdentity(opened, namedBefore)) {
      throw new Error(`${label} changed before it was copied`);
    }
    const before = fstatSync(sourceFd, { bigint: true });
    if (!before.isFile()) throw new Error(`${label} must be a regular file`);
    if (before.size > BigInt(maxBytes)) throw new Error(`${label} exceeds ${maxBytes} bytes`);
    destinationFd = openSync(
      destination,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let copied = 0n;
    for (;;) {
      const count = readSync(sourceFd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      let written = 0;
      while (written < count) {
        const chunk = writeSync(destinationFd, buffer, written, count - written);
        if (chunk === 0) throw new Error(`${label} copy made no progress`);
        written += chunk;
      }
      copied += BigInt(count);
      if (copied > BigInt(maxBytes)) throw new Error(`${label} grew beyond ${maxBytes} bytes`);
    }
    const after = fstatSync(sourceFd, { bigint: true });
    const openedAfter = fstatSync(sourceFd);
    const namedAfter = lstatSync(source);
    if (
      copied !== before.size ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs ||
      namedAfter.isSymbolicLink() ||
      !sameFileIdentity(openedAfter, namedAfter)
    ) {
      throw new Error(`${label} changed while it was copied`);
    }
  } finally {
    try {
      if (destinationFd !== undefined) closeSync(destinationFd);
    } finally {
      if (sourceFd !== undefined) closeSync(sourceFd);
    }
  }
}

export function scanCanonicalTree(rootInput: string): CanonicalInputFile[] {
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
    const directoryBefore = lstatSync(current.directory);
    if (directoryBefore.isSymbolicLink() || !directoryBefore.isDirectory()) {
      throw new Error(`Canonical memory directory changed during scan: ${current.relative || '.'}`);
    }
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
        files.push({
          file: absolute,
          path: child,
          identity: {
            dev: childStat.dev,
            ino: childStat.ino,
            size: childStat.size,
            mtimeMs: childStat.mtimeMs,
            ctimeMs: childStat.ctimeMs,
          },
        });
      }
    } finally {
      directory.closeSync();
    }
    const directoryAfter = lstatSync(current.directory);
    if (
      directoryAfter.isSymbolicLink() ||
      !directoryAfter.isDirectory() ||
      !sameFileIdentity(directoryBefore, directoryAfter)
    ) {
      throw new Error(`Canonical memory directory changed during scan: ${current.relative || '.'}`);
    }
  }
  const rootAfter = lstatSync(root);
  if (rootAfter.isSymbolicLink() || !sameFileIdentity(rootStat, rootAfter)) {
    throw new Error('Canonical memory root changed during scan');
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export function assertCanonicalTreeUnchanged(
  rootInput: string,
  expectedFiles: CanonicalInputFile[],
): void {
  const currentFiles = scanCanonicalTree(rootInput);
  if (
    currentFiles.length !== expectedFiles.length ||
    currentFiles.some((current, index) => {
      const expected = expectedFiles[index];
      return (
        !expected ||
        current.path !== expected.path ||
        !sameFileIdentity(current.identity, expected.identity)
      );
    })
  ) {
    throw new Error('Canonical memory tree changed after it was scanned');
  }
}
