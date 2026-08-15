import { SOGError } from '../core/errors.js';
import type {
  SOGAttributeName,
  SOGBounds,
  SOGMetaV2,
  SOGNativeImage,
  SOGVec3,
} from '../core/types.js';
import type { ZipEntry } from './zip.js';

type JsonRecord = Record<string, unknown>;

const attributeFiles = [
  ['means_l', 'means', 0],
  ['means_u', 'means', 1],
  ['scales', 'scales', 0],
  ['quats', 'quats', 0],
  ['sh0', 'sh0', 0],
] as const;

function invalid(message: string): never {
  throw new SOGError('INVALID_METADATA', `Invalid SOG v2 metadata: ${message}`, {
    stage: 'validation',
  });
}

function record(value: unknown, path: string): JsonRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid(`${path} must be an object.`);
  return value as JsonRecord;
}

function finiteNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) invalid(`${path} must be a finite number.`);
  return value;
}

function vec3(value: unknown, path: string): [number, number, number] {
  if (!Array.isArray(value) || value.length !== 3) invalid(`${path} must contain exactly three numbers.`);
  return [
    finiteNumber(value[0], `${path}[0]`),
    finiteNumber(value[1], `${path}[1]`),
    finiteNumber(value[2], `${path}[2]`),
  ];
}

function files(value: unknown, path: string, length: number): string[] {
  if (!Array.isArray(value) || value.length !== length || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    invalid(`${path} must contain exactly ${length} non-empty filename${length === 1 ? '' : 's'}.`);
  }
  return value as string[];
}

function codebook(value: unknown, path: string): number[] {
  if (!Array.isArray(value) || value.length !== 256) invalid(`${path} must contain exactly 256 entries.`);
  const result = value.map((entry, index) => {
    if (entry === null && index === 0) return Number.NaN;
    return finiteNumber(entry, `${path}[${index}]`);
  });
  if (Number.isNaN(result[0])) {
    const second = result[1] ?? 0;
    result[0] = second + (second - (result[255] ?? second)) / 255;
  }
  return result;
}

export function parseAndValidateMeta(
  input: unknown,
  entries: ReadonlyMap<string, ZipEntry>,
): SOGMetaV2 {
  const root = record(input, 'meta.json');
  if (root.version !== 2) invalid('version must be exactly 2.');
  if (root.antialias !== undefined && typeof root.antialias !== 'boolean') {
    invalid('antialias must be a boolean when present.');
  }
  if (root.model !== undefined && root.model !== 'antialiased' && root.model !== '2dgs') {
    invalid('model must be "antialiased" or "2dgs" when present.');
  }
  const count = finiteNumber(root.count, 'count');
  if (!Number.isSafeInteger(count) || count <= 0) invalid('count must be a positive safe integer.');

  const means = record(root.means, 'means');
  const scales = record(root.scales, 'scales');
  const quats = record(root.quats, 'quats');
  const sh0 = record(root.sh0, 'sh0');
  const mins = vec3(means.mins, 'means.mins');
  const maxs = vec3(means.maxs, 'means.maxs');
  for (let axis = 0; axis < 3; axis += 1) {
    if ((maxs[axis] ?? 0) < (mins[axis] ?? 0)) invalid(`means.maxs[${axis}] must be >= means.mins[${axis}].`);
  }

  const normalized: SOGMetaV2 = {
    version: 2,
    count,
    means: { mins, maxs, files: files(means.files, 'means.files', 2) as [string, string] },
    scales: {
      codebook: codebook(scales.codebook, 'scales.codebook'),
      files: files(scales.files, 'scales.files', 1) as [string],
    },
    quats: { files: files(quats.files, 'quats.files', 1) as [string] },
    sh0: {
      codebook: codebook(sh0.codebook, 'sh0.codebook'),
      files: files(sh0.files, 'sh0.files', 1) as [string],
    },
    ...(typeof root.antialias === 'boolean' ? { antialias: root.antialias } : {}),
    ...(root.model === 'antialiased' || root.model === '2dgs' ? { model: root.model } : {}),
    ...(root.shN === undefined
      ? {}
      : (() => {
          const shN = record(root.shN, 'shN');
          return {
            shN: {
              codebook: codebook(shN.codebook, 'shN.codebook'),
              files: files(shN.files, 'shN.files', 2) as [string, string],
            },
          };
        })()),
  };

  for (const [attribute, group, index] of attributeFiles) {
    const filename = normalized[group].files[index];
    if (filename === undefined || !entries.has(filename)) {
      throw new SOGError(
        'MISSING_ATTRIBUTE',
        `SOG attribute "${attribute}" references missing bundle file "${String(filename)}".`,
        { stage: 'validation' },
      );
    }
  }
  if (normalized.shN) {
    for (const [index, attribute] of ['shN_centroids', 'shN_labels'].entries()) {
      const filename = normalized.shN.files[index]!;
      if (!entries.has(filename)) {
        throw new SOGError('MISSING_ATTRIBUTE', `SOG attribute "${attribute}" references missing bundle file "${filename}".`, { stage: 'validation' });
      }
    }
  }
  return normalized;
}

