import type { SOGLoadDiagnostics, SOGLoadStage } from './types.js';

export type SOGErrorCode =
  | 'ABORTED'
  | 'DOWNLOAD_FAILED'
  | 'UNSUPPORTED_SOURCE'
  | 'INVALID_ARCHIVE'
  | 'UNSUPPORTED_ARCHIVE'
  | 'INVALID_METADATA'
  | 'MISSING_ATTRIBUTE'
  | 'IMAGE_DECODE_FAILED'
  | 'IMAGE_DIMENSION_MISMATCH'
  | 'RESOURCE_DISPOSED'
  | 'UNSUPPORTED_RENDERER'
  | 'RENDERER_MISMATCH'
  | 'PREPARATION_FAILED';

export class SOGError extends Error {
  readonly code: SOGErrorCode;
  readonly stage?: SOGLoadStage;
  readonly diagnostics?: SOGLoadDiagnostics;

  constructor(
    code: SOGErrorCode,
    message: string,
    options: ErrorOptions & { stage?: SOGLoadStage; diagnostics?: SOGLoadDiagnostics } = {},
  ) {
    super(message, options);
    this.name = 'SOGError';
    this.code = code;
    if (options.stage !== undefined) this.stage = options.stage;
    if (options.diagnostics !== undefined) this.diagnostics = options.diagnostics;
  }
}

export function abortError(message = 'The SOG operation was aborted.'): SOGError {
  return new SOGError('ABORTED', message);
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

export function isAbortError(error: unknown): boolean {
  return (
    (error instanceof SOGError && error.code === 'ABORTED') ||
    (error instanceof DOMException && error.name === 'AbortError')
  );
}
