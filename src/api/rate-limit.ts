/**
 * A process-wide sliding-window counter, in memory. Slice 1 runs one `api` instance, so this is
 * enough; a restart resets it. Used for OAuth registration and wrong consent passwords (spec §9.3).
 */
export class SlidingWindowLimiter {
  private hits: number[] = [];

  constructor(
    readonly limit: number,
    readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Claims a slot now, in one synchronous step: 0 when the hit was recorded, else the milliseconds
   * until one is allowed (nothing recorded). Claim before any `await`, so concurrent requests can't
   * all see the same free slot.
   */
  tryHit(): number {
    const t = this.now();
    while (this.hits.length > 0 && (this.hits[0] ?? 0) <= t - this.windowMs) this.hits.shift();
    if (this.hits.length >= this.limit) return (this.hits[0] ?? t) + this.windowMs - t;
    this.hits.push(t);
    return 0;
  }

  /** Gives back one claimed slot (the attempt turned out fine, e.g. the right password). */
  refund(): void {
    this.hits.pop();
  }
}
