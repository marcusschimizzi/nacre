/** Spec §6.2 step 4: the largest piece of a body that goes to the model in one call, in code points. */
export const CHUNK_CHARS = 8000;

export interface Chunk {
  /** Code-point offset of `text` in the full body. */
  start: number;
  text: string;
}

const WHITESPACE = /\s/u;

/**
 * Splits a body into chunks of at most `max` code points, packing whole paragraphs greedily (a
 * paragraph ends at a run of two or more newlines, with spaces or tabs allowed between them). A
 * paragraph longer than `max` is cut after the last whitespace before the limit, or at the limit
 * when it has none. Chunks are contiguous and concatenate to exactly the body, so a chunk offset
 * plus an offset inside the chunk is an offset in the body. Works on code points, so a surrogate
 * pair is never cut. Linear in the body's length.
 */
export function chunkBody(body: string, max = CHUNK_CHARS): Chunk[] {
  const cps = Array.from(body);
  if (cps.length <= max) return [{ start: 0, text: body }];

  // ends[i]: true when a paragraph boundary ends right before code point i.
  const ends = paragraphEnds(cps);
  const chunks: Chunk[] = [];
  let pos = 0;
  while (cps.length - pos > max) {
    const limit = pos + max;
    let cut = -1;
    for (let i = limit; i > pos; i--) {
      if (ends[i]) {
        cut = i;
        break;
      }
    }
    if (cut < 0) {
      for (let i = limit - 1; i > pos; i--) {
        if (WHITESPACE.test(cps[i] ?? '')) {
          cut = i + 1;
          break;
        }
      }
    }
    if (cut < 0) cut = limit;
    chunks.push({ start: pos, text: cps.slice(pos, cut).join('') });
    pos = cut;
  }
  chunks.push({ start: pos, text: cps.slice(pos).join('') });
  return chunks;
}

function paragraphEnds(cps: readonly string[]): boolean[] {
  const ends = new Array<boolean>(cps.length + 1).fill(false);
  let i = 0;
  while (i < cps.length) {
    if (cps[i] !== '\n') {
      i++;
      continue;
    }
    // A run of newlines, spaces and tabs starting at a newline; it is a boundary when it holds two
    // or more newlines, and it ends after its last newline (trailing spaces start the next paragraph).
    let newlines = 0;
    let lastNewline = i;
    let j = i;
    while (j < cps.length && (cps[j] === '\n' || cps[j] === ' ' || cps[j] === '\t')) {
      if (cps[j] === '\n') {
        newlines++;
        lastNewline = j;
      }
      j++;
    }
    if (newlines >= 2) ends[lastNewline + 1] = true;
    i = j;
  }
  return ends;
}
