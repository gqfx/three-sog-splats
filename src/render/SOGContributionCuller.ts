/*
 * Contribution metric follows PlayCanvas Engine's GPU-sort gsplat projector:
 * https://github.com/playcanvas/engine/pull/8869
 * Compaction is intentionally stable because SOG alpha blending consumes an
 * already-sorted logical draw order shared by translated runtime copies.
 */
import {
  IndirectStorageBufferAttribute,
  StorageBufferAttribute,
  Vector2,
} from 'three/webgpu';
import type { ComputeNode, WebGPURenderer } from 'three/webgpu';
import {
  Fn,
  If,
  Loop,
  abs,
  float,
  instanceIndex,
  invocationLocalIndex,
  storage,
  uint,
  uniform,
  workgroupArray,
  workgroupBarrier,
  workgroupId,
} from 'three/tsl';
import type { SOGContributionCullingStats } from '../core/types.js';
import {
  DEFAULT_CONTRIBUTION_CULL_THRESHOLD,
  DEFAULT_SPLAT_ALPHA_CUTOFF,
} from './contribution.js';
import type { SOGProjectedBuffers } from './material.js';

type SOGProjectedInputs = Omit<SOGProjectedBuffers, 'visibleIndices'>;

const WORKGROUP_SIZE = 256;
const CULL_REASON_COUNT = 4;
const INDEXED_INDIRECT_WORDS = 5;
const QUAD_INDEX_COUNT = 6;

interface ScanLevel {
  readonly attribute: StorageBufferAttribute;
  readonly count: number;
}

function createUintAttribute(count: number): StorageBufferAttribute {
  return new StorageBufferAttribute(new Uint32Array(Math.max(1, count)), 1);
}

function attributeBytes(attribute: StorageBufferAttribute): number {
  return attribute.count * attribute.itemSize * Uint32Array.BYTES_PER_ELEMENT;
}

function namedWorkgroupArray(type: string, count: number, name: string): any {
  const result = workgroupArray(type, count);
  (result as any).setName(name);
  return result;
}

function upperScanSizes(count: number): number[] {
  const result: number[] = [];
  let childCount = Math.max(1, count);
  while (childCount > WORKGROUP_SIZE) {
    childCount = Math.ceil(childCount / WORKGROUP_SIZE);
    result.push(childCount);
  }
  return result;
}

function classifyProjectedSplat(
  projected: SOGProjectedInputs,
  orderAttribute: StorageBufferAttribute,
  logicalIndex: any,
  viewport: any,
  threshold: any,
  enabled: any,
): any {
  const centers = storage(projected.centers, 'vec4', projected.logicalCount).toReadOnly();
  const ellipses = storage(projected.ellipses, 'vec4', projected.logicalCount).toReadOnly();
  const colors = storage(projected.colors, 'uint', projected.logicalCount).toReadOnly();
  const order = storage(orderAttribute, 'uint', projected.logicalCount).toReadOnly();
  const projectedIndex = order.element(logicalIndex);
  const centerClip = centers.element(projectedIndex).toVar();
  const packedEllipse = ellipses.element(projectedIndex);
  const ellipseX = packedEllipse.xy;
  const ellipseY = packedEllipse.zw;
  const packedColor = colors.element(projectedIndex);
  const opacity = float(packedColor.shiftRight(uint(24)).bitAnd(uint(0xff))).div(255);
  const reason = uint(0).toVar();

  If(enabled.equal(uint(1)), () => {
    If(
      centerClip.w.lessThanEqual(0)
        .or(opacity.lessThan(float(DEFAULT_SPLAT_ALPHA_CUTOFF))),
      () => {
        reason.assign(uint(1));
      },
    ).Else(() => {
      const centerNdc: any = centerClip.xy.div(centerClip.w);
      const extentNdc: any = abs(ellipseX).add(abs(ellipseY)).mul(2);
      If(
        centerNdc.x.add(extentNdc.x).lessThan(-1)
          .or(centerNdc.x.sub(extentNdc.x).greaterThan(1))
          .or(centerNdc.y.add(extentNdc.y).lessThan(-1))
          .or(centerNdc.y.sub(extentNdc.y).greaterThan(1)),
        () => {
          reason.assign(uint(2));
        },
      ).Else(() => {
        const ellipseDeterminantNdc = abs(
          ellipseX.x.mul(ellipseY.y).sub(ellipseX.y.mul(ellipseY.x)),
        );
        const covarianceAreaPixels = ellipseDeterminantNdc
          .mul(viewport.x)
          .mul(viewport.y)
          .mul(0.25);
        const contribution = opacity.mul(2 * Math.PI).mul(covarianceAreaPixels);
        If(contribution.lessThan(threshold), () => {
          reason.assign(uint(3));
        });
      });
    });
  });
  return reason;
}

