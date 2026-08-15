import type {
  SOGLoadDiagnostics,
  SOGLoadStage,
  SOGStageTiming,
} from './types.js';

const now = (): number => globalThis.performance?.now() ?? Date.now();

export class LoadDiagnosticsBuilder {
  readonly url: string;
  readonly stages: Partial<Record<SOGLoadStage, SOGStageTiming>> = {};
  downloadedBytes = 0;
  archiveEntries = 0;
  decodedImages = 0;
  splatCount = 0;
  retainedTemporaryBytes = 0;
  failedStage?: SOGLoadStage;
  #activeStage: SOGLoadStage | undefined;

  constructor(url: string) {
    this.url = url;
  }

  async measure<T>(stage: SOGLoadStage, operation: () => T | Promise<T>): Promise<T> {
    const startedAt = now();
    this.#activeStage = stage;
    try {
      return await operation();
    } catch (error) {
      this.failedStage = stage;
      throw error;
    } finally {
      const previous = this.stages[stage];
      this.stages[stage] = {
        startedAt: previous?.startedAt ?? startedAt,
        durationMs: (previous?.durationMs ?? 0) + now() - startedAt,
      };
      this.#activeStage = undefined;
    }
  }

  failCurrent(): void {
    if (this.#activeStage !== undefined) this.failedStage = this.#activeStage;
  }

  snapshot(): SOGLoadDiagnostics {
    return Object.freeze({
      url: this.url,
      stages: Object.freeze({ ...this.stages }),
      downloadedBytes: this.downloadedBytes,
      archiveEntries: this.archiveEntries,
      decodedImages: this.decodedImages,
      splatCount: this.splatCount,
      retainedTemporaryBytes: this.retainedTemporaryBytes,
      ...(this.failedStage === undefined ? {} : { failedStage: this.failedStage }),
    });
  }
}
