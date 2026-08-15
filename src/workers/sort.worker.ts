/// <reference lib="webworker" />

import { Matrix4 } from 'three/webgpu';
import { createDepthKeys } from '../render/sort/depth.js';
import { radixSortIndices } from '../render/sort/radix.js';

type InitializeMessage = {
  type: 'initialize';
  centers: ArrayBuffer;
};

type SortMessage = {
  type: 'sort';
  generation: number;
  matrix: number[];
  recycle?: ArrayBuffer;
};

let centers = new Float32Array();

self.onmessage = (event: MessageEvent<InitializeMessage | SortMessage>) => {
  if (event.data.type === 'initialize') {
    centers = new Float32Array(event.data.centers);
    self.postMessage({ type: 'initialized' });
    return;
  }
  const startedAt = performance.now();
  const matrix = new Matrix4().fromArray(event.data.matrix);
  const sorted = radixSortIndices(createDepthKeys(centers, matrix));
  const order = event.data.recycle && event.data.recycle.byteLength === sorted.byteLength
    ? new Uint32Array(event.data.recycle)
    : new Uint32Array(sorted.length);
  order.set(sorted);
  self.postMessage({
    type: 'sorted',
    generation: event.data.generation,
    durationMs: performance.now() - startedAt,
    order: order.buffer,
  }, { transfer: [order.buffer] });
};

export {};
