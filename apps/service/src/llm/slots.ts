// A counting semaphore per provider. The queue limits tasks per role pool, but several pools share one provider and a
// task can call roles on other providers, so the provider's limit has to be enforced where the call starts.

export class ProviderSlots {
  private active = new Map<string, number>();
  private waiting = new Map<string, Array<() => void>>();

  constructor(private limitOf: (provider: string) => number) {}

  /** Resolves with a release function once the provider has a free slot. Rejects with the signal's reason when it aborts first. */
  acquire(provider: string, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    const queue = this.waiting.get(provider) ?? [];
    this.waiting.set(provider, queue);
    if (!queue.length && this.hasRoom(provider)) return Promise.resolve(this.take(provider));
    return new Promise((resolve, reject) => {
      const grant = () => {
        signal?.removeEventListener('abort', onAbort);
        resolve(this.take(provider));
      };
      const onAbort = () => {
        const i = queue.indexOf(grant);
        if (i >= 0) queue.splice(i, 1);
        reject(abortReason(signal!));
      };
      queue.push(grant);
      signal?.addEventListener('abort', onAbort, { once: true });
      // A limit raised since the last release may leave room already.
      this.pump(provider);
    });
  }

  private hasRoom(provider: string) {
    return (this.active.get(provider) ?? 0) < this.limitOf(provider);
  }

  private take(provider: string): () => void {
    this.active.set(provider, (this.active.get(provider) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active.set(provider, (this.active.get(provider) ?? 1) - 1);
      this.pump(provider);
    };
  }

  /** Starts waiting calls, oldest first, while there is room. */
  private pump(provider: string) {
    const queue = this.waiting.get(provider);
    while (queue?.length && this.hasRoom(provider)) queue.shift()!();
  }
}

const abortReason = (signal: AbortSignal): unknown => signal.reason ?? new DOMException('Aborted', 'AbortError');
