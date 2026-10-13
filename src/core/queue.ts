/** Single-consumer async queue with a bounded backlog and clean teardown. */
export class AsyncQueue<T> {
  private items: T[] = [];
  private waiter: ((v: IteratorResult<T>) => void) | null = null;
  private closed = false;

  push(item: T) {
    if (this.closed) return;
    const w = this.waiter;
    if (w) {
      this.waiter = null;
      w({ value: item, done: false });
    } else {
      this.items.push(item);
    }
  }

  close() {
    this.closed = true;
    const w = this.waiter;
    if (w) {
      this.waiter = null;
      w({ value: undefined as never, done: true });
    }
  }

  get size(): number {
    return this.items.length;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        const item = this.items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise<IteratorResult<T>>((resolve) => {
          this.waiter = resolve;
        });
      },
      // A consumer leaving early (for-await calls .return() on break/return)
      // must NOT close the queue: the queue is shared across turns, and only
      // the reader loop may close it when the underlying stream truly ends.
      return: (): Promise<IteratorResult<T>> => {
        this.waiter = null;
        return Promise.resolve({ value: undefined as never, done: true });
      },
    };
  }
}

/**
 * Coalesce a firehose of text deltas into readable chunks.
 *
 * `onFlush` is called for timed flushes so nothing is dropped: a turn that
 * stays open past `flushMs` must still emit its text, not discard it.
 */
export class DeltaCoalescer {
  private buf = "";
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly flushMs = 40,
    private readonly onFlush?: (text: string) => void,
  ) {}

  push(text: string) {
    this.buf += text;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const out = this.take();
      if (out) this.onFlush?.(out);
    }, this.flushMs);
    this.timer.unref?.();
  }

  /** Synchronous flush; returns the buffered text for the caller to emit. */
  flush(): string {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    return this.take();
  }

  private take(): string {
    const out = this.buf;
    this.buf = "";
    return out;
  }
}
/**
 * Wrap a normalized event so it can travel through a queue that otherwise
 * carries raw CLI records. Adapters detect the marker and emit it directly.
 */
export function normalized<T>(event: T): { __normalized: T } {
  return { __normalized: event };
}

export function asNormalized<T>(value: unknown): T | null {
  if (value && typeof value === "object" && "__normalized" in (value as object)) {
    return (value as { __normalized: T }).__normalized;
  }
  return null;
}
