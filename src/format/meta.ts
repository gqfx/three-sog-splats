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
  if (root.antialias === true || root.model === 'antialiased') {
    throw new SOGError(
      'UNSUPPORTED_SOURCE',
      'Antialiased SOG assets are not supported yet; rendering them as standard 3D Gaussians would be incorrect.',
      { stage: 'validation' },
    );
  }
  if (root.model === '2dgs') {
    throw new SOGError(
      'UNSUPPORTED_SOURCE',
      '2DGS assets are not supported yet; rendering them as standard 3D Gaussians would be incorrect.',
      { stage: 'validation' },
    );
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
          const count = finiteNumber(shN.count, 'shN.count');
          if (!Number.isSafeInteger(count) || count <= 0 || count > 65_536) {
            invalid('shN.count must be a positive safe integer no greater than 65536.');
          }
          const bands = finiteNumber(shN.bands, 'shN.bands');
          if (bands !== 1 && bands !== 2 && bands !== 3) {
            invalid('shN.bands must be 1, 2, or 3.');
          }
          return {
            shN: {
              count,
              bands,
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
  // Check the representation consumed by shaders, including exponentiation.
  for (const value of [...mins, ...maxs]) {
    if (!Number.isFinite(Math.fround(Math.expm1(Math.abs(Math.fround(value)))))) {
      invalid('decoded means must be representable as finite Float32 values.');
    }
  }
  for (const value of normalized.scales.codebook) {
    const scale = Math.fround(Math.exp(Math.fround(value)));
    if (!Number.isFinite(scale) || scale <= 0) invalid('decoded scales must be positive finite Float32 values.');
  }
  for (const value of [...normalized.sh0.codebook, ...(normalized.shN?.codebook ?? [])]) {
    if (!Number.isFinite(Math.fround(value)) || Math.abs(value) > 1e30) {
      invalid('SH coefficients must be finite Float32 values with headroom for SH evaluation.');
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

export function validateImageDimensions(meta: SOGMetaV2, images: ReadonlyMap<SOGAttributeName, Pick<SOGNativeImage, 'width' | 'height'>>): number {
  for (const image of images.values()) {
    if (!Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height) || image.width <= 0 || image.height <= 0) invalid('image dimensions must be positive safe integers.');
  }
  const means = images.get('means_l');
  if (!means) invalid('decoded means_l image is missing.');
  if (meta.count > means.width * means.height) invalid('count exceeds the addressable pixels in the attribute images.');

  for (const attribute of ['means_u', 'quats', 'scales', 'sh0', 'shN_labels'] as const) {
    const image = images.get(attribute);
    if (image && (image.width !== means.width || image.height !== means.height)) {
      throw new SOGError('IMAGE_DIMENSION_MISMATCH', `SOG attribute "${attribute}" is ${image.width}x${image.height}; expected ${means.width}x${means.height}.`, { stage: 'validation' });
    }
  }

  if (!meta.shN) return 0;
  const centroids = images.get('shN_centroids');
  if (!centroids) invalid('decoded shN_centroids image is missing.');
  const coefficientCount = [0, 3, 8, 15][meta.shN.bands]!;
  const expectedWidth = 64 * coefficientCount;
  const expectedHeight = Math.ceil(meta.shN.count / 64);
  if (centroids.width !== expectedWidth || centroids.height !== expectedHeight) {
    throw new SOGError(
      'IMAGE_DIMENSION_MISMATCH',
      `SOG SH centroid image is ${centroids.width}x${centroids.height}; expected ${expectedWidth}x${expectedHeight} for ${meta.shN.count} SH${meta.shN.bands} centroids.`,
      { stage: 'validation' },
    );
  }
  return meta.shN.bands;
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
