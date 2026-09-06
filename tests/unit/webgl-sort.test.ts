import { Matrix4 } from 'three/webgpu';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebGLSortBackend } from '../../src/render/sort/WebGLSortBackend.js';

interface PostedMessage {
  readonly type: 'initialize' | 'sort';
  readonly generation?: number;
}

interface SortResult {
  readonly type: 'sorted';
  readonly generation: number;
  readonly durationMs: number;
  readonly order: ArrayBuffer;
}

class FakeWorker {
  static readonly instances: FakeWorker[] = [];
  readonly messages: PostedMessage[] = [];
  onmessage: ((event: MessageEvent<SortResult>) => void) | null = null;

  constructor() { FakeWorker.instances.push(this); }
  postMessage(message: PostedMessage): void { this.messages.push(message); }
  terminate(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}

  emit(result: SortResult): void {
    this.onmessage?.({ data: result } as MessageEvent<SortResult>);
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeWorker.instances.length = 0;
});

describe('WebGLSortBackend worker scheduling', () => {
  it('keeps one sort in flight and dispatches only the latest pending camera', () => {
    vi.stubGlobal('Worker', FakeWorker);
    const onSort = vi.fn();
    const onUpload = vi.fn();
    const sorter = new WebGLSortBackend(
      new Float32Array([0, 0, 0, 1, 0, 0]),
      { onSort, onUpload },
    );
    const worker = FakeWorker.instances[0]!;
    expect(worker.messages.map((message) => message.type)).toEqual(['initialize']);

    sorter.update(new Matrix4().makeTranslation(0, 0, -1));
    sorter.update(new Matrix4().makeTranslation(0, 0, -2));
    sorter.update(new Matrix4().makeTranslation(0, 0, -3));
    expect(worker.messages).toHaveLength(2);
    expect(worker.messages[1]).toMatchObject({ type: 'sort', generation: 1 });

    worker.emit({
      type: 'sorted',
      generation: 1,
      durationMs: 2,
      order: Uint32Array.of(1, 0).buffer,
    });
    expect(worker.messages).toHaveLength(3);
    expect(worker.messages[2]).toMatchObject({ type: 'sort', generation: 3 });
    expect(onSort).toHaveBeenCalledWith(2);
    expect([...sorter.orderAttribute.array]).toEqual([1, 0]);

    worker.emit({
      type: 'sorted',
      generation: 3,
      durationMs: 4,
      order: Uint32Array.of(0, 1).buffer,
    });
    expect([...sorter.orderAttribute.array]).toEqual([0, 1]);
    expect(onSort).toHaveBeenCalledTimes(2);
    expect(onSort).toHaveBeenCalledWith(4);
    expect(onUpload).toHaveBeenCalledTimes(2);
    sorter.dispose();
  });
});

it('continues uploading completed orders while the camera outpaces the worker', () => {
  vi.stubGlobal('Worker', FakeWorker);
  const onUpload = vi.fn();
  const sorter = new WebGLSortBackend(new Float32Array([0, 0, 0, 1, 0, 0]), { onSort: vi.fn(), onUpload });
  const worker = FakeWorker.instances[0]!;
  for (let frame = 1; frame <= 10; frame += 1) {
    sorter.update(new Matrix4().makeRotationY(frame * 0.2));
    if (frame % 2 === 0) {
      const message = worker.messages.filter((entry) => entry.type === 'sort').at(-1)!;
      worker.emit({ type: 'sorted', generation: message.generation!, durationMs: 25, order: Uint32Array.of(1, 0).buffer });
    }
  }
  expect(onUpload).toHaveBeenCalledTimes(5);
  expect([...sorter.orderAttribute.array]).toEqual([1, 0]);
  sorter.dispose();
  worker.emit({ type: 'sorted', generation: 99, durationMs: 25, order: Uint32Array.of(0, 1).buffer });
  expect(onUpload).toHaveBeenCalledTimes(5);
});
