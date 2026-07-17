# 05 · Spectral V3：游戏级人体灵体架构决议

状态：已通过 Codex 与 Cursor Fable 5 独立方案、互相反驳和合并评审。  
代码基线：`cc13ce3`，分支 `gilka1456-rgb/ui-refactor`。  
范围：只负责人体重建与显示；不修改 `main` 的 AR 架构。

## 1. 产品目标与边界

首批只提供两个风格家族：

1. **奇幻灵体**：红灵 / 白灵调色变体。完整人体仍可辨，具有单色染色、半透明结构、
   边缘灵光、体内缓慢流动和表面雾化粒子；不使用扫描线。
2. **赛博投影**：完整人体仍是主体，在其上增加扫描带、短暂相位错位、局部数据缺失、
   稳定噪声和落地投影光盘；不得使用线框把人体退化成火柴人。

本项目中的“游戏级”严格定义为：

- 连续可信的完整人体：一张水密表面、无端盖接缝、头颈肩胯与四肢分明、比例来自真人；
- 高质量风格化显示：暗底、亮底和相机合成下结构可读，时间动画稳定；
- 可度量的运行质量：LOD、特效档位、帧时和显存有预算且能自动降级。

它不包含照片级面部、衣料褶皱或参考游戏原资产级细节。四向剪影物理上不含这些信息，
身份特征主要来自身材比例、轮廓和姿势。参考作品只用于提取视觉语言，不复制其资产。

## 2. 已否决路线

| 路线 | 结论 | 原因 |
|---|---|---|
| 继续给分离管链叠 shader | 否决 | 关节端盖、断裂拓扑和低边折面是当前人偶感的根因 |
| 纯 visual hull 作为最终人体 | 否决 | 四向姿势轻微不一致就会断肢，且无法恢复腋下、下颌、胯部凹陷 |
| SMPL 系商业模型 | 否决 | 商业许可、模型体积和 Web 运行成本不适合当前阶段 |
| 首版引入自制美术模板 | 延后 | 拓扑与 UV 最优，但需要稳定资产生产流程；保留为 V3 之后可替换 provider |
| WBOIT / depth peeling | 否决 | iPhone WebGL 的浮点 MRT 与填充带宽成本过高 |
| 全屏 bloom / 真色散 / 运动模糊 | 首版否决 | 多灵体和相机合成下填充率不可控；用背壳、软肩高光和表面镶边替代 |
| 光线步进体积雾 | 否决 | 每像素多次采样不符合移动端预算；用双层体噪声与 GPU 粒子替代 |

## 3. 统一建模架构

```text
OrientationMask v3 + MediaPipe 33（采集契约不变）
                    │
                    ▼ Web Worker
标准姿态 17 骨 + 身体测量值
                    │
                    ▼
解剖隐式场：变半径圆角锥/椭球 + smooth-min
                    │
visual-hull SDF ────┤ 3×3×3 平滑，按部位置信度、±4cm 限幅融合
                    ▼
同一融合场三种分辨率 Marching Cubes
  1.8cm / 2.8cm / 4.2cm → LOD0 / LOD1 / LOD2
                    │
                    ▼
Taubin 位置平滑 ×2 + 融合场中心差分法线
                    │
                    ▼
最近四骨胶囊权重 + 同链优先 + Uint8 量化
                    │
                    ▼
GhostBodyModel（几何与风格无关，IndexedDB 版本化缓存）
```

隐式场使用“内部为正、外部为负、表面为 0”的约定：

```text
F_final(p) = F_anatomy(p)
           + confidence(region(p)) * clamp(blur(F_hull)(p), -0.04m, +0.04m)
```

具体权重必须以轮廓回投误差和连通性测试标定，不能把公式中的 4cm 当成所有部位同权。
头、手和细肢体以解剖场为主；躯干、骨盆和大腿允许更多外壳个性化。

### 3.1 标准姿态与骨架

体型与姿势必须分离。Worker 在标准 A-pose 生成身体资产；运行时按 17 骨硬契约摆到扫描
姿势。首个可见切片允许 CPU `bakePose` 得到静态几何，但同阶段必须接入 `SkinnedMesh`；
烘焙路径永久保留，供测试、截图和回滚。

骨顺序：`pelvis, spine, chest, neck, head, l_upperArm, l_foreArm, l_hand,
r_upperArm, r_foreArm, r_hand, l_thigh, l_calf, l_foot, r_thigh, r_calf, r_foot`。

## 4. 数据契约

```ts
interface GhostBodyModel {
  version: "ghost-body-v3";
  algorithmVersion: string;
  sourceHash: string;
  rig: GhostRig;
  lods: GhostLodMesh[];
  measurements: BodyMeasurements;
  partial: "full" | "upper";
  canonicalBounds: { min: [number, number, number]; max: [number, number, number] };
  quality: GhostBodyQuality;
}

interface GhostLodMesh {
  voxelSize: number;
  triangleCount: number;
  positions: Float32Array;       // vec3
  normals: Int16Array;           // normalized vec3，存储时允许 2B pad
  indices: Uint32Array;
  skinIndices: Uint8Array;       // uvec4
  skinWeights: Uint8Array;       // normalized vec4，shader/CPU 使用前重归一
  canonicalCoords: Uint16Array;  // normalized vec3，相对于 canonicalBounds
  regionAndChain: Uint8Array;    // regionId + chainT
}
```

`canonicalCoord` 供稳定三维体噪声和溶解；`chainT` 供沿肢体流动与扫描；`regionId` 供部位
逻辑。任何风格噪声都不得依赖蒙皮后的世界坐标。目标顶点带宽约 36B/顶点。

