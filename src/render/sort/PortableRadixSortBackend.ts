/*
 * Portable 4-bit WebGPU radix sort adapted from PlayCanvas Engine commit
 * 8f41866882d36f0f0e8f22b77ebf7f9fa7b102f6 and
 * kishimisu/WebGPU-Radix-Sort. Both are credited in THIRD_PARTY_NOTICES.md.
 * This translation uses only public Three.js WebGPU and TSL exports.
 */
import { StorageBufferAttribute } from 'three/webgpu';
import type {
  ComputeNode,
  WebGPURenderer,
} from 'three/webgpu';
import {
  Fn,
  If,
  Loop,
  countOneBits,
  instanceIndex,
  invocationLocalIndex,
  storage,
  uint,
  workgroupArray,
  workgroupBarrier,
  workgroupId,
} from 'three/tsl';
import type { RadixSortBackend } from './backend.js';

export const PORTABLE_RADIX_BITS = 4;
export const PORTABLE_BUCKET_COUNT = 2 ** PORTABLE_RADIX_BITS;
export const PORTABLE_WORKGROUP_SIZE = 256;
export const PORTABLE_KEYS_PER_INVOCATION = 8;
export const PORTABLE_KEYS_PER_WORKGROUP = PORTABLE_WORKGROUP_SIZE * PORTABLE_KEYS_PER_INVOCATION;

const MASK_WORD_BITS = 32;
const MASK_WORDS_PER_BUCKET = PORTABLE_WORKGROUP_SIZE / MASK_WORD_BITS;
const SCAN_WORKGROUP_SIZE = 256;

interface ScanLevel {
  readonly attribute: StorageBufferAttribute;
  readonly count: number;
}

function attributeBytes(attribute: StorageBufferAttribute): number {
  return attribute.count * attribute.itemSize * Uint32Array.BYTES_PER_ELEMENT;
}

function createUintAttribute(count: number): StorageBufferAttribute {
  return new StorageBufferAttribute(new Uint32Array(Math.max(1, count)), 1);
}

function namedWorkgroupArray(type: string, count: number, name: string): any {
  const result = workgroupArray(type, count);
  // @types/three@0.185.0 omits Node extension methods from WorkgroupInfoNode.
  (result as any).setName(name);
  return result;
}

function scanLevelSizes(workgroupCount: number): number[] {
  const result = [PORTABLE_BUCKET_COUNT * Math.max(1, workgroupCount)];
  while (result[result.length - 1]! > SCAN_WORKGROUP_SIZE) {
    result.push(Math.ceil(result[result.length - 1]! / SCAN_WORKGROUP_SIZE));
  }
  return result;
}

export function portableRadixAllocationBytes(count: number): number {
  const capacity = Math.max(1, count);
  const workgroupCount = Math.max(1, Math.ceil(count / PORTABLE_KEYS_PER_WORKGROUP));
  const pingPongBytes = capacity * 4 * Uint32Array.BYTES_PER_ELEMENT;
  const scanBytes = scanLevelSizes(workgroupCount)
    .reduce((total, entries) => total + entries * Uint32Array.BYTES_PER_ELEMENT, 0);
  return pingPongBytes + scanBytes;
}

export class PortableRadixSortBackend implements RadixSortBackend {
  readonly kind = 'portable';
  readonly radixBits = PORTABLE_RADIX_BITS;
  readonly count: number;
  readonly capacity: number;
  readonly bits: number;
  readonly allocatedBytes: number;
  readonly orderAttribute: StorageBufferAttribute;
  readonly #keyAttributes: readonly [StorageBufferAttribute, StorageBufferAttribute];
  readonly #valueAttributes: readonly [StorageBufferAttribute, StorageBufferAttribute];
  readonly #scanLevels: readonly ScanLevel[];
  readonly #computeNodes: ComputeNode[];
  #disposed = false;