/** GPU-only stable visibility compaction and indexed-indirect draw command. */
export class SOGContributionCuller {
  readonly logicalCount: number;
  readonly allocatedBytes: number;
  readonly visibleIndices: StorageBufferAttribute;
  readonly indirectAttribute: IndirectStorageBufferAttribute;
  readonly #projected: SOGProjectedInputs;
  readonly #orderAttribute: StorageBufferAttribute;
  readonly #blockCount: number;
  readonly #blockCounts: StorageBufferAttribute;
  readonly #blockStats: StorageBufferAttribute;
  readonly #stats: StorageBufferAttribute;
  readonly #scanLevels: readonly ScanLevel[];
  readonly #computeNodes: readonly ComputeNode[];
  readonly #viewport = uniform(new Vector2(1, 1));
  readonly #threshold = uniform(DEFAULT_CONTRIBUTION_CULL_THRESHOLD);
  readonly #enabled = uniform(1, 'uint');
  readonly #drawLimit: any;
  #disposed = false;

  constructor(
    projected: SOGProjectedInputs,
    orderAttribute: StorageBufferAttribute,
  ) {
    this.#projected = projected;
    this.#orderAttribute = orderAttribute;
    this.logicalCount = projected.logicalCount;
    this.#blockCount = Math.max(1, Math.ceil(this.logicalCount / WORKGROUP_SIZE));
    this.visibleIndices = createUintAttribute(this.logicalCount);
    this.indirectAttribute = new IndirectStorageBufferAttribute(
      new Uint32Array([QUAD_INDEX_COUNT, this.logicalCount, 0, 0, 0]),
      1,
    );
    this.indirectAttribute.needsUpdate = true;
    this.#blockCounts = createUintAttribute(this.#blockCount);
    this.#blockStats = createUintAttribute(this.#blockCount * CULL_REASON_COUNT);
    this.#stats = createUintAttribute(5);
    this.#drawLimit = uniform(this.logicalCount, 'uint');
    this.#scanLevels = [
      { attribute: this.#blockCounts, count: this.#blockCount },
      ...upperScanSizes(this.#blockCount).map((count) => ({
        count,
        attribute: createUintAttribute(count),
      })),
    ];
    this.#computeNodes = this.#buildComputeNodes();
    this.allocatedBytes = attributeBytes(this.visibleIndices)
      + attributeBytes(this.indirectAttribute)
      + attributeBytes(this.#blockStats)
      + attributeBytes(this.#stats)
      + this.#scanLevels.reduce(
        (total, level) => total + attributeBytes(level.attribute),
        0,
      );
  }

  setViewport(width: number, height: number): void {
    this.#viewport.value.set(Math.max(1, width), Math.max(1, height));
  }

  setThreshold(value: number): void {
    this.#threshold.value = value;
  }

  setEnabled(value: boolean): void {
    this.#enabled.value = value ? 1 : 0;
  }

  setDrawLimit(value: number): void {
    this.#drawLimit.value = Math.max(0, Math.min(this.logicalCount, Math.floor(value)));
  }

  compute(renderer: WebGPURenderer): void {
    if (this.logicalCount > 0) renderer.compute(this.#computeNodes as ComputeNode[]);
  }

  async computeAsync(renderer: WebGPURenderer): Promise<void> {
    if (this.logicalCount > 0) await renderer.computeAsync(this.#computeNodes as ComputeNode[]);
  }

  async readStatsAsync(renderer: WebGPURenderer): Promise<SOGContributionCullingStats> {
    const buffer = await renderer.getArrayBufferAsync(this.#stats);
    const values = new Uint32Array(buffer);
    return {
      submitted: values[0] ?? 0,
      visible: values[1] ?? 0,
      behindOrAlpha: values[2] ?? 0,
      outsideFrustum: values[3] ?? 0,
      lowContribution: values[4] ?? 0,
    };
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const node of this.#computeNodes) node.dispose();
    this.visibleIndices.dispose();
    this.indirectAttribute.dispose();
    this.#blockStats.dispose();
    this.#stats.dispose();
    for (const level of this.#scanLevels) level.attribute.dispose();
  }

  #buildComputeNodes(): ComputeNode[] {
    return [
      this.#createClassificationNode(),
      this.#createStatsReductionNode(),
      ...this.#createScanNodes(),
      this.#createScatterNode(),
    ];
  }

  #createClassificationNode(): ComputeNode {
    const blockCounts = storage(this.#blockCounts, 'uint', this.#blockCount);
    const blockStats = storage(
      this.#blockStats,
      'uint',
      this.#blockCount * CULL_REASON_COUNT,
    );
    const sharedReasons = namedWorkgroupArray(
      'uint',
      WORKGROUP_SIZE,
      'SOGContributionCullReasons',
    );
    const sharedVisible = namedWorkgroupArray(
      'uint',
      WORKGROUP_SIZE,
      'SOGContributionCullVisibleReduction',
    );
    const node = Fn(() => {
      const local = invocationLocalIndex.toVar();
      const index = instanceIndex.toVar();
      const group = workgroupId.x.toVar();
      const reason = uint(CULL_REASON_COUNT).toVar();
      If(index.lessThan(this.#drawLimit), () => {
        reason.assign(classifyProjectedSplat(
          this.#projected,
          this.#orderAttribute,
          index,
          this.#viewport,
          this.#threshold,
          this.#enabled,
        ));
      });
      sharedReasons.element(local).assign(reason);
      sharedVisible.element(local).assign(reason.equal(uint(0)).select(uint(1), uint(0)));
      workgroupBarrier();

      for (let offset = WORKGROUP_SIZE / 2; offset >= 1; offset /= 2) {
        If(local.lessThan(uint(offset)), () => {
          sharedVisible.element(local).addAssign(sharedVisible.element(local.add(uint(offset))));
        });
        workgroupBarrier();
      }
      If(local.equal(uint(0)), () => {
        blockCounts.element(group).assign(sharedVisible.element(uint(0)));
      });
      If(local.lessThan(uint(CULL_REASON_COUNT)), () => {
        const amount = uint(0).toVar();
        Loop({ start: 0, end: WORKGROUP_SIZE, type: 'uint', condition: '<' }, ({ i }) => {
          If(sharedReasons.element(i).equal(local), () => {
            amount.addAssign(uint(1));
          });
        });
        blockStats.element(group.mul(uint(CULL_REASON_COUNT)).add(local)).assign(amount);
      });
    })().compute(this.#blockCount * WORKGROUP_SIZE, [WORKGROUP_SIZE]);
    node.setName('SOG contribution cull classification and block counts');
    return node;
  }

  #createStatsReductionNode(): ComputeNode {
    const blockStats = storage(
      this.#blockStats,
      'uint',
      this.#blockCount * CULL_REASON_COUNT,
    ).toReadOnly();
    const stats = storage(this.#stats, 'uint', 5);
    const node = Fn(() => {
      const total = uint(0).toVar();
      Loop({ start: 0, end: this.#blockCount, type: 'uint', condition: '<' }, ({ i }) => {
        total.addAssign(blockStats.element(
          i.mul(uint(CULL_REASON_COUNT)).add(instanceIndex),
        ));
      });
      stats.element(instanceIndex.add(uint(1))).assign(total);
      If(instanceIndex.equal(uint(0)), () => {
        stats.element(uint(0)).assign(this.#drawLimit);
      });
    })().compute(CULL_REASON_COUNT, [CULL_REASON_COUNT]);
    node.setName('SOG contribution cull reason counter reduction');
    return node;
  }

  #createScanNodes(): ComputeNode[] {
    const nodes: ComputeNode[] = [];
    for (let levelIndex = 0; levelIndex < this.#scanLevels.length; levelIndex += 1) {
      nodes.push(this.#createBlellochNode(
        this.#scanLevels[levelIndex]!,
        this.#scanLevels[levelIndex + 1],
        levelIndex,
      ));
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

  #createBlellochNode(
    level: ScanLevel,
    next: ScanLevel | undefined,
    levelIndex: number,
  ): ComputeNode {
    const groupCount = Math.ceil(level.count / WORKGROUP_SIZE);
    const values = storage(level.attribute, 'uint', level.count);
    const totals = next ? storage(next.attribute, 'uint', next.count) : null;
    const shared = namedWorkgroupArray(
      'uint',
      WORKGROUP_SIZE,
      `SOGContributionCullScan${levelIndex}`,
    );
    const node = Fn(() => {
      const local = invocationLocalIndex.toVar();
      const entry = workgroupId.x.mul(uint(WORKGROUP_SIZE)).add(local).toVar();
      const value = uint(0).toVar();
      If(entry.lessThan(uint(level.count)), () => {
        value.assign(values.element(entry));
      });
      shared.element(local).assign(value);
      workgroupBarrier();

      for (let offset = 1; offset < WORKGROUP_SIZE; offset *= 2) {
        const target = local.add(uint(1)).mul(uint(offset * 2)).sub(uint(1)).toVar();
        If(target.lessThan(uint(WORKGROUP_SIZE)), () => {
          shared.element(target).addAssign(shared.element(target.sub(uint(offset))));
        });
        workgroupBarrier();
      }
      If(local.equal(uint(WORKGROUP_SIZE - 1)), () => {
        if (totals) totals.element(workgroupId.x).assign(shared.element(local));
        shared.element(local).assign(uint(0));
      });
      workgroupBarrier();

      for (let offset = WORKGROUP_SIZE / 2; offset >= 1; offset /= 2) {
        const target = local.add(uint(1)).mul(uint(offset * 2)).sub(uint(1)).toVar();
        If(target.lessThan(uint(WORKGROUP_SIZE)), () => {
          const previous = shared.element(target.sub(uint(offset))).toVar();
          shared.element(target.sub(uint(offset))).assign(shared.element(target));
          shared.element(target).addAssign(previous);
        });
        workgroupBarrier();
      }
      If(entry.lessThan(uint(level.count)), () => {
        values.element(entry).assign(shared.element(local));
      });
    })().compute(groupCount * WORKGROUP_SIZE, [WORKGROUP_SIZE]);
    node.setName(`SOG contribution cull block scan level ${levelIndex}`);
    return node;
  }

  #createPrefixAddNode(
    child: ScanLevel,
    parent: ScanLevel,
    levelIndex: number,
  ): ComputeNode {
    const childValues = storage(child.attribute, 'uint', child.count);
    const parentValues = storage(parent.attribute, 'uint', parent.count).toReadOnly();
    const node = Fn(() => {
      childValues.element(instanceIndex).addAssign(
        parentValues.element(instanceIndex.div(uint(WORKGROUP_SIZE))),
      );
    })().compute(child.count, [WORKGROUP_SIZE]);
    node.setName(`SOG contribution cull scan prefix add level ${levelIndex}`);
    return node;
  }

  #createScatterNode(): ComputeNode {
    const blockPrefixes = storage(this.#blockCounts, 'uint', this.#blockCount).toReadOnly();
    const visibleIndices = storage(
      this.visibleIndices,
      'uint',
      Math.max(1, this.logicalCount),
    );
    const indirect = storage(
      this.indirectAttribute,
      'uint',
      INDEXED_INDIRECT_WORDS,
    );
    const sharedVisible = namedWorkgroupArray(
      'uint',
      WORKGROUP_SIZE,
      'SOGContributionCullLocalScan',
    );
    const sharedTotal = namedWorkgroupArray(
      'uint',
      1,
      'SOGContributionCullLocalTotal',
    );
    const node = Fn(() => {
      const local = invocationLocalIndex.toVar();
      const index = instanceIndex.toVar();
      const group = workgroupId.x.toVar();
      const visible = uint(0).toVar();
      If(index.lessThan(this.#drawLimit), () => {
        const reason = classifyProjectedSplat(
          this.#projected,
          this.#orderAttribute,
          index,
          this.#viewport,
          this.#threshold,
          this.#enabled,
        );
        If(reason.equal(uint(0)), () => {
          visible.assign(uint(1));
        });
      });
      sharedVisible.element(local).assign(visible);
      workgroupBarrier();

      for (let offset = 1; offset < WORKGROUP_SIZE; offset *= 2) {
        const target = local.add(uint(1)).mul(uint(offset * 2)).sub(uint(1)).toVar();
        If(target.lessThan(uint(WORKGROUP_SIZE)), () => {
          sharedVisible.element(target).addAssign(sharedVisible.element(target.sub(uint(offset))));
        });
        workgroupBarrier();
      }
      If(local.equal(uint(WORKGROUP_SIZE - 1)), () => {
        sharedTotal.element(uint(0)).assign(sharedVisible.element(local));
        sharedVisible.element(local).assign(uint(0));
      });
      workgroupBarrier();

      for (let offset = WORKGROUP_SIZE / 2; offset >= 1; offset /= 2) {
        const target = local.add(uint(1)).mul(uint(offset * 2)).sub(uint(1)).toVar();
        If(target.lessThan(uint(WORKGROUP_SIZE)), () => {
          const previous = sharedVisible.element(target.sub(uint(offset))).toVar();
          sharedVisible.element(target.sub(uint(offset))).assign(sharedVisible.element(target));
          sharedVisible.element(target).addAssign(previous);
        });
        workgroupBarrier();
      }
      If(visible.equal(uint(1)), () => {
        visibleIndices.element(
          blockPrefixes.element(group).add(sharedVisible.element(local)),
        ).assign(index);
      });
      If(group.equal(uint(this.#blockCount - 1)).and(local.equal(uint(0))), () => {
        indirect.element(uint(0)).assign(uint(QUAD_INDEX_COUNT));
        indirect.element(uint(1)).assign(
          blockPrefixes.element(group).add(sharedTotal.element(uint(0))),
        );
        indirect.element(uint(2)).assign(uint(0));
        indirect.element(uint(3)).assign(uint(0));
        indirect.element(uint(4)).assign(uint(0));
      });
    })().compute(this.#blockCount * WORKGROUP_SIZE, [WORKGROUP_SIZE]);
    node.setName('SOG stable visible-index scatter and indexed indirect args');
    return node;
  }
}
