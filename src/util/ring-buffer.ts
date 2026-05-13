// A bounded ring buffer with monotonic sequence numbers so callers can
// ask for "everything since cursor N" without re-reading what they have.

export interface RingEntry<T> {
  seq: number;
  ts: string;
  value: T;
}

export class RingBuffer<T> {
  private entries: RingEntry<T>[] = [];
  private nextSeq = 1;
  constructor(private readonly capacity = 500) {}

  push(value: T): RingEntry<T> {
    const entry: RingEntry<T> = {
      seq: this.nextSeq++,
      ts: new Date().toISOString(),
      value,
    };
    this.entries.push(entry);
    if (this.entries.length > this.capacity) {
      this.entries.splice(0, this.entries.length - this.capacity);
    }
    return entry;
  }

  /** Return entries after `sinceCursor`, up to `tail` most recent. */
  read(opts: { sinceCursor?: number; tail?: number } = {}): {
    items: RingEntry<T>[];
    cursor: number;
  } {
    const since = opts.sinceCursor ?? 0;
    let items = this.entries.filter((e) => e.seq > since);
    if (opts.tail !== undefined && items.length > opts.tail) {
      items = items.slice(-opts.tail);
    }
    const cursor = items.length > 0 ? items[items.length - 1]!.seq : since;
    return { items, cursor };
  }

  size(): number {
    return this.entries.length;
  }
}
