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
顺序；旋转、缩放、颜色、不透明度和 SH 始终留在 GPU。WebGPU 路径使用并行
稳定的自适应 GPU radix sort 生成并消费完整顺序，不回读 center、key、中间
buffer 或 order。生产通用路径采用 4 位 Portable backend；8 位 OneSweep 只有在
适配器身份可关联确认、厂商为 NVIDIA 且报告固定 32-lane subgroup 时才可准入。
目前 Three.js/WebGPU 不暴露这种关联，因此默认生产选择会保持 Portable，不会用
第二次 `requestAdapter()` 的结果猜测身份；相同 key 的 splat 保持源顺序。

启用投影缓存的 WebGPU mesh 还会在光栅化前按 PlayCanvas 同类的“不透明度 ×
屏幕投影面积”指标分类 splat；相机后方、零 alpha、屏外和低贡献项会按原顺序
稳定压紧到 GPU 可见索引，并由 GPU 写入的 indexed-indirect 参数只绘制存活项。
完整源数据仍常驻 GPU，视角变化后可重新出现；保守默认贡献阈值为 `1`。

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
  transform、在 prepare 前通过 `setInstanceTransforms()` 批量配置平移副本、
  单个全资源 active range、通过 `setContributionCullingEnabled()` /
  `setContributionCullThreshold()` 配置贡献剔除、通过
  `readContributionCullingStatsAsync()` 显式读取剔除埋点、渲染诊断和幂等
  dispose。
- `SOGError`：提供 `ABORTED`、`INVALID_ARCHIVE`、`INVALID_METADATA`、
  `UNSUPPORTED_RENDERER`、`RENDERER_MISMATCH` 等稳定错误码。
- options、state、metadata、bounds、diagnostics 和 disposal 类型均从包根导出。

加载诊断包含各阶段耗时、下载字节、ZIP 条目数、解码图片数、splat 数、临时
保留内存和失败阶段。渲染诊断包含 backend、upload/compile/prepare/首帧/sort
耗时、sort/upload/readback 计数、active count、GPU 分配估算、保留的 CPU backing
array 分配、状态、所选 radix backend、舍入后的 radix bits 和选择原因。
贡献剔除埋点包含 submitted/visible，以及相机后方或 alpha、屏外、低贡献三类
计数。读取是显式操作并会增加 readback 诊断；正常静止渲染路径不会 GPU 回读。

## MVP 限制与非目标

每个 bundled 资源强制上限为 5,000,000 splats。规划估算为每个 splat 52 个
GPU 字节，上限时约 260 MB；这还不含渲染器、解码图片、framebuffer 和浏览器
开销。它是内存护栏，不是所有设备上的性能承诺，生产资源需在目标 GPU 实测。

MVP 支持单个全资源 active range、SOG v2 stored/deflated ZIP、no-SH 和受支持
的 SH centroid 宽度。不包含分块/LOD 流送、多资源聚合、range request、格式
转换/导出、其他 splat 格式、经典 `WebGLRenderer` 或顺序无关透明。Zip64、
加密、多磁盘 ZIP 和未知压缩方法会被明确拒绝。
要求 antialiased Gaussian 或 2DGS 方程的 SOG metadata 也会被明确拒绝，直到
对应的独立渲染路径完成。

更多信息请参阅[性能与限制](./docs/performance-limits.md)、
[验收结果](./docs/acceptance.md)以及[设计和路线图](./docs/design-and-roadmap.md)。

## 示例

