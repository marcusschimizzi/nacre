import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import type { DiscoveryResult, FileHash } from '@nacre/core';

export async function hashFile(filePath: string): Promise<string> {
  const content = await readFile(filePath, 'utf8');
  return createHash('sha256').update(content).digest('hex');
}

export function hashFileSync(filePath: string): string {
  const content = readFileSync(filePath, 'utf8');
  return createHash('sha256').update(content).digest('hex');
}

export async function scanDirectories(inputs: string[]): Promise<string[]> {
  const files: string[] = [];

  for (const input of inputs) {
    const absPath = resolve(input);
    let stat;
    try {
      stat = statSync(absPath);
    } catch {
      continue;
    }

    if (stat.isFile() && extname(absPath) === '.md') {
      files.push(absPath);
    } else if (stat.isDirectory()) {
      const entries = readdirSync(absPath, { recursive: true }) as string[];
      for (const entry of entries) {
        const full = resolve(absPath, entry);
        if (extname(full) === '.md') {
          try {
            if (statSync(full).isFile()) {
              files.push(full);
            }
          } catch {
            // skip inaccessible files
          }
        }
      }
    }
  }

  return files.sort();
}

export async function detectChanges(
  files: string[],
  processedFiles: FileHash[],
): Promise<DiscoveryResult> {
  const hashMap = new Map<string, string>();
  for (const pf of processedFiles) {
    hashMap.set(pf.path, pf.hash);
  }

  const result: DiscoveryResult = {
    newFiles: [],
    changedFiles: [],
    unchangedFiles: [],
  };

  for (const file of files) {
    const currentHash = await hashFile(file);
    const previousHash = hashMap.get(file);

    if (previousHash === undefined) {
      result.newFiles.push(file);
    } else if (previousHash !== currentHash) {
      result.changedFiles.push(file);
    } else {
      result.unchangedFiles.push(file);
    }
  }

  return result;
}
