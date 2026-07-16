# 扫描 3D 建模改造指导：从火柴人到完整灵体

> 目标：扫描产出**完整的人体形态**，外表模糊化、带灵体感 —— 而不是关键点火柴人。
>
> 分工：机主（Windows）负责本文的 Web 建模部分；朋友（Mac）负责第六节 iOS 镜像部分。
> 两人在各自分支上开发（机主 `gilka1456-rgb/ui-refactor`，朋友 `main`），互不阻塞，
> 完成后按第七节的契约汇合。

---

## 一、现状诊断：为什么扫出来还是火柴人

代码里**已经有**「视觉外壳」管线（体素雕刻 + marching cubes，`core/web/src/ghost/visual-hull.ts`）。
火柴人是外壳**静默失败后的兜底**。决策链在 `body-silhouette.ts` 的 `buildBodySilhouetteGroup`：

```
tryAddVisualHull 成功  → 外壳网格（目标形态）
tryAddVisualHull 失败  → buildBodyCore（胶囊四肢 + 方块躯干 + 球头 = 火柴人）
```

失败的三个根因，按重要性排序：

### 根因 1：掩码没有对齐（最关键）

体素雕刻要求各朝向剪影在**同一坐标系**。但 `projectToMaskUV` 把体素空间直接映射到
**整帧相机画面**（u/v 跨全帧 0..1）。人在画面里只占一部分，且转身时位置、远近都会漂移：
正面时人在画面左侧、侧面时在中间，四个方向的剪影锥体交集就会被雕空或雕碎，
`buildVisualHullGeometry` 返回 `null`，静默兜底成火柴人。

**这是 visual hull 的教科书问题：雕刻前必须做人体包围盒归一化。**

### 根因 2：失败完全不可见

`tryAddVisualHull` 返回 `false` 没有任何日志/提示，无法区分「外壳成功但很丑」和
「外壳压根没生成」。旧数据（`orientations` 字段缺失的 avatar）也永远走兜底。

### 根因 3：二值雕刻 + 单次平滑，质感上限低

64×128×64 **二值**场 + 一次 Laplacian 平滑：台阶感明显、网格整体收缩，离灵体感很远。

---

## 二、目标架构

```
相机帧
  │ MediaPipe（已有）
  ▼
分割掩码 ──► M1 掩码归一化（裁剪包围盒/居中/统一身高）──► OrientationMask v2
  │                                                          │
  ▼                                                          ▼
33 关键点 ──► 模板人体网格（M3，兜底保证完整人形）      M2 SDF 软雕刻 + marching cubes
  │                    │                                     │
  │                    └────── 收缩包裹（模板贴合外壳）◄──────┘
  ▼                                     │
                                        ▼
                          完整人体网格（永远是人形）
                                        │
                  M4 灵体材质（菲涅尔边缘光 + 噪声扰动 + 洋葱壳软边 + 脚部消散）
                                        │
                                        ▼
                              「模糊化的完整灵体」
```

兜底链从「外壳 or 火柴人」升级为：

```
模板 + 外壳个性化（掩码充分）
  → 纯模板姿态（只有关键点）
    → 胶囊火柴人（连关键点都不足，理论上不应出现）
```

---

## 三、Web 端里程碑（机主负责）

### M0 — 可观测性（先做，改动极小）

| 项 | 内容 |
|---|---|
| 改动 | `tryAddVisualHull` 失败时 `console.warn` 具体原因（orientations 不足 / RLE 解码失败 / 雕空 / 三角形过少）；扫描预览页加小徽标「外壳渲染 / 骨架兜底」 |
| 文件 | `ghost/body-silhouette.ts`、`main.ts` 扫描预览 |
| 验收 | 能明确回答「哪一步失败了」；确认现有 avatar 里有多少真的带 `orientations` |

### M1 — 掩码归一化（根因修复，本阶段核心）

**采集侧**（`main.ts` 的 `applyBucketCapture`）：

1. 从掩码算人体包围盒；
2. 按包围盒裁剪（留 ~8% 边距）、水平居中、统一缩放到固定高度（如 192×384）；
3. `OrientationMask` 增加字段：`normalized: true`、`personAspect: number`（人体真实宽高比）。

**雕刻侧**（`ghost/visual-hull.ts`）：

- `projectToMaskUV` 改为投影到**归一化掩码空间**，四个视角天然对齐；
- 用 `personAspect` 区分正面宽度与侧面厚度（现在侧面厚度=正面宽度，会雕出方柱感）。

**兼容**：旧掩码（无 `normalized`）在解码时现算包围盒做同样归一化。

