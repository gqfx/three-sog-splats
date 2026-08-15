export type Cleanup = () => void | Promise<void>;

export class CleanupStack {
  readonly #entries: Cleanup[] = [];
  #released = false;

  defer(cleanup: Cleanup): void {
    if (this.#released) throw new Error('CleanupStack has already been released.');
    this.#entries.push(cleanup);
  }

  release(): void {
    this.#released = true;
    this.#entries.length = 0;
  }

  async dispose(): Promise<void> {
    if (this.#released) return;
    this.#released = true;
    const errors: unknown[] = [];
    for (let index = this.#entries.length - 1; index >= 0; index -= 1) {
      try {
        await this.#entries[index]?.();
      } catch (error) {
        errors.push(error);
      }
    }
    this.#entries.length = 0;
    if (errors.length > 0) throw new AggregateError(errors, 'SOG cleanup failed.');
  }
}
