import type { WebGPURenderer } from 'three/webgpu';
import type { RadixBackendKind } from './backend.js';

export type RadixSelectionReason =
  | 'validated-nvidia-subgroups'
  | 'custom-device'
  | 'subgroups-unavailable'
  | 'adapter-unavailable'
  | 'adapter-identity-ambiguous'
  | 'unsupported-vendor'
  | 'subgroup-size-unavailable'
  | 'subgroup-size-incompatible'
  | 'subgroup-size-too-large';

export interface RadixAdapterInfo {
  readonly vendor?: string;
  readonly architecture?: string;
  readonly device?: string;
  readonly description?: string;
  readonly subgroupMinSize?: number;
  readonly subgroupMaxSize?: number;
}

export interface RadixAdmissionSignals {
  readonly hasSubgroups: boolean;
  readonly customDevice: boolean;
  readonly adapterInfo: RadixAdapterInfo | null;
  readonly identityCorrelated: boolean;
}

export interface RadixBackendSelection {
  readonly kind: RadixBackendKind;
  readonly reason: RadixSelectionReason;
  readonly adapterInfo: RadixAdapterInfo | null;
}

/** @internal Deterministic dependency seam for selection-policy tests. */
export interface RadixSelectionTestDependencies {
  readonly hasSubgroups?: (renderer: WebGPURenderer) => boolean;
  readonly hasCustomDevice?: (renderer: WebGPURenderer) => boolean;
  readonly resolveAdapterInfo?: (renderer: WebGPURenderer) => Promise<{
    readonly info: RadixAdapterInfo | null;
    readonly identityCorrelated: boolean;
  }>;
}

interface RendererBackendParameters {
  readonly parameters?: {
    readonly device?: unknown;
    readonly powerPreference?: 'low-power' | 'high-performance';
  };
}

export function evaluateRadixAdmission(signals: RadixAdmissionSignals): RadixBackendSelection {
  const portable = (reason: Exclude<RadixSelectionReason, 'validated-nvidia-subgroups'>): RadixBackendSelection => ({
    kind: 'portable',
    reason,
    adapterInfo: signals.adapterInfo,
  });
  if (signals.customDevice) return portable('custom-device');
  if (!signals.hasSubgroups) return portable('subgroups-unavailable');
  if (!signals.adapterInfo) return portable('adapter-unavailable');
  if (!signals.identityCorrelated) return portable('adapter-identity-ambiguous');
  if (signals.adapterInfo.vendor?.trim().toLowerCase() !== 'nvidia') {
    return portable('unsupported-vendor');
  }
  const subgroupMinSize = signals.adapterInfo.subgroupMinSize;
  const subgroupMaxSize = signals.adapterInfo.subgroupMaxSize;
  if (
    !Number.isFinite(subgroupMinSize)
    || subgroupMinSize === undefined
    || subgroupMinSize <= 0
    || !Number.isFinite(subgroupMaxSize)
    || subgroupMaxSize === undefined
    || subgroupMaxSize <= 0
  ) {
    return portable('subgroup-size-unavailable');
  }
  if (subgroupMinSize > 32 || subgroupMaxSize > 32) return portable('subgroup-size-too-large');
  if (subgroupMinSize !== 32 || subgroupMaxSize !== 32) {
    return portable('subgroup-size-incompatible');
  }
  return {
    kind: 'onesweep',
    reason: 'validated-nvidia-subgroups',
    adapterInfo: signals.adapterInfo,
  };
}

async function resolveDefaultAdapterInfo(renderer: WebGPURenderer): Promise<{
  readonly info: RadixAdapterInfo | null;
  readonly identityCorrelated: boolean;
}> {
  void renderer;
  // WebGPU does not guarantee that a second requestAdapter() call returns the
  // adapter backing Three.js' renderer. Until Three.js exposes correlated
  // adapter information, production selection remains on the portable path.
  return { info: null, identityCorrelated: false };
}

export async function selectRadixBackend(
  renderer: WebGPURenderer,
  dependencies: RadixSelectionTestDependencies = {},
): Promise<RadixBackendSelection> {
  const backend = renderer.backend as RendererBackendParameters;
  const customDevice = dependencies.hasCustomDevice?.(renderer)
    ?? backend.parameters?.device !== undefined;
  const hasSubgroups = dependencies.hasSubgroups?.(renderer)
    ?? renderer.hasFeature('subgroups');
  const adapter = await (dependencies.resolveAdapterInfo?.(renderer)
    ?? resolveDefaultAdapterInfo(renderer));
  return evaluateRadixAdmission({
    hasSubgroups,
    customDevice,
    adapterInfo: adapter.info,
    identityCorrelated: adapter.identityCorrelated,
  });
}
