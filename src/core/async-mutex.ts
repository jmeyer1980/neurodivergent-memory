export class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();

  async runExclusive<T>(operation: () => Promise<T> | T): Promise<T> {
    let release: (() => void) | undefined;
    const waitForTurn = this.tail;

    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });

    await waitForTurn;
    try {
      return await operation();
    } finally {
      release?.();
    }
  }
}
