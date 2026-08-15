[English](./README.md) | 简体中文

# three-sog-splats

面向 Three.js r184-r185 的原生 bundled SOG v2 高斯泼溅加载与渲染库。它
保留 SOG WebP 属性图和 codebook，不会先把完整高斯属性展开成 CPU 数组。

## 兼容约定

- 最低支持 `three@0.184.0`；r184 与 r185 均通过真实浏览器 WebGPU 和强制
  WebGL 测试。peer 范围是 `>=0.184.0 <0.186.0`。
- 开发依赖仍精确固定为 `three@0.185.0`，避免上游变化被静默带入。
- 使用 `three/webgpu` 导出的 `WebGPURenderer`。WebGPU 是主路径；该渲染器
  的强制 WebGL backend 是回退路径。
- 经典 `WebGLRenderer` 不在 MVP 范围内，会返回带错误码的明确错误。
- TypeScript 消费者还需安装与运行时版本匹配的 `@types/three`，因为 Three.js
  运行时包本身不附带这套声明。

Three.js 由应用提供且不会被打包。`fflate` 是 ZIP 解析依赖。PlayCanvas
Engine 与本地 `potree-engine` 只用于设计参考，不是运行时依赖，也不会进入
发布产物。

## 安装

```bash
npm install three@0.185.0 three-sog-splats
npm install --save-dev @types/three@0.185.0
```

## 使用

```ts
import { PerspectiveCamera, Scene, WebGPURenderer } from 'three/webgpu';
import { SOGGaussianSplatMesh, SOGLoader } from 'three-sog-splats';

const renderer = new WebGPURenderer({ antialias: true });
const scene = new Scene();
const camera = new PerspectiveCamera(60, innerWidth / innerHeight, 0.01, 1_000);

const controller = new AbortController();
const resource = await new SOGLoader().loadAsync('/scene.sog', {
  signal: controller.signal,
  onProgress: (loaded, total) => console.log(loaded, total),
});
const splats = new SOGGaussianSplatMesh(resource);

// 在对象可见前完成源纹理、codebook、排序资源、首次排序和精确变体编译。
await splats.prepare(renderer, { signal: controller.signal });
scene.add(splats);
renderer.setAnimationLoop(() => renderer.render(scene, camera));

// 不再使用时：
scene.remove(splats);
splats.dispose();
resource.dispose();
```

给 `WebGPURenderer` 传入 `{ forceWebGL: true }` 可使用回退路径。该路径每个
原生资源只异步回读一次 `center.xyz`，在可转移 Worker 中排序，仅上传实例
顺序；旋转、缩放、颜色、不透明度和 SH 始终留在 GPU。WebGPU 路径则在
GPU storage buffer 内生成 key、排序和消费顺序，不回读 center、key 或 order。

同一个 `SOGLoader` 发起的等价并发请求会合并。每个调用者得到独立资源租约；
取消一个调用者不会影响其他消费者，只有最后一个消费者退出才中止共享操作。

渲染器/设备在初始化阶段丢失时，`prepare()` 会以 `PREPARATION_FAILED` 失败并
清理半成品资源。已准备渲染器发生 device loss 后，应 dispose 旧 mesh，待应用
替换或恢复 renderer 后重新创建并 prepare mesh。

## 公共 API

- `SOGLoader.loadAsync(url, options)`：加载单个 bundled `.sog` v2 包。
- `SOGResource`：提供只读 metadata、bounds、原生图片、SH bands、加载诊断、
  clone 和幂等 dispose。
- `SOGGaussianSplatMesh`：普通 Three.js Mesh，支持显式异步 `prepare()`、场景
  transform、单个全资源 active range、渲染诊断和幂等 dispose。
- `SOGError`：提供 `ABORTED`、`INVALID_ARCHIVE`、`INVALID_METADATA`、
  `UNSUPPORTED_RENDERER`、`RENDERER_MISMATCH` 等稳定错误码。
- options、state、metadata、bounds、diagnostics 和 disposal 类型均从包根导出。

加载诊断包含各阶段耗时、下载字节、ZIP 条目数、解码图片数、splat 数、临时
保留内存和失败阶段。渲染诊断包含 backend、upload/compile/prepare/首帧/sort
耗时、sort/upload/readback 计数、active count、GPU 分配估算和状态。

## MVP 限制与非目标

每个 bundled 资源强制上限为 2,000,000 splats。规划估算为每个 splat 52 个
GPU 字节，上限时约 104 MB；这还不含渲染器、解码图片、framebuffer 和浏览器
开销。它是内存护栏，不是所有设备上的性能承诺，生产资源需在目标 GPU 实测。

MVP 支持单个全资源 active range、SOG v2 stored/deflated ZIP、no-SH 和受支持
的 SH centroid 宽度。不包含分块/LOD 流送、多资源聚合、range request、格式
转换/导出、其他 splat 格式、经典 `WebGLRenderer` 或顺序无关透明。Zip64、
加密、多磁盘 ZIP 和未知压缩方法会被明确拒绝。

更多信息请参阅[性能与限制](./docs/performance-limits.md)、
[验收结果](./docs/acceptance.md)以及[设计和路线图](./docs/design-and-roadmap.md)。

## 开发验证

```bash
npm install
npm test
npm run test:browser
npm run test:package
npm run benchmark
npm run test:acceptance
```

合成测试夹具采用 CC0；两种 backend 的 no-SH/SH 浏览器结果使用容差截图。
浏览器套件还会在两种 backend 中加载一个从 Three.js CC BY 4.0 Millipede
示例转换得到的 10,000-Gaussian SOG。参见[夹具署名](./tests/fixtures/millipede-10k.license.txt)
与[兼容性审计](./docs/three-compatibility.md)。
