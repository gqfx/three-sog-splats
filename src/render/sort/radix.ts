export function radixSortIndices(
  keys: Uint32Array,
  initialIndices?: Uint32Array,
  bits = 32,
): Uint32Array {
  if (bits < 0 || bits > 32 || bits % 8 !== 0) {
    throw new RangeError('Radix bit count must be a multiple of 8 in the range 0..32.');
  }
  const count = keys.length;
  if (initialIndices && initialIndices.length !== count) {
    throw new RangeError('Initial radix indices must match the key count.');
  }
  let readKeys = keys.slice();
  let writeKeys = new Uint32Array(count);
  let readIndices = initialIndices?.slice() ?? Uint32Array.from({ length: count }, (_, index) => index);
  let writeIndices = new Uint32Array(count);
  const histogram = new Uint32Array(256);

  for (let shift = 0; shift < bits; shift += 8) {
    histogram.fill(0);
    for (const key of readKeys) histogram[(key >>> shift) & 0xff]! += 1;
    let prefix = 0;
    for (let bucket = 0; bucket < 256; bucket += 1) {
      const amount = histogram[bucket] ?? 0;
      histogram[bucket] = prefix;
      prefix += amount;
    }
    for (let index = 0; index < count; index += 1) {
      const key = readKeys[index] ?? 0;
      const bucket = (key >>> shift) & 0xff;
      const destination = histogram[bucket] ?? 0;
      histogram[bucket] = destination + 1;
      writeKeys[destination] = key;
      writeIndices[destination] = readIndices[index] ?? index;
    }
    [readKeys, writeKeys] = [writeKeys, readKeys];
    [readIndices, writeIndices] = [writeIndices, readIndices];
  }
  return readIndices;
}
