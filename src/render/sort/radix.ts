export interface RadixSortResult {
  readonly keys: Uint32Array;
  readonly values: Uint32Array;
}

/** Reusable buffers; returned results remain valid until the next sort. */
export class RadixSortWorkspace {
  readonly readKeys: Uint32Array;
  readonly writeKeys: Uint32Array;
  readonly readIndices: Uint32Array;
  readonly writeIndices: Uint32Array;
  readonly histogram = new Uint32Array(256);
  constructor(count: number) {
    this.readKeys = new Uint32Array(count);
    this.writeKeys = new Uint32Array(count);
    this.readIndices = new Uint32Array(count);
    this.writeIndices = new Uint32Array(count);
  }
  get byteLength(): number { return this.readKeys.byteLength * 4 + this.histogram.byteLength; }
}

export function radixSortKeyValues(
  keys: Uint32Array,
  initialIndices?: Uint32Array,
  bits = 32,
  radixBits: 4 | 8 = 8,
  workspace?: RadixSortWorkspace,
): RadixSortResult {
  if (bits < 0 || bits > 32 || bits % radixBits !== 0) {
    throw new RangeError(`Radix bit count must be a multiple of ${radixBits} in the range 0..32.`);
  }
  const count = keys.length;
  if (initialIndices && initialIndices.length !== count) {
    throw new RangeError('Initial radix indices must match the key count.');
  }
  const buffers = workspace ?? new RadixSortWorkspace(count);
  if (buffers.readKeys.length !== count) throw new RangeError('Radix workspace must match the key count.');
  let { readKeys, writeKeys, readIndices, writeIndices } = buffers;
  if (readKeys !== keys) readKeys.set(keys);
  if (initialIndices) readIndices.set(initialIndices);
  else for (let index = 0; index < count; index += 1) readIndices[index] = index;
  const bucketCount = 2 ** radixBits;
  const bucketMask = bucketCount - 1;
  const histogram = buffers.histogram.subarray(0, bucketCount);

  for (let shift = 0; shift < bits; shift += radixBits) {
    histogram.fill(0);
    for (const key of readKeys) histogram[(key >>> shift) & bucketMask]! += 1;
    let prefix = 0;
    for (let bucket = 0; bucket < bucketCount; bucket += 1) {
      const amount = histogram[bucket] ?? 0;
      histogram[bucket] = prefix;
      prefix += amount;
    }
    for (let index = 0; index < count; index += 1) {
      const key = readKeys[index] ?? 0;
      const bucket = (key >>> shift) & bucketMask;
      const destination = histogram[bucket] ?? 0;
      histogram[bucket] = destination + 1;
      writeKeys[destination] = key;
      writeIndices[destination] = readIndices[index] ?? index;
    }
    [readKeys, writeKeys] = [writeKeys, readKeys];
    [readIndices, writeIndices] = [writeIndices, readIndices];
  }
  return { keys: readKeys, values: readIndices };
}

export function radixSortIndices(
  keys: Uint32Array,
  initialIndices?: Uint32Array,
  bits = 32,
  radixBits: 4 | 8 = 8,
): Uint32Array {
  return radixSortKeyValues(keys, initialIndices, bits, radixBits).values;
}
