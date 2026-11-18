# 白板板书自动提取系统（TypeScript + WebCodecs + WebGL2）

从录播教室视频中自动定位白板、抠除老师、在人走开后才更新板书，并按页导出
带书写时间标注的多页 PDF 和红蓝黑分层图片。所有计算在浏览器本地完成，
解码用 **WebCodecs**，图像处理用 **WebGL2 着色器**，核心算法用纯 TypeScript。

## 需求与实现对照

| 需求 | 实现 |
| --- | --- |
| 自动找白板四边，边框被老师挡住一截也能定位 | `core/boardDetect.ts`：亮度区域凸包 + Hough 直线双路检测，带时序 EMA 平滑和 hint 兜底 |
| 先抠掉人的轮廓，人走开后才更新那片板书 | `glPipeline` 运动+背景差分种子 → CPU 连通域/包围盒填充/时序保持的人物掩膜；像素级提交要求 `非人物 && 确实变化` 才写入板书纹理 |
| 板书明显变化才存一页 | `core/paging.ts` 的 TileGate：分块稳定性门控（连续稳定帧 + 提交冷却 + 无变化拒绝） |
| 擦掉重写算新页 | GPU `ERASE_FS` 客观擦除信号（板上有墨、当前帧变白、无人物），多 tile 持续确认后分页，擦除前先快照 |
| 写一半离开又回来补，合成同一页最终状态 | 页面在擦除分页前不关闭，后续 add 提交累积到同一板纹理与同一页 |
| 红蓝黑笔迹分图层单独显示 | `core/color.ts` 统一阈值，GLSL 与 CPU 双实现，导出每层独立 PNG |
| 每页列书写起止时间和写得最久的区域 | TileGate 逐块累计书写时长，`pageFooterText` 生成页脚并渲染进 PDF/图片 |
| 多页 PDF + 图片打包 | `exporter/`：pdf-lib 出 PDF，JSZip 出含 `manifest.json` 的分层压缩包 |
| 45 分钟课在 2 倍时长内处理完 | 低分辨率分析纹理 + 分块归约，端到端实测 `wall/video ≈ 0.5`（见下） |
| 白衬衫不能被当成板书背景 | 人物检测靠运动/形状/时序而非颜色；衬衫近白色在颜色分类里恒为 `white`，单测与 e2e 均断言 |

## 目录结构

```
src/
  types.ts                 配置、页面记录、分块统计等类型与默认参数
  extractor.ts             顶层编排：检测节奏 + GL 管线 + 分页状态机
  core/
    geometry.ts            点/四边形、投影基四点单应性、矩阵求逆、EMA
    boardDetect.ts         白板检测（凸包四边形、Hough、评分、hint 兜底）
    components.ts          两遍 union-find 连通域、膨胀、时序保持
    color.ts               红/蓝/黑/白分类（CPU + 同源 GLSL 常量）
    paging.ts              TileGate 稳定性门控 + PageManager 分页/计时
  gl/
    shaders.ts             warp/种子/背景/变化/擦除/归约/提交/分层 全部着色器
    glEngine.ts            纹理、ping-pong、PassRenderer、readback
    glPipeline.ts          完整逐帧分析与像素级人物安全提交
  video/
    mp4Decoder.ts          mp4box 解封装 + WebCodecs VideoDecoder 异步帧源
    synthetic.ts           虚拟老师+白板合成测试片（含真值）
  exporter/                PDF / ZIP / 页脚 / CPU 分层渲染
main.ts, index.html        浏览器界面
tests/
  unit/                    vitest 纯 TS 单测（33 个）
  browser/ + run-e2e.ts    puppeteer-core 驱动本机 Chrome 的端到端自测（21 项）
```

## 运行

```bash
npm install
npm run dev          # 打开界面，可上传 MP4 或点“用合成测试片演示”
npm test             # 纯 TS 单元测试
npm run test:e2e     # 浏览器端到端自测（自动查找本机 Chrome/Edge）
npm run build        # 类型检查 + 生产构建到 dist/
```

端到端自测用 `SyntheticFrameSource` 生成 140 帧、10fps 的虚拟课堂：白衬衫老师
走动并遮挡白板左边框、红/蓝/黑板书、离场后返回补写、整板擦除后重写第二页。
`tests/run-e2e.ts` 会断言页数、四角定位误差、各颜色像素、分层隔离、人物帧占比、
分页时间、PDF/ZIP 文件头以及 2 倍时长预算，结果写入 `out/e2e-result.json`。

## 关键工程决策

- **单应性用列主序上传 GLSL**：CPU 行主序矩阵在 `uniformMatrix3fv` 前转置。
- **纹理更新用 `texSubImage2D`**：重新 `texImage2D` 会把过滤参数重置为
  `NEAREST_MIPMAP_LINEAR`，使无 mipmap 的掩码纹理采样变黑。
- **提交掩码 R/G 通道语义分离**：专用 `UPSCALE_MASK_FS` 保留 R=提交、G=擦除，
  通用灰度 upscale 不会把 add 误复制成 erase。
- **像素级而非整块提交**：门控只决定哪些 tile 允许提交，真正写入由
  `COMMIT_MASK_FS` 在像素级要求 `门控 && 变化 && 非人物`，老师身体永不进板书。
- **擦除分页独立于人物门控**：`ERASE_FS` 直接比较已提交板纹理与当前帧的墨迹
  存亡，配合“本页确实写过的 tile”集合与连续帧确认，区分擦黑板和人走过。

## 浏览器要求

需要 WebGL2 与 WebCodecs（Chrome/Edge 94+ 已默认提供）。无头自测通过
SwiftShader/ANGLE 软渲染运行，不依赖物理 GPU。
