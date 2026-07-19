/**
 * A single-consumer async FIFO queue: producers `push` items (and eventually `close`), a consumer
 * pulls them via `for await...of`. Bridges the reply-text stream (producer, pushing completed
 * sentences) and the TTS pipeline (consumer, synthesizing them one at a time in order) without the
 * consumer having to poll or the producer having to wait for consumption.
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(item: T): void {
    if (this.closed) throw new Error("Cannot push to a closed AsyncQueue");
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.items.push(item);
  }

  /** Signals no more items will be pushed; already-queued items are still yielded first. */
  close(): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  }

  private next(): Promise<IteratorResult<T>> {
    const item = this.items.shift();
    if (item !== undefined) return Promise.resolve({ value: item, done: false });
    if (this.closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return { next: () => this.next() };
  }
}
