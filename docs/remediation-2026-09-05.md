# 2026-09-05 审查问题修复记录

原报告的 8 项代码缺陷已修复，新增回归通过。修改保留在当前工作区，没有提交、推送或发布。原始审查文档保留为历史记录，不能再把其中的缺陷状态当作当前状态。

## 修复对应关系

| 原问题 | 实际修改 | 验证 |
| --- | --- | --- |
| ZIP 真实解压量绕过 | 每 1 KiB 压缩输入增量解码，累计实际输出越限立即抛错；stored 条目复制前核对大小 | 1 字节声明 / 1 MiB 实际输出 / 合法前缀 CRC 的回归被拒绝，多块正常流通过 |
| 解码图片内存无预算 | 解码前解析 PNG/WebP 头，检查宽高/像素/累计字节，拒绝动画；解码后再检查返回值；默认两路并发 | 巨幅头部不启动 decoder，自定义 decoder 超预算会关闭图像，并发实测为 2 |
| WebGL 运动排序饥饿 | 应用单调更新的已完成排序，同时合并最新相机请求 | 慢 Worker 单测持续上传，真实 Tomatoes 运动测试通过 |
| DC/SH 颜色截断顺序 | 缓存原始颜色码本索引，全部 SH 累加后再夹取最终颜色 | GPU 数值 oracle：DC=1.4，SH=-0.5，缓存与非缓存都得到约 0.9 |
| 取消 bitmap 未关闭 | bitmap 所有权覆盖 abort 边界；Worker 生命周期可取消、池化并关闭 | 延迟完成 bitmap 的 close 恰好执行一次；Worker 复用测试通过 |
| 异步读回污染 renderer | render-target 切换/绘制/恢复处于无 await 区间；之后按显式 target 读回 | 模拟异步 compile/readback 和应用切换 target，状态保持正确 |
| 数值溢出 | 验证指数解码和 Float32 表示范围；缓存保留原始 scale 索引，椭圆改用 Float32 | 1000 / -1000 等有限输入导致的溢出/下溢被拒绝，真实场景通过 |
| 无入口代码的 npm 包 | prepack 自动构建和检查；发布前验收；源码映射可解析；真实生产消费者 | 先清空 dist 再 pack；r184/r185 消费者加载 SH 模型、运行 Worker、渲染和清理均通过 |

同时增加 GPU 总预算和缓存字节预算，检查设备纹理/缓冲限制，缓存选择不再只看 100 万唯一点阈值；贡献剔除使用当前 render target / viewport 尺寸。单个非恒等平移也会检查缓存条件并更新包围体，避免静默忽略变换。

## 性能优化与结果

- CRC-32 改为查表实现，保留完整校验。
- 图片 Worker 按加载生命周期复用，默认最多两路解码；仅在回退时构造 Blob。
- WebGL key/radix scratch 数组复用，排序 Worker 去除 Three.js 运行时依赖；示例构建的 Worker 从 **220.93 kB 降到约 2.03 kB**。
- 增加 `npm run benchmark:release`：使用生产构建、记录环境/缓存状态、分别测静止与持续运动，并可开启 50 Mbps / 40 ms 网络配置。

本次生产测试为 Apple M4、macOS 26.6.2、Chrome 152.0.7977.76、Node 24.14.0、960×640、DPR 1。每个场景做两轮，各约 3 秒静止和 3 秒运动；以下为两轮算术平均。与原报告的开发服务器单轮测试不构成完全受控的整页性能 A/B。

| 场景 | 页面就绪 | ZIP 阶段 | 解码 | prepare | 静止 FPS | 运动 FPS | 排序更新/s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Millipede / WebGPU | 191 ms | 8.8 ms | 8.7 ms | 76.8 ms | 60 | 60 | 60 |
| Lion / WebGPU | 227 ms | 11.2 ms | 16.2 ms | 73.2 ms | 60 | 60 | 60 |
| Tomatoes / WebGPU | 333 ms | 18.6 ms | 31.1 ms | 101.8 ms | 60 | 60 | 60 |
| Moon / WebGPU | 1619 ms | 139.6 ms | 244.0 ms | 139.8 ms | 15.5 | 12.7 | 12.8 |
| Lion / forced WebGL | 269 ms | 13.7 ms | 17.9 ms | 81.6 ms | 60 | 60 | 60 |
| Tomatoes / forced WebGL | 351 ms | 18.2 ms | 31.8 ms | 114.9 ms | 60 | 60 | 60 |

