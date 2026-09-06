/// <reference lib="webworker" />

import { createDepthKeys } from '../render/sort/depth.js';
import { radixSortKeyValues, RadixSortWorkspace } from '../render/sort/radix.js';

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
let workspace = new RadixSortWorkspace(0);

self.onmessage = (event: MessageEvent<InitializeMessage | SortMessage>) => {
  if (event.data.type === 'initialize') {
    centers = new Float32Array(event.data.centers);
    workspace = new RadixSortWorkspace(centers.length / 3);
    self.postMessage({ type: 'initialized' });
    return;
  }
  const startedAt = performance.now();
  const matrix = { elements: event.data.matrix };
  const keys = createDepthKeys(centers, matrix, workspace.readKeys);
  const sorted = radixSortKeyValues(keys, undefined, 32, 8, workspace).values;
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
