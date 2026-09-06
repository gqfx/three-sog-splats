/*
 * OneSweep WebGPU radix sort adapted from PlayCanvas Engine commit
 * 8f41866882d36f0f0e8f22b77ebf7f9fa7b102f6 and b0nes164/GPUSorting
 * (Thomas Smith, MIT). See THIRD_PARTY_NOTICES.md. This translation uses
 * only public Three.js WebGPU and TSL exports.
 */
import { StorageBufferAttribute } from 'three/webgpu';
import type { ComputeNode, WebGPURenderer } from 'three/webgpu';
import {
  Fn,
  If,
  Loop,
  array,
  atomicAdd,
  atomicLoad,
  atomicStore,
  bool,
  countOneBits,
  countTrailingZeros,
  instanceIndex,
  invocationLocalIndex,
  invocationSubgroupIndex,
  min,
  storage,
  subgroupAdd,
  subgroupBallot,
  subgroupExclusiveAdd,
  subgroupIndex,
  subgroupShuffle,
  subgroupSize,
  uint,
  workgroupArray,
  workgroupBarrier,
  workgroupId,
} from 'three/tsl';
import type { RadixSortBackend } from './backend.js';

export const ONESWEEP_RADIX_BITS = 8;
export const ONESWEEP_RADIX = 2 ** ONESWEEP_RADIX_BITS;
export const ONESWEEP_WORKGROUP_SIZE = 256;
export const ONESWEEP_KEYS_PER_INVOCATION = 15;
export const ONESWEEP_PARTITION_SIZE = ONESWEEP_WORKGROUP_SIZE * ONESWEEP_KEYS_PER_INVOCATION;

const FLAG_REDUCTION = 1;
const FLAG_INCLUSIVE = 2;
const FLAG_MASK = 3;
const MAX_SUBGROUPS_LIMIT = 64;

function createUintAttribute(count: number): StorageBufferAttribute {
  return new StorageBufferAttribute(new Uint32Array(Math.max(1, count)), 1);
}

function namedWorkgroupArray(type: string, count: number, name: string): any {
  const result = workgroupArray(type, count);
  // @types/three@0.185.0 omits Node extension methods from WorkgroupInfoNode.
  (result as any).setName(name);
  return result;
}

function bitCount(value: unknown): any {
  return uint(countOneBits(value as any) as any);
}

function trailingZeroCount(value: unknown): any {
  return uint(countTrailingZeros(value as any) as any);
}

function subgroupUint(value: unknown): any {
  return uint(value as any);
}

export function oneSweepRadixAllocationBytes(count: number, bits: number): number {
  const capacity = Math.max(1, count);
  const passCount = bits / ONESWEEP_RADIX_BITS;
  const threadBlocks = Math.max(1, Math.ceil(count / ONESWEEP_PARTITION_SIZE));
  const pingPongBytes = capacity * 4 * Uint32Array.BYTES_PER_ELEMENT;
  const scratchEntries = (passCount * ONESWEEP_RADIX)
    + (passCount * threadBlocks * ONESWEEP_RADIX)
    + passCount;
  return pingPongBytes + scratchEntries * Uint32Array.BYTES_PER_ELEMENT;
}

export class OneSweepRadixSortBackend implements RadixSortBackend {
  readonly kind = 'onesweep';
  readonly radixBits = ONESWEEP_RADIX_BITS;
  readonly count: number;
  readonly capacity: number;
  readonly bits: number;
  readonly allocatedBytes: number;
  readonly orderAttribute: StorageBufferAttribute;
  readonly #keyAttributes: readonly [StorageBufferAttribute, StorageBufferAttribute];
  readonly #valueAttributes: readonly [StorageBufferAttribute, StorageBufferAttribute];
  readonly #globalHistogramAttribute: StorageBufferAttribute;
  readonly #passHistogramAttribute: StorageBufferAttribute;
  readonly #partitionIndexAttribute: StorageBufferAttribute;
  readonly #computeNodes: ComputeNode[];
  readonly #passCount: number;
  readonly #threadBlocks: number;
  readonly #maxSubgroups: number;
  #disposed = false;

