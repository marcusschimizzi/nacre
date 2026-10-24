/**
 * A small seeded generator (mulberry32) for property tests: the same seed gives the same cases on
 * every run and every machine, so a failure is reproducible from its seed and case index. Never
 * `Math.random` or the clock.
 */
export interface Prng {
  /** A float in [0, 1). */
  next(): number;
  /** An integer in [0, max). */
  int(max: number): number;
  pick<T>(xs: readonly T[]): T;
  chance(p: number): boolean;
}

export function prng(seed: number): Prng {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  const int = (max: number) => Math.floor(next() * max);
  return {
    next,
    int,
    pick<T>(xs: readonly T[]): T {
      if (xs.length === 0) throw new Error('pick from an empty list');
      return xs[int(xs.length)] as T;
    },
    chance: (p: number) => next() < p,
  };
}