最明确的行为改善是 Tomatoes：修复前转动时排序更新为 0/s，修复后两轮均为 60/s。Moon 的 ZIP 阶段由原审查中的约 2.39 秒降到当前约 0.14 秒；整体就绪约 1.62 秒，但其本次本地下载本身约 1.04 秒，不能把 CRC 阶段提速比例当作整页提速比例。

Moon 的 493 万唯一点并未达到 60 FPS，本次持续运动为约 13 FPS，比原审查单轮的约 16 FPS 更低；这些短采样受热状态/环境影响，且无缓存大模型渲染路径未进行新的 LOD 优化。因此不宣称大模型帧率改善或生产全平台实时达标。

50 Mbps 下载 / 10 Mbps 上传 / 40 ms 延迟的 Moon 单次网络实验中，cold 为约 11.61 秒，warm 为约 11.89 秒。当前 preview 缓存策略下第二次访问未产生明显收益；不能把 warm 标签等同于资源从缓存读取或宣传公网秒开。

当前诊断内存：Moon 约 210.9 MiB GPU、94.2 MiB CPU backing arrays；Tomatoes WebGL 的 CPU backing arrays 约 20.4 MiB（现在包括持久 radix scratch）。这些仍不包含完整浏览器图片、驱动、framebuffer 和峰值分配。

原始数据：[生产测量 JSON](./review-2026-09-05.after.metrics.json)。

## 发布和维护工程

新增 Node 22.12/24 检查、Three.js r184/r185 浏览器/消费者矩阵、只读 workflow 权限、固定 commit 的 Actions、依赖更新配置。CI artifact 区分通过、失败和环境无 GPU 的跳过；设置 `SOG_REQUIRE_WEBGPU=1` 时不允许把无 GPU 当通过。

新增 SECURITY.md、CONTRIBUTING.md、CHANGELOG.md、Node 版本约定、包 repository/bugs/homepage，以及当前验收记录。npm 包包含映射需要的源文件；README 中未打包的示例/素材链接指向仓库。生产示例输出 `licenses/`。

Moon 改为不跟踪的大文件，`npm run fixtures:fetch` 从固定 v1 原生文件重建。原生文件逐个校验 SHA-256、大小，容器固定时间戳且不包含本地 UID 等系统元数据，最后验证归档 hash。已在空目标目录下载并重建成功，和当前本地规范化 Moon 完全一致。原始容器备份位于 `.tmp/review/moon-original.sog`；模型像素和 Gaussians 没有改变。

Tomatoes 和 Moon 原始场景页的作者及 CC BY 4.0 声明已通过直接 HTTP 再核对，记录在 `tests/fixtures/license-evidence.json`。这是来源核验，不是法律担保。

## 最终验证范围

`SOG_REQUIRE_WEBGPU=1 npm run test:acceptance` 完整退出码为 0：

- TypeScript、ESLint、库构建和生产示例构建通过。
- 16 个测试文件、134 个单元/集成测试通过。
- r185 的 16 个浏览器用例通过（36.7 秒），r184 的 16 个通过（41.4 秒）。
- 两个 Three.js 版本的干净打包/类型/生产 Worker/绘制消费者通过。
- 7 个模型归档的 manifest 校验通过；Moon 的独立下载重建校验通过。
- 当前 npm audit：0 个已知漏洞。workflow YAML 本地解析成功，git diff --check 无空白错误。
- 没有更新或放宽截图基线。

源码基于 `011c16cfa880cc8877a487cee525baca5b0ac0fd`（见[源码指纹](./remediation-2026-09-05.source.json)）加现有未提交改动。应用/测试/构建配置共 82 个文件的 SHA-256 fingerprint 为 `1869286b30684f4c0c2c77659e942a0014f8edd83ee7d6be35bc6122a2a1c5f9`；文档和性能 JSON 不在该 fingerprint 范围。

GitHub Actions 尚未远程执行，私密漏洞报告与分支保护仍是仓库设置；当前工具没有替用户发布。OneSweep 的真实获准 NVIDIA 执行、移动硬件、Firefox/Safari、XR，以及独立重叠 mesh 的全局透明排序仍未认证。LOD、range/分块和流式加载属于明确保留的功能范围限制，不纳入“8 项缺陷已修复”的声称。