运行 `npm run example` 后打开
`http://127.0.0.1:4173/webgpu_sog.html`。公开示例沿用 Three.js Gaussian
Splatting example 的页面结构，真实模型选项包括：no-SH 使用完整
116,374-Gaussian Millipede，SH 使用从 Three.js 示例直接转换的完整
195,099-Gaussian Lion SH2。两者都没有降采样或过滤，Lion 也没有削减 SH
阶数；还可切换 WebGPU backend 或强制 WebGL backend。
**Start motion test** / **Stop motion test** 可在不改变 active count 的情况下重复
采样全量模型性能；页面与结构化状态会报告帧耗时分位数、排序速率/总数、viewport、
DPR 和 backend 对应的排序计时含义。参见[示例说明](https://github.com/gqfx/three-sog-splats/blob/main/examples/README.md)。
来源列表还包含可复现的 5,000,000-splat 合成 WebGPU 压测场景；Portable 路径报告
约 200 MB GPU 资源，若当前为强制 WebGL 会自动切换到 WebGPU。
为了与真实数据对照，Lion grid 只下载一次同一份 3.3 MB Lion SOG，并把 25 个平移
副本合成一次 draw，逻辑总数为 4,877,475 splats。深度排序覆盖完整逻辑流，副本
之间可以正确穿插；静态属性只在准备期解量化一次，投影与 SH 只在相机/模型变化
时刷新，静止帧不运行 compute。仓库和 GPU 都不会保存 25 份展开后的源数据。
WebGPU 示例提供贡献剔除开关、阈值和显式埋点按钮；controlled profiler 还会在
同一视角执行开/关 A/B，并用 GPU survivor 数修正 Three.js 的 CPU 侧 triangle
估算。

## 开发验证

```bash
npm ci --ignore-scripts
npm run fixtures:fetch
npm test
npm run build:example
npm run test:browser
npm run test:package
npm run benchmark
npm run test:acceptance
```

合成夹具是仅供内部测试使用的 CC0 资源，不会出现在公开来源选择器中；两种
backend 的 no-SH/SH 浏览器结果使用容差截图。
浏览器套件还会在两种 backend 中加载一个从 Three.js CC BY 4.0 Millipede
示例直接转换、未降采样的完整 116,374-Gaussian SOG；公开示例测试会在两种
backend 中加载并截图 Millipede no-SH 和完整的 195,099-Gaussian Lion SH2
模型。WebGPU 的来源选择器还包含 Three.js 官方示例中完整的
445,409-Gaussian Tomatoes SPZ v4 SH3，以及 Nicolas Diolez 的完整
4,929,011-Gaussian Moon SOG v2 SH3 场景；二者都是独立模型，没有运行时复制。
参见
[Millipede 夹具署名](https://github.com/gqfx/three-sog-splats/blob/main/tests/fixtures/millipede.license.txt)、
[Lion 夹具署名](https://github.com/gqfx/three-sog-splats/blob/main/tests/fixtures/lion.license.txt)、
[Tomatoes 夹具署名](https://github.com/gqfx/three-sog-splats/blob/main/tests/fixtures/tomatoes.license.txt)、
[Moon 夹具署名](https://github.com/gqfx/three-sog-splats/blob/main/tests/fixtures/moon.license.txt)与
[兼容性审计](./docs/three-compatibility.md)。

## 资源预算与发布状态

0.1.x API 仍为实验版本。当前实测平台为 macOS Chrome 与文档指定的 Three.js
版本；移动设备、Firefox/Safari、WebXR 和多个独立 mesh 的全局透明排序尚未认证。
500 万点是数量护栏，不是帧率承诺。流式加载和 LOD 仍属于后续功能；大模型需要
完整下载后才能显示。

加载默认限制：下载 128 MiB、单个 ZIP 条目 128 MiB、实际解压总量 256 MiB、
单张图片宽高各不超过 8192、单张 8,388,608 像素、全部解码 RGBA 共 256 MiB，
最多同时解码两张图片。可通过 `maxDownloadBytes`、`maxArchiveEntryBytes`、
`maxArchiveBytes`、`maxImageDimension`、`maxImagePixels`、`maxDecodedBytes`
和 `decodeConcurrency` 配置。原生 PNG/WebP 在分配像素前检查头部；自定义 decoder
须自行保证内部的分配安全，可实现 `getDimensions` 参与预检查。

prepare 支持 `maxGpuBytes`（默认 512 MiB，仅统计 SOG 分配）及
`maxProjectedCacheBytes`（默认 256 MiB，0 表示关闭缓存）。缓存按包含 SH、逻辑
实例的字节估算准入，平移实例批量需要足够缓存预算。上传前检查设备纹理与存储
缓冲限制；浏览器图片、framebuffer 和驱动仍需额外内存空间。

首次克隆后运行 `npm run fixtures:fetch` 获取 Moon。原生文件和规范化 ZIP 均
使用已提交的 hash 验证，大文件不进入 Git。开发和发布步骤见
[CONTRIBUTING.md](https://github.com/gqfx/three-sog-splats/blob/main/CONTRIBUTING.md)，
漏洞报告见 [SECURITY.md](./SECURITY.md)。
