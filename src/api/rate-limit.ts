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

  private prune(t: number): void {
    while (this.hits.length > 0 && (this.hits[0] ?? 0) <= t - this.windowMs) this.hits.shift();
  }

  /** Milliseconds until another hit is allowed; 0 when it is allowed now. */
  retryAfterMs(): number {
    const t = this.now();
    this.prune(t);
    if (this.hits.length < this.limit) return 0;
    return (this.hits[0] ?? t) + this.windowMs - t;
  }

  hit(): void {
    const t = this.now();
    this.prune(t);
    this.hits.push(t);
  }
}