缓存 key 必须包含建模算法版本、输入 source hash、骨架契约版本和 LOD 配置；风格不进入
几何缓存 key，切换风格不得触发重建。

## 5. 共用渲染内核

```text
Pass 0 结构深度预写：colorWrite=false, depthWrite=true
Pass 1 主表面：连续透明度、法线明暗、风格 hook
Pass 2 背面加色壳：additive，仅高档/近景
Pass 3 表面 GPU 粒子：additive、一次 instanced draw、每帧零 CPU
Pass 3b 赛博落地光盘：仅赛博启用
```

Pass 0 与 Pass 1 必须共享：

- 完全相同的顶点蒙皮和顶点位移函数；
- 完全相同的 `structuralMask(canonicalCoord, chainT, regionId, time, preset)`。

“物质此刻不存在”的区域（赛博丢块、断层缺口、完成溶解的脚部）进入二值
`structuralMask`，两个 pass 同步 `discard`；“物质存在但透明”的区域（菲涅尔、呼吸、
渐隐过程）只调主 pass alpha。外观必须先淡到约 0.05，再越过结构裁剪线，避免硬边和
隐形深度壳。

颜色路径显式设置 `SRGBColorSpace` 和 `NoToneMapping`，高光由 shader 软肩曲线收敛。
透明 AR 合成使用 `alpha: true`、预乘 alpha，并对 additive 能量设置相机合成衰减系数。

## 6. 风格模块

### 6.1 奇幻：红灵 / 白灵

- 相同奇幻 shader，仅切换色阶与能量参数；
- 标准坐标双层低频噪声调制体内发光，`chainT` 控制沿肢体的流向；
- 柔和菲涅尔与可选背壳形成灵光，不使用高频扫描线；
- 表面预采样出生点，最多 300 个软圆片沿法线与重力反方向漂移；
- 顶点轮廓扰动上限 0.5cm，慢周期、确定性种子；
- 白灵在白底仍要靠冷灰结构暗部和轮廓能量保持可读，不能只靠亮度。

### 6.2 赛博：人物投影

- 与奇幻使用同一 `GhostBodyModel` 和结构深度；
- `chainT` 与标准高度生成细扫描带和一道慢速主扫描带；
- 种子化事件时间线触发 1–2 个局部切片横移 2–5cm、80–120ms 后复位；
- 数据丢失面积和持续时间设硬上限，任何时刻主体大部分结构必须可读；
- 体空间块噪声只做轻微 alpha/能量变化；禁止每帧 `Math.random()`；
- 以体表青/品红镶边替代真正的屏幕空间 RGB 色散；
- 增加一个低成本 additive 落地光盘；彻底移除 wireframe。

旧 `wraith/phantom` 映射为奇幻参数变体，`cyber/quantum` 映射为赛博参数变体，保存数据
保持可读，但 UI 首批只展示两个家族。

## 7. 性能预算与质量控制

以下全部是**预算目标，不是已验证事实**：

| 项目 | LOD0 / 高 | LOD1 / 中 | LOD2 / 低 |
|---|---:|---:|---:|
| 三角形 | ≤18k | ≤7k | ≤3k |
| 每灵体 draw | 4 | 3 | 2 |
| 粒子 | ≤300 | ≤120 | 0 |
| 背壳 | 开 | 关 | 关 |
| 单灵体三档几何显存 | 合计 ≤4MB | — | — |

场景预算：半透明 draw ≤14、可见三角形 ≤60k、每帧 JS uniform 更新 ≤2ms。重建目标为
Worker ≤1.2s、缓存命中 ≤120ms；必须由真机数据回填后才可写为通过。

质量控制器使用 120 帧滑窗：`P95 > 40ms` 或慢帧占比 `>5%` 时依次关闭背壳、粒子减半、
降低 LOD、降低 DPR；`P95 < 27ms` 持续 5 秒才升档，每次切换冷却 3 秒。距离 LOD
（4m/8m 初始阈值）与性能档位正交，取两者中更低质量。

## 8. 游戏级验收证据

### 几何

- 单连通分量，边界边为 0，无 NaN/Inf、退化三角和翻转法线；
- 头颈、双肩、腋下、骨盆、胯部和四肢无可见端盖/接缝；
- 四视角轮廓回投：正/背 IoU 目标 ≥0.85，侧面目标 ≥0.78；低质量输入必须标记置信度；
- 大腿水平截面有两个闭环，胸部水平截面一个闭环；
- 95% 相邻面法线夹角满足平滑门，最终阈值由 V1 基线标定。

### 画面

- 黑、白、代表性相机背景 × 两风格 × 正/侧/背/三分之四视角；
- 静态截图之外录制至少 10 秒时间序列，检查噪声游泳、闪烁、断层硬跳和轮廓爆点；
- 奇幻红/白变体都保留完整结构；赛博故障不能让完整人体退化成线框；
- 新旧几何并排截图，用户可直接判断人体是否摆脱几何人偶感。

### 性能

- 桌面只用于回归，不代替 iPhone；
- iPhone Safari：单灵体与三灵体各运行 5 分钟，记录平均 FPS、P95、慢帧率、档位和峰值内存；
- 10 分钟热衰减后不得持续跌破 LOD1；
- 真机通道不可用不阻塞几何开发，但阻塞最终“游戏级已完成”的结论。

## 9. 回滚边界

第二阶段所有新路径受 `ghostBodyV3` / `ghostRenderV3` 控制；旧管链和旧 shader 在验收完成前
保留为兜底。缓存按算法版本隔离。每张任务卡单独 commit、测试和构建，通过后才进入下一卡；
只推送 `gilka1456-rgb/ui-refactor`。
