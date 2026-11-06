/**
 * Per-device async mutex: one task at a time on a phone.
 *
 * The proxy task lease (ProxyManager.acquireTaskLease) is re-entrant per device, so it does not
 * stop publish + warmup + stats + login from driving the same screen simultaneously. Handlers take
 * this mutex first, then the lease.
 */

export const DEVICE_BUSY_MESSAGE = 'Телефон занят другой задачей';

export class DeviceBusyError extends Error {
  constructor(readonly deviceId: string) {
    super(DEVICE_BUSY_MESSAGE);
    this.name = 'DeviceBusyError';
  }
}

export class DeviceMutex {
  /** Tail of each device's queue; entries are removed once the queue drains. */
  private tails = new Map<string, Promise<void>>();

  /**
   * Wait for the device to be free (FIFO) and take it. Throws DeviceBusyError if it is not free
   * within `waitMs`. The returned release function is idempotent — call it in `finally`.
   */
  async acquire(deviceId: string, waitMs = 120_000): Promise<() => void> {
    const prev = this.tails.get(deviceId) ?? Promise.resolve();
    let releaseFn!: () => void;
    const mine = new Promise<void>((resolve) => { releaseFn = resolve; });
    const tail = prev.then(() => mine);
    this.tails.set(deviceId, tail);
    void tail.then(() => {
      if (this.tails.get(deviceId) === tail) this.tails.delete(deviceId);
    });

    let timer: NodeJS.Timeout | undefined;
    const timedOut = await Promise.race([
      prev.then(() => false),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(true), waitMs); }),
    ]);
    clearTimeout(timer);
    if (timedOut) {
      // Give the slot up so the queue behind us keeps moving once the current holder finishes.
      releaseFn();
      throw new DeviceBusyError(deviceId);
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseFn();
    };
  }

  /** True while a task holds (or waits for) the device. */
  isBusy(deviceId: string): boolean {
    return this.tails.has(deviceId);
  }
}

export const deviceMutex = new DeviceMutex();
