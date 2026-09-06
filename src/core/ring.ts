// Fixed-capacity ring of timestamped items (§13). Pure.

/**
 * Items are kept in insertion order; when full, the oldest is overwritten.
 * `at(item)` returns the item's timestamp (any unit, usually monotonic ms).
 * `since` scans every item (order need not be monotonic); `evictBefore` pops from
 * the oldest end and stops at the first item that is not older, so it assumes
 * roughly time-ordered insertion.
 */
export class RingBuffer<T> {
  private readonly buf: (T | undefined)[];
  private start = 0;
  private count = 0;

  constructor(readonly capacity: number, private readonly at: (item: T) => number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new RangeError(`RingBuffer capacity must be a positive integer, got ${capacity}`);
    }
    this.buf = new Array<T | undefined>(capacity);
  }

  get size(): number {
    return this.count;
  }

  push(item: T): void {
    if (this.count < this.capacity) {
      this.buf[(this.start + this.count) % this.capacity] = item;
      this.count++;
    } else {
      this.buf[this.start] = item;
      this.start = (this.start + 1) % this.capacity;
    }
  }

  /** i-th oldest item (0 = oldest). */
  get(i: number): T | undefined {
    if (i < 0 || i >= this.count) return undefined;
    return this.buf[(this.start + i) % this.capacity];
  }

  oldest(): T | undefined {
    return this.get(0);
  }

  newest(): T | undefined {
    return this.get(this.count - 1);
  }

  /** All items, oldest → newest. */
  toArray(): T[] {
    const out: T[] = [];
    for (let i = 0; i < this.count; i++) out.push(this.get(i) as T);
    return out;
  }

  /** The last n items (fewer if the ring holds fewer), oldest → newest. */
  last(n: number): T[] {
    const k = Math.max(0, Math.min(Math.floor(n), this.count));
    const out: T[] = [];
    for (let i = this.count - k; i < this.count; i++) out.push(this.get(i) as T);
    return out;
  }

  /** Items with at(item) ≥ ms, oldest → newest. */
  since(ms: number): T[] {
    const out: T[] = [];
    for (let i = 0; i < this.count; i++) {
      const item = this.get(i) as T;
      if (this.at(item) >= ms) out.push(item);
    }
    return out;
  }

  /** Drop items with at(item) < ms from the oldest end; returns how many were removed. */
  evictBefore(ms: number): number {
    let removed = 0;
    while (this.count > 0) {
      const oldest = this.buf[this.start] as T;
      if (this.at(oldest) >= ms) break;
      this.buf[this.start] = undefined;
      this.start = (this.start + 1) % this.capacity;
      this.count--;
      removed++;
    }
    return removed;
  }

  clear(): void {
    this.buf.fill(undefined);
    this.start = 0;
    this.count = 0;
  }
}
