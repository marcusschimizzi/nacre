import { describe, expect, it } from 'vitest';
import { CHUNK_CHARS, type Chunk, chunkBody } from '../src/worker/chunk.js';

const cpLen = (s: string) => Array.from(s).length;

/** The invariants every chunking must keep. */
function checkInvariants(body: string, chunks: Chunk[], max = CHUNK_CHARS): void {
  expect(chunks.map((c) => c.text).join('')).toBe(body);
  let offset = 0;
  for (const c of chunks) {
    expect(c.start).toBe(offset);
    expect(cpLen(c.text)).toBeLessThanOrEqual(max);
    expect(c.text.isWellFormed()).toBe(true);
    offset += cpLen(c.text);
  }
}

// A small seeded generator for this file only (task 6 owns test/helpers/prng.ts).
function mulberry32(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (max: number) => Math.floor(next() * max),
    pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)] as T,
  };
}

describe('chunkBody', () => {
  it('a body of at most 8,000 code points is one chunk', () => {
    const body = 'a'.repeat(8000);
    expect(chunkBody(body)).toEqual([{ start: 0, text: body }]);
    expect(chunkBody('')).toEqual([{ start: 0, text: '' }]);
    // 8,000 emoji: 16,000 UTF-16 units, still one chunk.
    expect(chunkBody('😀'.repeat(8000))).toHaveLength(1);
  });

  it('8,001 code points split in two', () => {
    const body = `${'word '.repeat(1600)}x`;
    const chunks = chunkBody(body);
    expect(chunks).toHaveLength(2);
    checkInvariants(body, chunks);
  });

  it('packs whole paragraphs greedily and cuts after the paragraph break', () => {
    const p = (n: number, ch: string) => `${ch.repeat(n - 1)}.`;
    const body = `${p(3000, 'a')}\n\n${p(3000, 'b')}\n \t\n${p(3000, 'c')}\n\n\n${p(500, 'd')}`;
    const chunks = chunkBody(body);
    checkInvariants(body, chunks);
    expect(chunks.map((c) => c.text)).toEqual([
      `${p(3000, 'a')}\n\n${p(3000, 'b')}\n \t\n`,
      `${p(3000, 'c')}\n\n\n${p(500, 'd')}`,
    ]);
  });

  it('a single newline is not a paragraph break', () => {
    const body = `${'a'.repeat(5000)}\n${'b'.repeat(5000)}`;
    const chunks = chunkBody(body);
    checkInvariants(body, chunks);
    // The newline is whitespace, so the paragraph is cut after it.
    expect(chunks[0]?.text).toBe(`${'a'.repeat(5000)}\n`);
  });

  it('a 20,000-code-point paragraph with spaces is cut after the last space before the limit', () => {
    const body = 'abcdefghi '.repeat(2000);
    const chunks = chunkBody(body);
    checkInvariants(body, chunks);
    expect(chunks.map((c) => cpLen(c.text))).toEqual([8000, 8000, 4000]);
    for (const c of chunks.slice(0, -1)) expect(c.text.endsWith(' ')).toBe(true);
  });

  it('a 20,000-code-point paragraph without whitespace is cut at the limit', () => {
    const body = 'x'.repeat(20_000);
    expect(chunkBody(body).map((c) => [c.start, cpLen(c.text)])).toEqual([
      [0, 8000],
      [8000, 8000],
      [16_000, 4000],
    ]);
  });

  it('never cuts a surrogate pair, and offsets count code points', () => {
    const body = '😀'.repeat(20_000);
    const chunks = chunkBody(body);
    checkInvariants(body, chunks);
    expect(chunks.map((c) => c.start)).toEqual([0, 8000, 16_000]);
    const mixed = `${'a'.repeat(7999)}😀😀${'b'.repeat(100)}`;
    const m = chunkBody(mixed);
    checkInvariants(mixed, m);
    expect(m[0]?.text.endsWith('😀')).toBe(true);
  });

  it('seeded properties: 2,000 random bodies keep every invariant and chunk deterministically', () => {
    const alphabet = ['a', 'b', 'é', '日', '😀', ' ', '\t', '\n', '\n\n', '\n \n', '.', 'word '];
    for (let seed = 1; seed <= 2000; seed++) {
      const rnd = mulberry32(seed);
      const max = 20 + rnd.int(200);
      const parts: string[] = [];
      const pieces = rnd.int(400);
      for (let i = 0; i < pieces; i++) parts.push(rnd.pick(alphabet));
      const body = parts.join('');
      const chunks = chunkBody(body, max);
      try {
        checkInvariants(body, chunks, max);
        expect(chunkBody(body, max)).toEqual(chunks);
      } catch (err) {
        throw new Error(`seed ${seed}, max ${max}, body ${JSON.stringify(body)}: ${String(err)}`);
      }
    }
  });

  it('a 100,000-code-point adversarial body chunks in under 250 ms', () => {
    const bodies = [
      'x'.repeat(100_000),
      ' '.repeat(100_000),
      '\n '.repeat(50_000),
      '\n\n'.repeat(50_000),
      '😀'.repeat(100_000),
      `${'\n'.repeat(1)}${' \t'.repeat(49_999)}`,
    ];
    for (const body of bodies) {
      const t0 = performance.now();
      const chunks = chunkBody(body);
      const ms = performance.now() - t0;
      checkInvariants(body, chunks);
      expect(ms).toBeLessThan(250);
    }
  });
});