  constructor(
    count: number,
    inputKeys: StorageBufferAttribute,
    bits: number,
    subgroupSize = 32,
  ) {
    if (!Number.isInteger(bits) || bits < 0 || bits > 32 || bits % ONESWEEP_RADIX_BITS !== 0) {
      throw new RangeError('OneSweep radix bit count must be a multiple of 8 in the range 0..32.');
    }
    if (inputKeys.count < Math.max(1, count)) {
      throw new RangeError('OneSweep radix input key capacity is smaller than the active count.');
    }
    if (subgroupSize !== 32) {
      throw new RangeError('OneSweep requires a fixed 32-lane subgroup size.');
    }
    this.count = count;
    this.capacity = Math.max(1, count);
    this.bits = bits;
    this.#passCount = bits / ONESWEEP_RADIX_BITS;
    this.#threadBlocks = Math.max(1, Math.ceil(count / ONESWEEP_PARTITION_SIZE));
    this.#maxSubgroups = Math.min(
      MAX_SUBGROUPS_LIMIT,
      Math.max(1, Math.ceil(ONESWEEP_WORKGROUP_SIZE / subgroupSize)),
    );
    this.#keyAttributes = [createUintAttribute(this.capacity), createUintAttribute(this.capacity)];
    this.#valueAttributes = [createUintAttribute(this.capacity), createUintAttribute(this.capacity)];
    this.orderAttribute = this.#passCount === 0
      ? this.#valueAttributes[0]
      : this.#valueAttributes[(this.#passCount - 1) % 2]!;
    this.#globalHistogramAttribute = createUintAttribute(this.#passCount * ONESWEEP_RADIX);
    this.#passHistogramAttribute = createUintAttribute(
      this.#passCount * this.#threadBlocks * ONESWEEP_RADIX,
    );
    this.#partitionIndexAttribute = createUintAttribute(this.#passCount);
    this.allocatedBytes = oneSweepRadixAllocationBytes(count, bits);
    this.#computeNodes = count === 0 || this.#passCount === 0
      ? []
      : this.#buildNodes(inputKeys);
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
    this.#globalHistogramAttribute.dispose();
    this.#passHistogramAttribute.dispose();
    this.#partitionIndexAttribute.dispose();
  }

  #buildNodes(inputKeysAttribute: StorageBufferAttribute): ComputeNode[] {
    const nodes = [
      this.#createResetNode(),
      this.#createGlobalHistogramNode(inputKeysAttribute),
      this.#createDigitBaseScanNode(),
    ];
    let readKeysAttribute = inputKeysAttribute;
    for (let pass = 0; pass < this.#passCount; pass += 1) {
      const writeKeysAttribute = this.#keyAttributes[pass % 2]!;
      const writeValuesAttribute = this.#valueAttributes[pass % 2]!;
      const readValuesAttribute = pass === 0 ? null : this.#valueAttributes[(pass - 1) % 2]!;
      nodes.push(this.#createBinningNode(
        pass,
        readKeysAttribute,
        writeKeysAttribute,
        readValuesAttribute,
        writeValuesAttribute,
      ));
      readKeysAttribute = writeKeysAttribute;
    }
    return nodes;
  }

  #createResetNode(): ComputeNode {
    const globalHistogram = storage(
      this.#globalHistogramAttribute,
      'uint',
      this.#passCount * ONESWEEP_RADIX,
    ).toAtomic();
    const passHistogram = storage(
      this.#passHistogramAttribute,
      'uint',
      this.#passCount * this.#threadBlocks * ONESWEEP_RADIX,
    ).toAtomic();
    const partitionIndex = storage(
      this.#partitionIndexAttribute,
      'uint',
      this.#passCount,
    ).toAtomic();
    const globalCount = uint(this.#passCount * ONESWEEP_RADIX);
    const passCount = uint(this.#passCount * this.#threadBlocks * ONESWEEP_RADIX);
    const indexCount = uint(this.#passCount);
    const resetCount = Math.max(
      this.#passCount * ONESWEEP_RADIX,
      this.#passCount * this.#threadBlocks * ONESWEEP_RADIX,
      this.#passCount,
    );
    const node = Fn(() => {
      If(instanceIndex.lessThan(globalCount), () => {
        atomicStore(globalHistogram.element(instanceIndex), uint(0));
      });
      If(instanceIndex.lessThan(passCount), () => {
        atomicStore(passHistogram.element(instanceIndex), uint(0));
      });
      If(instanceIndex.lessThan(indexCount), () => {
        atomicStore(partitionIndex.element(instanceIndex), uint(0));
      });
    })().compute(resetCount, [ONESWEEP_WORKGROUP_SIZE]);
    node.setName('SOG OneSweep scratch reset');
    return node;
  }

  #createGlobalHistogramNode(inputKeysAttribute: StorageBufferAttribute): ComputeNode {
    const inputKeys = storage(inputKeysAttribute, 'uint', this.capacity);
    const globalHistogram = storage(
      this.#globalHistogramAttribute,
      'uint',
      this.#passCount * ONESWEEP_RADIX,
    ).toAtomic();
    const count = uint(this.count);
    const node = Fn(() => {
      If(instanceIndex.lessThan(count), () => {
        const key = inputKeys.element(instanceIndex).toVar();
        for (let pass = 0; pass < this.#passCount; pass += 1) {
          const digit = key.shiftRight(uint(pass * ONESWEEP_RADIX_BITS)).bitAnd(uint(0xff));
          atomicAdd(globalHistogram.element(uint(pass * ONESWEEP_RADIX).add(digit)), uint(1));
        }
      });
    })().compute(this.count, [ONESWEEP_WORKGROUP_SIZE]);
    node.setName('SOG OneSweep all-pass global histogram');
    return node;
  }

  #createDigitBaseScanNode(): ComputeNode {
    const globalHistogram = storage(
      this.#globalHistogramAttribute,
      'uint',
      this.#passCount * ONESWEEP_RADIX,
    );
    const passHistogram = storage(
      this.#passHistogramAttribute,
      'uint',
      this.#passCount * this.#threadBlocks * ONESWEEP_RADIX,
    ).toAtomic();
    const subgroupTotals = namedWorkgroupArray(
      'uint',
      this.#maxSubgroups,
      'SOGOneSweepScanSubgroupTotals',
    );
    const node = Fn(() => {
      const local = invocationLocalIndex.toVar();
      const pass = workgroupId.x.toVar();
      If(local.lessThan(uint(this.#maxSubgroups)), () => {
        subgroupTotals.element(local).assign(uint(0));
      });
      workgroupBarrier();
      const value = globalHistogram.element(pass.mul(uint(ONESWEEP_RADIX)).add(local)).toVar();
      const subgroupExclusive = subgroupUint(subgroupExclusiveAdd(value)).toVar();
      const subgroupTotal = subgroupUint(subgroupAdd(value)).toVar();
      If(invocationSubgroupIndex.equal(uint(0)), () => {
        subgroupTotals.element(subgroupIndex).assign(subgroupTotal);
      });
      workgroupBarrier();
      If(local.equal(uint(0)), () => {
        const accumulator = uint(0).toVar();
        Loop({ start: 0, end: this.#maxSubgroups, type: 'uint', condition: '<' }, ({ i }) => {
          const amount = subgroupTotals.element(i).toVar();
          subgroupTotals.element(i).assign(accumulator);
          accumulator.addAssign(amount);
        });
      });
      workgroupBarrier();
      const exclusive = subgroupExclusive.add(subgroupTotals.element(subgroupIndex)).toVar();
      const destination = pass.mul(uint(this.#threadBlocks * ONESWEEP_RADIX)).add(local);
      atomicStore(
        passHistogram.element(destination),
        exclusive.shiftLeft(uint(2)).bitOr(uint(FLAG_INCLUSIVE)),
      );
    })().compute(this.#passCount * ONESWEEP_WORKGROUP_SIZE, [ONESWEEP_WORKGROUP_SIZE]);
    node.setName('SOG OneSweep exclusive digit-base scan');
    return node;
  }

  #createBinningNode(
    pass: number,
    inputKeysAttribute: StorageBufferAttribute,
    outputKeysAttribute: StorageBufferAttribute,
    inputValuesAttribute: StorageBufferAttribute | null,
    outputValuesAttribute: StorageBufferAttribute,
  ): ComputeNode {
    const inputKeys = storage(inputKeysAttribute, 'uint', this.capacity);
    const outputKeys = storage(outputKeysAttribute, 'uint', this.capacity);
    const inputValues = inputValuesAttribute
      ? storage(inputValuesAttribute, 'uint', this.capacity)
      : null;
    const outputValues = storage(outputValuesAttribute, 'uint', this.capacity);
    const passHistogram = storage(
      this.#passHistogramAttribute,
      'uint',
      this.#passCount * this.#threadBlocks * ONESWEEP_RADIX,
    ).toAtomic();
    const partitionIndices = storage(
      this.#partitionIndexAttribute,
      'uint',
      this.#passCount,
    ).toAtomic();
    const scratchSize = Math.max(
      ONESWEEP_PARTITION_SIZE,
      this.#maxSubgroups * ONESWEEP_RADIX,
    );
    const scratch = namedWorkgroupArray('uint', scratchSize, `SOGOneSweepScratch${pass}`);
    const digitBase = namedWorkgroupArray('uint', ONESWEEP_RADIX, `SOGOneSweepDigitBase${pass}`);
    const subgroupTotals = namedWorkgroupArray(
      'uint',
      this.#maxSubgroups,
      `SOGOneSweepSubgroupTotals${pass}`,
    );
    const workgroupPartition = namedWorkgroupArray('uint', 1, `SOGOneSweepPartition${pass}`);
    const count = uint(this.count);
    const threadBlocks = uint(this.#threadBlocks);
    const passNode = uint(pass);
    const currentBit = uint(pass * ONESWEEP_RADIX_BITS);
    const isFirstPass = pass === 0;

    const node = Fn(() => {
      const local = invocationLocalIndex.toVar();
      const wave = subgroupIndex.toVar();
      const lane = invocationSubgroupIndex.toVar();
      const runtimeSubgroupSize = subgroupSize.toVar();
      const offsets = (array('uint', ONESWEEP_KEYS_PER_INVOCATION) as any).toVar();
      const linearDigits = (array('uint', ONESWEEP_KEYS_PER_INVOCATION) as any).toVar();
      const validMask = uint(0).toVar();

      If(local.equal(uint(0)), () => {
        workgroupPartition.element(uint(0)).assign(
          atomicAdd(partitionIndices.element(passNode), uint(1)),
        );
      });
      workgroupBarrier();
      const partition = workgroupPartition.element(uint(0)).toVar();

      Loop(
        { start: local, end: this.#maxSubgroups * ONESWEEP_RADIX, type: 'uint', condition: '<', update: ONESWEEP_WORKGROUP_SIZE },
        ({ i }) => {
          scratch.element(i).assign(uint(0));
        },
      );
      If(local.lessThan(uint(this.#maxSubgroups)), () => {
        subgroupTotals.element(local).assign(uint(0));
      });
      workgroupBarrier();

      const tileStart = partition.mul(uint(ONESWEEP_PARTITION_SIZE)).toVar();
      const validInBlock = uint(0).toVar();
      If(tileStart.lessThan(count), () => {
        validInBlock.assign(uint(min(
          count.sub(tileStart) as any,
          uint(ONESWEEP_PARTITION_SIZE) as any,
        ) as any));
      });
      const subgroupPartitionSize = runtimeSubgroupSize.mul(uint(ONESWEEP_KEYS_PER_INVOCATION)).toVar();
      const waveBase = tileStart.add(wave.mul(subgroupPartitionSize)).toVar();
      const lessThanLaneMask = uint(1).shiftLeft(lane).sub(uint(1)).toVar();

      for (let round = 0; round < ONESWEEP_KEYS_PER_INVOCATION; round += 1) {
        const sourceIndex = waveBase.add(lane).add(runtimeSubgroupSize.mul(uint(round))).toVar();
        const isValid = sourceIndex.lessThan(count).toVar();
        const key = uint(0xffff_ffff).toVar();
        If(isValid, () => {
          key.assign(inputKeys.element(sourceIndex));
          validMask.bitOrAssign(uint(1 << round));
        });
        const digit = key.shiftRight(currentBit).bitAnd(uint(0xff)).toVar();
        const waveFlag = uint(0xffff_ffff).toVar();
        for (let bit = 0; bit < ONESWEEP_RADIX_BITS; bit += 1) {
          const bitSet = digit.shiftRight(uint(bit)).bitAnd(uint(1)).equal(uint(1)).toVar();
          const ballot = (subgroupBallot(bitSet) as any).x;
          If(bitSet, () => {
            waveFlag.bitAndAssign(ballot);
          }).Else(() => {
            waveFlag.bitAndAssign(ballot.bitNot());
          });
        }
        const validBallot = (subgroupBallot(isValid) as any).x;
        waveFlag.bitAndAssign(validBallot);
        const peerBits = bitCount(waveFlag.bitAnd(lessThanLaneMask)).toVar();
        const totalBits = bitCount(waveFlag).toVar();
        const leader = trailingZeroCount(waveFlag).toVar();
        const preIncrement = uint(0).toVar();
        If(isValid.and(peerBits.equal(uint(0))), () => {
          const histogramIndex = wave.mul(uint(ONESWEEP_RADIX)).add(digit).toVar();
          preIncrement.assign(scratch.element(histogramIndex));
          scratch.element(histogramIndex).addAssign(totalBits);
        });
        offsets.element(uint(round)).assign(
          subgroupUint(subgroupShuffle(preIncrement, leader)).add(peerBits),
        );
        workgroupBarrier();
      }

      const blockDigitCount = scratch.element(local).toVar();
      const histogramReduction = blockDigitCount.toVar();
      for (let waveIndex = 1; waveIndex < this.#maxSubgroups; waveIndex += 1) {
        const histogramIndex = uint(waveIndex * ONESWEEP_RADIX).add(local).toVar();
        const amount = scratch.element(histogramIndex).toVar();
        scratch.element(histogramIndex).assign(histogramReduction);
        histogramReduction.addAssign(amount);
      }

      If(partition.add(uint(1)).lessThan(threadBlocks), () => {
        const destination = passNode.mul(threadBlocks).add(partition.add(uint(1)))
          .mul(uint(ONESWEEP_RADIX)).add(local);
        atomicAdd(
          passHistogram.element(destination),
          histogramReduction.shiftLeft(uint(2)).bitOr(uint(FLAG_REDUCTION)),
        );
      });

      const subgroupExclusive = subgroupUint(subgroupExclusiveAdd(histogramReduction)).toVar();
      const subgroupTotal = subgroupUint(subgroupAdd(histogramReduction)).toVar();
      If(lane.equal(uint(0)), () => {
        subgroupTotals.element(wave).assign(subgroupTotal);
      });
      workgroupBarrier();
      If(local.equal(uint(0)), () => {
        const accumulator = uint(0).toVar();
        Loop({ start: 0, end: this.#maxSubgroups, type: 'uint', condition: '<' }, ({ i }) => {
          const amount = subgroupTotals.element(i).toVar();
          subgroupTotals.element(i).assign(accumulator);
          accumulator.addAssign(amount);
        });
      });
      workgroupBarrier();
      const myDigitBase = subgroupExclusive.add(subgroupTotals.element(wave)).toVar();
      digitBase.element(local).assign(myDigitBase);
      workgroupBarrier();

      for (let round = 0; round < ONESWEEP_KEYS_PER_INVOCATION; round += 1) {
        const sourceIndex = waveBase.add(lane).add(runtimeSubgroupSize.mul(uint(round))).toVar();
        If(sourceIndex.lessThan(count), () => {
          const digit = inputKeys.element(sourceIndex).shiftRight(currentBit).bitAnd(uint(0xff)).toVar();
          const wavePrefix = uint(0).toVar();
          If(wave.greaterThan(uint(0)), () => {
            wavePrefix.assign(scratch.element(wave.mul(uint(ONESWEEP_RADIX)).add(digit)));
          });
          offsets.element(uint(round)).addAssign(wavePrefix.add(digitBase.element(digit)));
        });
      }
      workgroupBarrier();

      const lookbackReduction = uint(0).toVar();
      const lookbackPartition = partition.toVar();
      const done = bool(false).toVar();
      (Loop as any)(done.not(), () => {
        const source = passNode.mul(threadBlocks).add(lookbackPartition)
          .mul(uint(ONESWEEP_RADIX)).add(local);
        const payload = atomicLoad(passHistogram.element(source)).toVar();
        const flag = payload.bitAnd(uint(FLAG_MASK)).toVar();
        If(flag.equal(uint(FLAG_INCLUSIVE)), () => {
          lookbackReduction.addAssign(payload.shiftRight(uint(2)));
          If(partition.add(uint(1)).lessThan(threadBlocks), () => {
            const destination = passNode.mul(threadBlocks).add(partition.add(uint(1)))
              .mul(uint(ONESWEEP_RADIX)).add(local);
            atomicAdd(
              passHistogram.element(destination),
              uint(1).bitOr(lookbackReduction.shiftLeft(uint(2))),
            );
          });
          digitBase.element(local).assign(lookbackReduction.sub(myDigitBase));
          done.assign(bool(true));
        }).ElseIf(flag.equal(uint(FLAG_REDUCTION)), () => {
          lookbackReduction.addAssign(payload.shiftRight(uint(2)));
          If(lookbackPartition.equal(uint(0)), () => {
            done.assign(bool(true));
          }).Else(() => {
            lookbackPartition.subAssign(uint(1));
          });
        });
      });
      workgroupBarrier();

      for (let round = 0; round < ONESWEEP_KEYS_PER_INVOCATION; round += 1) {
        const sourceIndex = waveBase.add(lane).add(runtimeSubgroupSize.mul(uint(round))).toVar();
        If(sourceIndex.lessThan(count), () => {
          scratch.element(offsets.element(uint(round))).assign(inputKeys.element(sourceIndex));
        });
      }
      workgroupBarrier();

      for (let round = 0; round < ONESWEEP_KEYS_PER_INVOCATION; round += 1) {
        const linearIndex = local.add(uint(round * ONESWEEP_WORKGROUP_SIZE)).toVar();
        If(tileStart.lessThan(count).and(linearIndex.lessThan(validInBlock)), () => {
          const key = scratch.element(linearIndex).toVar();
          const digit = key.shiftRight(currentBit).bitAnd(uint(0xff)).toVar();
          linearDigits.element(uint(round)).assign(digit);
          const destination = digitBase.element(digit).add(linearIndex).toVar();
          outputKeys.element(destination).assign(key);
        });
      }
      workgroupBarrier();

      for (let round = 0; round < ONESWEEP_KEYS_PER_INVOCATION; round += 1) {
        const sourceIndex = waveBase.add(lane).add(runtimeSubgroupSize.mul(uint(round))).toVar();
        If(sourceIndex.lessThan(count), () => {
          scratch.element(offsets.element(uint(round))).assign(
            isFirstPass ? sourceIndex : inputValues!.element(sourceIndex),
          );
        });
      }
      workgroupBarrier();

      for (let round = 0; round < ONESWEEP_KEYS_PER_INVOCATION; round += 1) {
        const linearIndex = local.add(uint(round * ONESWEEP_WORKGROUP_SIZE)).toVar();
        If(tileStart.lessThan(count).and(linearIndex.lessThan(validInBlock)), () => {
          const digit = linearDigits.element(uint(round)).toVar();
          const destination = digitBase.element(digit).add(linearIndex).toVar();
          outputValues.element(destination).assign(scratch.element(linearIndex));
        });
      }
    })().compute(this.#threadBlocks * ONESWEEP_WORKGROUP_SIZE, [ONESWEEP_WORKGROUP_SIZE]);
    node.setName(`SOG OneSweep fused binning pass ${pass}`);
    return node;
  }
}