  constructor(count: number, inputKeys: StorageBufferAttribute, bits: number) {
    if (!Number.isInteger(bits) || bits < 0 || bits > 32 || bits % PORTABLE_RADIX_BITS !== 0) {
      throw new RangeError('Portable radix bit count must be a multiple of 4 in the range 0..32.');
    }
    if (inputKeys.count < Math.max(1, count)) {
      throw new RangeError('Portable radix input key capacity is smaller than the active count.');
    }
    this.count = count;
    this.capacity = Math.max(1, count);
    this.bits = bits;
    this.#keyAttributes = [createUintAttribute(this.capacity), createUintAttribute(this.capacity)];
    this.#valueAttributes = [createUintAttribute(this.capacity), createUintAttribute(this.capacity)];
    const passCount = bits / PORTABLE_RADIX_BITS;
    this.orderAttribute = passCount === 0
      ? this.#valueAttributes[0]
      : this.#valueAttributes[(passCount - 1) % 2] as StorageBufferAttribute;
    const workgroupCount = Math.max(1, Math.ceil(count / PORTABLE_KEYS_PER_WORKGROUP));
    this.#scanLevels = scanLevelSizes(workgroupCount).map((count) => ({
      count,
      attribute: createUintAttribute(count),
    }));
    this.allocatedBytes = [...this.#keyAttributes, ...this.#valueAttributes]
      .reduce((total, attribute) => total + attributeBytes(attribute), 0)
      + this.#scanLevels.reduce((total, level) => total + attributeBytes(level.attribute), 0);
    this.#computeNodes = count === 0 || passCount === 0
      ? []
      : this.#buildNodes(inputKeys, workgroupCount, passCount);
  }

  get computeNodes(): readonly ComputeNode[] {
    return this.#computeNodes;
  }

  sort(renderer: WebGPURenderer): void {
    if (this.#computeNodes.length > 0) renderer.compute(this.#computeNodes);
  }

  async sortAsync(renderer: WebGPURenderer): Promise<void> {
    if (this.#computeNodes.length > 0) await renderer.computeAsync(this.#computeNodes);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const node of this.#computeNodes) node.dispose();
    for (const attribute of this.#keyAttributes) attribute.dispose();
    for (const attribute of this.#valueAttributes) attribute.dispose();
    for (const level of this.#scanLevels) level.attribute.dispose();
  }

  #buildNodes(
    inputKeysAttribute: StorageBufferAttribute,
    workgroupCount: number,
    passCount: number,
  ): ComputeNode[] {
    const nodes: ComputeNode[] = [];
    let readKeysAttribute = inputKeysAttribute;
    for (let pass = 0; pass < passCount; pass += 1) {
      const writeKeysAttribute = this.#keyAttributes[pass % 2]!;
      const writeValuesAttribute = this.#valueAttributes[pass % 2]!;
      const readValuesAttribute = pass === 0 ? null : this.#valueAttributes[(pass - 1) % 2]!;
      const shift = pass * PORTABLE_RADIX_BITS;
      nodes.push(this.#createHistogramNode(readKeysAttribute, workgroupCount, shift));
      nodes.push(...this.#createScanNodes());
      nodes.push(this.#createScatterNode(
        readKeysAttribute,
        writeKeysAttribute,
        readValuesAttribute,
        writeValuesAttribute,
        workgroupCount,
        shift,
      ));
      readKeysAttribute = writeKeysAttribute;
    }
    return nodes;
  }

  #createHistogramNode(
    inputAttribute: StorageBufferAttribute,
    workgroupCount: number,
    shift: number,
  ): ComputeNode {
    const input = storage(inputAttribute, 'uint', this.capacity);
    const blockSums = storage(
      this.#scanLevels[0]!.attribute,
      'uint',
      PORTABLE_BUCKET_COUNT * workgroupCount,
    );
    const count = uint(this.count);
    const groupCount = uint(workgroupCount);
    const sharedDigits = namedWorkgroupArray(
      'uint',
      PORTABLE_KEYS_PER_WORKGROUP,
      `SOGPortableHistogramDigits${shift}`,
    );

    const node = Fn(() => {
      const local = invocationLocalIndex.toVar();
      const group = workgroupId.x.toVar();
      for (let round = 0; round < PORTABLE_KEYS_PER_INVOCATION; round += 1) {
        const localOffset = local.add(uint(round * PORTABLE_WORKGROUP_SIZE));
        const sourceIndex = group.mul(uint(PORTABLE_KEYS_PER_WORKGROUP)).add(localOffset).toVar();
        const digit = uint(PORTABLE_BUCKET_COUNT).toVar();
        If(sourceIndex.lessThan(count), () => {
          digit.assign(input.element(sourceIndex).shiftRight(uint(shift)).bitAnd(uint(PORTABLE_BUCKET_COUNT - 1)));
        });
        sharedDigits.element(localOffset).assign(digit);
      }
      workgroupBarrier();
      If(local.lessThan(uint(PORTABLE_BUCKET_COUNT)), () => {
        const amount = uint(0).toVar();
        Loop({ start: 0, end: PORTABLE_KEYS_PER_WORKGROUP, type: 'uint', condition: '<' }, ({ i }) => {
          If(sharedDigits.element(i).equal(local), () => {
            amount.addAssign(uint(1));
          });
        });
        blockSums.element(local.mul(groupCount).add(group)).assign(amount);
      });
    })().compute(workgroupCount * PORTABLE_WORKGROUP_SIZE, [PORTABLE_WORKGROUP_SIZE]);
    node.setName(`SOG Portable histogram bits ${shift}-${shift + PORTABLE_RADIX_BITS - 1}`);
    return node;
  }

  #createScanNodes(): ComputeNode[] {
    const nodes: ComputeNode[] = [];
    for (let levelIndex = 0; levelIndex < this.#scanLevels.length; levelIndex += 1) {
      const level = this.#scanLevels[levelIndex]!;
      const next = this.#scanLevels[levelIndex + 1];
      nodes.push(this.#createBlellochNode(level, next, levelIndex));
    }
    for (let levelIndex = this.#scanLevels.length - 2; levelIndex >= 0; levelIndex -= 1) {
      nodes.push(this.#createPrefixAddNode(
        this.#scanLevels[levelIndex]!,
        this.#scanLevels[levelIndex + 1]!,
        levelIndex,
      ));
    }
    return nodes;
  }

  #createBlellochNode(level: ScanLevel, next: ScanLevel | undefined, levelIndex: number): ComputeNode {
    const groupCount = Math.ceil(level.count / SCAN_WORKGROUP_SIZE);
    const values = storage(level.attribute, 'uint', level.count);
    const totals = next
      ? storage(next.attribute, 'uint', next.count)
      : null;
    const entryCount = uint(level.count);
    const shared = namedWorkgroupArray('uint', SCAN_WORKGROUP_SIZE, `SOGPortableScan${levelIndex}`);

    const node = Fn(() => {
      const local = invocationLocalIndex.toVar();
      const flatGroup = workgroupId.x.toVar();
      const entry = flatGroup.mul(uint(SCAN_WORKGROUP_SIZE)).add(local).toVar();
      const value = uint(0).toVar();
      If(entry.lessThan(entryCount), () => {
        value.assign(values.element(entry));
      });
      shared.element(local).assign(value);
      workgroupBarrier();

      for (let offset = 1; offset < SCAN_WORKGROUP_SIZE; offset *= 2) {
        const target = local.add(uint(1)).mul(uint(offset * 2)).sub(uint(1)).toVar();
        If(target.lessThan(uint(SCAN_WORKGROUP_SIZE)), () => {
          shared.element(target).addAssign(shared.element(target.sub(uint(offset))));
        });
        workgroupBarrier();
      }

      If(local.equal(uint(SCAN_WORKGROUP_SIZE - 1)), () => {
        if (totals) {
          totals.element(flatGroup).assign(shared.element(local));
        }
        shared.element(local).assign(uint(0));
      });
      workgroupBarrier();

      for (let offset = SCAN_WORKGROUP_SIZE / 2; offset >= 1; offset /= 2) {
        const target = local.add(uint(1)).mul(uint(offset * 2)).sub(uint(1)).toVar();
        If(target.lessThan(uint(SCAN_WORKGROUP_SIZE)), () => {
          const previous = shared.element(target.sub(uint(offset))).toVar();
          shared.element(target.sub(uint(offset))).assign(shared.element(target));
          shared.element(target).addAssign(previous);
        });
        workgroupBarrier();
      }

      If(entry.lessThan(entryCount), () => {
        values.element(entry).assign(shared.element(local));
      });
    })().compute(
      groupCount * SCAN_WORKGROUP_SIZE,
      [SCAN_WORKGROUP_SIZE],
    );
    node.setName(`SOG Portable Blelloch scan level ${levelIndex}`);
    return node;
  }

  #createPrefixAddNode(child: ScanLevel, parent: ScanLevel, levelIndex: number): ComputeNode {
    const childValues = storage(child.attribute, 'uint', child.count);
    const parentValues = storage(parent.attribute, 'uint', parent.count);
    const node = Fn(() => {
      const parentEntry = instanceIndex.div(uint(SCAN_WORKGROUP_SIZE)).toVar();
      childValues.element(instanceIndex).addAssign(
        parentValues.element(parentEntry),
      );
    })().compute(child.count, [PORTABLE_WORKGROUP_SIZE]);
    node.setName(`SOG Portable scan prefix add level ${levelIndex}`);
    return node;
  }

  #createScatterNode(
    inputKeysAttribute: StorageBufferAttribute,
    outputKeysAttribute: StorageBufferAttribute,
    inputValuesAttribute: StorageBufferAttribute | null,
    outputValuesAttribute: StorageBufferAttribute,
    workgroupCount: number,
    shift: number,
  ): ComputeNode {
    const inputKeys = storage(inputKeysAttribute, 'uint', this.capacity);
    const outputKeys = storage(outputKeysAttribute, 'uint', this.capacity);
    const inputValues = inputValuesAttribute
      ? storage(inputValuesAttribute, 'uint', this.capacity)
      : null;
    const outputValues = storage(outputValuesAttribute, 'uint', this.capacity);
    const prefixes = storage(
      this.#scanLevels[0]!.attribute,
      'uint',
      PORTABLE_BUCKET_COUNT * workgroupCount,
    );
    const count = uint(this.count);
    const groupCount = uint(workgroupCount);
    const sharedDigits = namedWorkgroupArray(
      'uint',
      PORTABLE_WORKGROUP_SIZE,
      `SOGPortableScatterDigits${shift}`,
    );
    const masks = namedWorkgroupArray(
      'uint',
      PORTABLE_BUCKET_COUNT * MASK_WORDS_PER_BUCKET,
      `SOGPortableScatterMasks${shift}`,
    );
    const bucketOffsets = namedWorkgroupArray(
      'uint',
      PORTABLE_BUCKET_COUNT,
      `SOGPortableScatterOffsets${shift}`,
    );

    const node = Fn(() => {
      const local = invocationLocalIndex.toVar();
      const group = workgroupId.x.toVar();
      If(local.lessThan(uint(PORTABLE_BUCKET_COUNT)), () => {
        bucketOffsets.element(local).assign(uint(0));
      });
      workgroupBarrier();

      for (let round = 0; round < PORTABLE_KEYS_PER_INVOCATION; round += 1) {
        const sourceIndex = group.mul(uint(PORTABLE_KEYS_PER_WORKGROUP))
          .add(uint(round * PORTABLE_WORKGROUP_SIZE))
          .add(local)
          .toVar();
        const key = uint(0).toVar();
        const digit = uint(PORTABLE_BUCKET_COUNT).toVar();
        If(sourceIndex.lessThan(count), () => {
          key.assign(inputKeys.element(sourceIndex));
          digit.assign(key.shiftRight(uint(shift)).bitAnd(uint(PORTABLE_BUCKET_COUNT - 1)));
        });
        sharedDigits.element(local).assign(digit);
        workgroupBarrier();

        If(local.lessThan(uint(PORTABLE_BUCKET_COUNT * MASK_WORDS_PER_BUCKET)), () => {
          const maskDigit = local.div(uint(MASK_WORDS_PER_BUCKET)).toVar();
          const word = local.mod(uint(MASK_WORDS_PER_BUCKET)).toVar();
          const mask = uint(0).toVar();
          Loop({ start: 0, end: MASK_WORD_BITS, type: 'uint', condition: '<' }, ({ i }) => {
            const lane = word.mul(uint(MASK_WORD_BITS)).add(i).toVar();
            If(sharedDigits.element(lane).equal(maskDigit), () => {
              mask.bitOrAssign(uint(1).shiftLeft(i));
            });
          });
          masks.element(local).assign(mask);
        });
        workgroupBarrier();

        If(sourceIndex.lessThan(count), () => {
          const word = local.div(uint(MASK_WORD_BITS)).toVar();
          const bit = local.mod(uint(MASK_WORD_BITS)).toVar();
          const rank = uint(0).toVar();
          Loop({ start: 0, end: MASK_WORDS_PER_BUCKET, type: 'uint', condition: '<' }, ({ i }) => {
            If(i.lessThan(word), () => {
              rank.addAssign(uint(countOneBits(
                masks.element(digit.mul(uint(MASK_WORDS_PER_BUCKET)).add(i)),
              ) as any));
            });
          });
          const currentMask = masks.element(digit.mul(uint(MASK_WORDS_PER_BUCKET)).add(word));
          rank.addAssign(uint(countOneBits(
            currentMask.bitAnd(uint(1).shiftLeft(bit).sub(uint(1))),
          ) as any));
          const destination = prefixes.element(digit.mul(groupCount).add(group))
            .add(bucketOffsets.element(digit))
            .add(rank)
            .toVar();
          outputKeys.element(destination).assign(key);
          outputValues.element(destination).assign(
            inputValues ? inputValues.element(sourceIndex) : sourceIndex,
          );
        });
        workgroupBarrier();

        If(local.lessThan(uint(PORTABLE_BUCKET_COUNT)), () => {
          const amount = uint(0).toVar();
          Loop({ start: 0, end: MASK_WORDS_PER_BUCKET, type: 'uint', condition: '<' }, ({ i }) => {
            amount.addAssign(uint(countOneBits(
              masks.element(local.mul(uint(MASK_WORDS_PER_BUCKET)).add(i)),
            ) as any));
          });
          bucketOffsets.element(local).addAssign(amount);
        });
        workgroupBarrier();
      }
    })().compute(workgroupCount * PORTABLE_WORKGROUP_SIZE, [PORTABLE_WORKGROUP_SIZE]);
    node.setName(`SOG Portable stable scatter bits ${shift}-${shift + PORTABLE_RADIX_BITS - 1}`);
    return node;
  }
}