export function getAttributeFiles(meta: SOGMetaV2): ReadonlyMap<SOGAttributeName, string> {
  const result = new Map<SOGAttributeName, string>([
    ['means_l', meta.means.files[0]],
    ['means_u', meta.means.files[1]],
    ['quats', meta.quats.files[0]],
    ['scales', meta.scales.files[0]],
    ['sh0', meta.sh0.files[0]],
  ]);
  if (meta.shN) {
    result.set('shN_centroids', meta.shN.files[0]);
    result.set('shN_labels', meta.shN.files[1]);
  }
  return result;
}

export function validateImageDimensions(meta: SOGMetaV2, images: ReadonlyMap<SOGAttributeName, SOGNativeImage>): number {
  const means = images.get('means_l');
  if (!means) invalid('decoded means_l image is missing.');
  if (meta.count > means.width * means.height) invalid('count exceeds the addressable pixels in the attribute images.');

  for (const attribute of ['means_u', 'quats', 'scales', 'sh0', 'shN_labels'] as const) {
    const image = images.get(attribute);
    if (image && (image.width !== means.width || image.height !== means.height)) {
      throw new SOGError('IMAGE_DIMENSION_MISMATCH', `SOG attribute "${attribute}" is ${image.width}x${image.height}; expected ${means.width}x${means.height}.`, { stage: 'validation' });
    }
  }

  const centroids = images.get('shN_centroids');
  if (!centroids) return 0;
  const bands = new Map([[192, 1], [512, 2], [960, 3]]).get(centroids.width);
  if (bands === undefined || centroids.height !== 4) {
    throw new SOGError('IMAGE_DIMENSION_MISMATCH', `SOG SH centroid image must be 192x4, 512x4, or 960x4; received ${centroids.width}x${centroids.height}.`, { stage: 'validation' });
  }
  return bands;
}

export function unlog(value: number): number {
  return Math.sign(value) * Math.expm1(Math.abs(value));
}

export function calculateBounds(meta: SOGMetaV2): SOGBounds {
  const min = meta.means.mins.map(unlog) as [number, number, number];
  const max = meta.means.maxs.map(unlog) as [number, number, number];
  const center = min.map((value, index) => (value + (max[index] ?? value)) * 0.5) as [number, number, number];
  const halfExtents = min.map((value, index) => ((max[index] ?? value) - value) * 0.5) as [number, number, number];
  return { min, max, center, halfExtents };
}

export function decodeCenter(
  low: readonly number[],
  high: readonly number[],
  mins: SOGVec3,
  maxs: SOGVec3,
): [number, number, number] {
  return [0, 1, 2].map((axis) => {
    const quantized = ((high[axis] ?? 0) << 8) | (low[axis] ?? 0);
    const logValue = (mins[axis] ?? 0) + ((maxs[axis] ?? 0) - (mins[axis] ?? 0)) * (quantized / 65535);
    return unlog(logValue);
  }) as [number, number, number];
}