| 项 | 内容 |
|---|---|
| 文件 | `pose/segmentation.ts`（bbox 工具）、`main.ts`、`ghost/visual-hull.ts`、`models/types.ts`、`MAC_INTEGRATION.md` |
| 验收 | 单测：同一人形剪影故意平移/缩放后放进不同朝向，归一化后仍雕出连通外壳（现状会雕空） |
| 契约 | **必须同步更新 `MAC_INTEGRATION.md` 并通知朋友**（见第六、七节） |

### M2 — 二值雕刻 → 距离场软雕刻（质感跃升）

1. 每个视角掩码先算 **2D 有符号距离场**（到剪影边缘的距离，两遍线性扫描即可）；
2. 体素值 = 各视角 SDF 的最小值（连续标量替代 0/1）；
3. marching cubes 在 iso=0 处**插值**取点 → 亚体素精度，台阶感消失；
4. 平滑换 **Taubin（λ=0.5, μ=-0.53, 2–3 轮）** —— 现在的单次 Laplacian 会整体缩水，Taubin 不缩；
5. 分辨率维持 64×128×64 起步，性能允许再提 96×192×96。

| 项 | 内容 |
|---|---|
| 文件 | `ghost/visual-hull.ts` |
| 验收 | 同一掩码 M2 前后截图对比；输出 < 25k 三角形 |

### M3 — 模板人体混合（「保证完整人形」的关键）

4 个 90° 视角的 visual hull 有物理上限：手臂贴身时与躯干融合、双腿并拢时粘连。
要「永远是完整人体」，行业标准做法是模板拟合：

1. 内置**低模绑定人体模板**（3–5k 三角形，T-pose，骨骼对齐 MediaPipe 33 点；
   可自建或用 CC0 资源简化，不需要 SMPL 级学术模型）；
2. 用 33 关键点驱动模板摆姿态（骨骼旋转重定向，纯数学，无 ML）；
3. **收缩包裹**：模板顶点沿法线向外壳 SDF 表面位移（限制最大位移量），
   把「本人胖瘦/发型/衣服轮廓」印到模板上；
4. 兜底链见第二节。

| 项 | 内容 |
|---|---|
| 文件 | 新增 `ghost/template-body.ts` + 模板资产 |
| 验收 | 只扫 1 个朝向也能出完整人体（个性化少）；扫满 3–4 朝向时剪影明显贴合本人 |

### M4 — 灵体观感（「外表模糊化」）

现有 `ghost/ghost-shader.ts` 已有菲涅尔 + 扫描线，补四件事：

1. **顶点噪声扰动**：vertex shader 加低频 3D 噪声位移（幅度 ~0.5–1cm，随 `uTime` 缓慢流动）→ 轮廓「呼吸般模糊」；
2. **洋葱壳软边**：同一网格再画 2 层膨胀副本（scale 1.03 / 1.07，透明度递减）→ 边缘自然发虚。
   这是不用后处理 bloom 就能拿到的「模糊感」，移动端友好；
3. **脚部消散**：fragment 按世界高度 alpha 渐隐 + 噪声侵蚀（经典幽灵下摆）；
4. **边缘光增强**：菲涅尔指数降到 ~1.6，加一档颜色偏移，侧视轮廓更亮。

**不建议**上 UnrealBloomPass 后处理 —— 手机浏览器代价太高，洋葱壳 + 菲涅尔已达 90% 效果。

| 项 | 内容 |
|---|---|
| 文件 | `ghost/ghost-shader.ts`、`ghost/body-silhouette.ts` |
| 验收 | 三种风格（灵体/赛博/量子）在手机上 30fps 以上 |

### M5 — 工程化（伴随 M2/M3 做）

- 雕刻 + SDF + marching cubes 移进 **Web Worker**（现在 50 万体素在主线程算，会掉帧）；
- 生成网格按 `avatarId + schemaVersion` 缓存进 IndexedDB（复用 `RecordMediaStore` 模式），二次打开秒出；
- 预算：Worker 内 < 300ms，输出 < 25k 三角形。

---

## 四、实施顺序

| 顺序 | 里程碑 | 性质 |
|---|---|---|
| 1 | M0 可观测性 | 小改，立即见效 |
| 2 | **M1 掩码归一化** | **根因修复** |
| 3 | M2 SDF 软雕刻 | 质感 |
| 4 | M4 灵体材质 | 观感 |
| 5 | M3 模板混合 | 完整性保证（最大的一块） |
| 6 | M5 Worker + 缓存 | 性能 |

预期：M1 落地后外壳成功率从「基本失败」变「常态成功」，能看到真人轮廓粗坯；
M2+M4 变成有灵体质感的模糊人形；M3 保证任何扫描质量下不再出现火柴人。

---

## 五、测试策略（Web）

