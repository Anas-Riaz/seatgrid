import { unavailable } from "../errors.js";

interface Waiter {
  start: () => void;
  timer: NodeJS.Timeout;
}

/**
 * A semaphore with a bounded waiting queue (one per database node).
 *
 * At most `maxConcurrent` calls run at once. Extra calls wait in a queue, but if
 * the queue is already `maxQueue` deep, or a call waits longer than `maxWaitMs`,
 * it is rejected with 503 straight away. A hot shard therefore cannot pile up
 * unbounded work, and callers get a fast answer instead of a hung request.
 */
export class Bulkhead {
  private active = 0;
  private readonly queue: Waiter[] = [];

  constructor(
    private readonly name: string,
    private readonly maxConcurrent: number,
    private readonly maxWaitMs: number,
  ) {}

  get stats() {
    return { active: this.active, queued: this.queue.length };
  }

  async run<T>(fn: () => Promise<T>, maxQueue: number): Promise<T> {
    await this.acquire(maxQueue);
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(maxQueue: number): Promise<void> {
    if (this.active < this.maxConcurrent) {
      this.active++;
      return Promise.resolve();
    }
    if (this.queue.length >= maxQueue) {
      return Promise.reject(unavailable(`${this.name} is overloaded, try again shortly`));
    }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        start: () => {
          clearTimeout(waiter.timer);
          this.active++;
          resolve();
        },
        timer: setTimeout(() => {
          this.queue.splice(this.queue.indexOf(waiter), 1);
          reject(unavailable(`${this.name} is busy, try again shortly`));
        }, this.maxWaitMs),
      };
      this.queue.push(waiter);
    });
  }

  private release(): void {
    this.active--;
    this.queue.shift()?.start();
  }
}