1. **合成剪影单测**：程序生成矩形/椭圆人形掩码（正/侧/背/左），断言外壳包围盒比例正确；
2. **对齐回归**：同一剪影平移 / 缩放后放不同朝向，归一化后必须仍雕出连通外壳；
3. **RLE 兼容**：v1（整帧）与 v2（归一化）掩码解码互通；
4. **模板姿态不变量**：任意关键点输入不产生 NaN；骨长在合理范围；
5. 现有 vitest 基建直接可用（`npm run test:run`）。

---

## 六、iOS 端镜像改动（朋友负责，在 `main` 分支做，互不影响）

Web 与 iOS 通过 `OrientationMask`（RLE + base64）互通，Web 侧改掩码格式后 iOS 必须镜像，
否则 iOS 解码 Web 数据（或未来 CloudKit 双端同步）会错位。

### 6.1 必做：跟随 M1 的契约变更

| 文件 | 改动 |
|---|---|
| `Bridge/Services/PersonMaskRLE.swift` | 支持 v2 掩码元数据（`normalized` / `personAspect`）；v1 数据解码时现算包围盒归一化（与 Web 同策略） |
| `Bridge/AR/VisualHull.swift` | 投影逻辑改为归一化掩码空间（与 Web `projectToMaskUV` 同语义）；用 `personAspect` 区分正面宽度与侧面厚度 |
| 采集侧（`PersonSegmentationCapture.swift`） | `VNGeneratePersonSegmentationRequest` 产出的掩码同样做包围盒裁剪 + 居中 + 统一身高后再编码存储 |

### 6.2 顺手修：已知独立缺陷（不依赖 M1）

| 文件 | 问题 | 建议 |
|---|---|---|
| `Bridge/AR/MarchingCubesTables.swift` | `triTable` 有 360 组（标准 256），可能导致外壳网格破面（README 风险 4） | 用标准 256 组 Paul Bourke 表校对替换；Web 侧 `visual-hull.ts` 内嵌的 256 组表可直接对照 |
| `Bridge/AR/GhostEntityBuilder.swift` | 与 Web 兜底链对齐 | 如果 Web 落地 M3 模板混合，iOS 同步引入相同兜底链（模板 → 外壳 → 胶囊），保证两端视觉一致 |

### 6.3 可选：跟随 M2/M4 的质感对齐

- iOS `VisualHull.swift` 同样可从二值雕刻升级为 SDF 插值 + Taubin 平滑（算法与 Web 相同，纯 Swift 移植）；
- RealityKit 侧灵体材质用 `CustomMaterial`（Metal shader）实现菲涅尔 + 噪声扰动 + 脚部消散，
  与 Web 的 `ghost-shader.ts` 参数对齐（颜色/透明度/扰动幅度从共享风格表取值）。

### 6.4 分支协作方式

- 朋友在 `main` 上做 6.1–6.3，机主在 `gilka1456-rgb/ui-refactor` 上做 M0–M5，互不阻塞；
- **先合契约、再合实现**：`MAC_INTEGRATION.md` 的 OrientationMask v2 定义先在一个分支落地并被另一方确认，之后各自实现；
- 汇合点：机主分支的 Web 实现经 PR 进 `main` 时，朋友已按同一契约完成 iOS 侧，数据互通即可在真机验证。

---

## 七、契约变更清单（写进 MAC_INTEGRATION.md 的内容）

```
OrientationMask v2:
  azimuth: 0 | 90 | 180 | 270        # 不变
  width / height: number             # 归一化后掩码尺寸（如 192×384）
  mask: string                       # RLE + base64，不变
  normalized: true                   # 新增。缺失 = v1（整帧掩码）
  personAspect: number               # 新增。人体包围盒宽/高比，用于区分正面宽度与侧面厚度

兼容规则：
  - v1 数据（无 normalized）：双端解码时现算包围盒并归一化，行为与 v2 一致
  - 双端采集侧一律产出 v2
  - CloudKit AvatarPoseRecord 存储 v2 字段（阶段 B 时生效）
```

---

## 八、给朋友的一句话通知（M1 落地时发）

> `OrientationMask` 增加 `normalized` 和 `personAspect` 字段，掩码从「整帧」改为
> 「人体包围盒裁剪 + 居中 + 统一身高」。iOS 的 `VisualHull.swift` 投影逻辑和
> `PersonSegmentationCapture.swift` 采集侧需要同样修改；旧数据兼容策略是解码时现算包围盒。
> 顺手把 `MarchingCubesTables.swift` 的 triTable 换成标准 256 组（对照 Web `visual-hull.ts` 内嵌表）。
> 详见 `docs/scan_ghost_modeling_plan.md` 第六、七节。
