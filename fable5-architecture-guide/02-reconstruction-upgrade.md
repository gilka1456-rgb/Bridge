# 02 · 重建管线升级设计

本文定义三块核心升级的**设计与数据契约**:A. 关键点锚定归一化;B. 模板人体混合;
C. OrientationMask v3;D. 柔和灵体视觉规格。实现步骤拆分见 `04-task-cards.md`。

---

## A. 关键点锚定归一化(替代包围盒)

### 原则

对齐基准必须选**姿势不变量**。包围盒会被四肢动作污染;骨盆和头顶不会。

### 定义

每个视角在采集时已有 33 关键点(MediaPipe pose,归一化图像坐标)。取:

```
pelvis  = midpoint(landmark[23], landmark[24])        # 左右髋中点
headTop = landmark[0].y - 0.35 * |landmark[0].y - midpoint(l[11],l[12]).y|
          # 鼻→肩距外推头顶;两耳可见时用 midpoint(l[7],l[8]) 上移半头高更准
anchorHeight = |pelvis.y - headTop.y|                 # 锚定尺度(像素)
```

归一化变换(对掩码像素):

```
scale   = TARGET_ANCHOR_HEIGHT / anchorHeight         # 统一「骨盆→头顶」像素高
tx      = TARGET_PELVIS_X - pelvis.x * scale          # 骨盆水平居中
ty      = TARGET_PELVIS_Y - pelvis.y * scale          # 骨盆放在固定纵向位置
```

建议画布 256×512,`TARGET_PELVIS = (128, 296)`,`TARGET_ANCHOR_HEIGHT = 210`
(即骨盆上方留 ~40% 给上身+头,下方留 ~42% 给腿,两侧余量容纳张开的手臂)。

### 与雕刻的衔接

- 雕刻投影(`projectToMaskUV`)从「掩码即体素包围盒」改为「骨盆锚点即世界原点」:
  世界 y=0 对应画布 `TARGET_PELVIS_Y`,比例由 `TARGET_ANCHOR_HEIGHT` 换算。
- `personAspect` 继续用于正/侧宽度区分,但改为**躯干宽度比**(肩宽/锚高),
  不再受手臂影响。

### 兼容

- v2 数据(现有 `normalized:true` 无锚点):解码时退回包围盒对齐(现状行为),
  并打上 `legacyAlignment` 调试标记;
- v1 数据(整帧):现状兜底逻辑不变。

---

## B. 模板人体混合(保证「完整分明」的关键)

### 为什么外壳独木不成林

剪影交集的物理性质决定:四向姿势稍有不一致,四肢就会被雕掉(见 01 症状 1);
即便完全一致,腋下/跨部等凹陷也不可恢复。**「完整分明的人体」必须由模板保证,
外壳降级为「宽度/体型提示」。**

### 组成

1. **模板资产**:程序化生成的低模人体(无需外部文件)——
   头(球体)/颈(短柱)/躯干(渐变宽椭柱)/骨盆/左右大小臂/左右大小腿/手脚(胶囊),
   共 ~14 段,每段横截面 8–12 边,合计 3–5k 三角形。
   生成参数化:肩宽、髋宽、身高、头径 —— 全部可由关键点与外壳统计推出。
2. **姿态驱动**:33 关键点 → 每段骨骼的位置与朝向(现有 `buildBodyCore`
   的骨架逻辑可直接复用其关节配对表),但输出是**连续蒙皮网格**而非分离胶囊:
   相邻段在关节处共享环形顶点圈,消除「积木感」。
3. **外壳收缩包裹(shrink-wrap)**:
   - 对模板每个顶点,沿其法线在外壳 SDF 场里查表面距离;
   - 位移 `d = clamp(sdfSurfaceOffset, -maxIn, +maxOut)`,建议 `maxIn=3cm`、`maxOut=6cm`;
   - 仅对**躯干/骨盆/大腿**段启用(这些段外壳可信);手臂/头部只用模板
     (外壳在这些区域最容易被雕坏);
   - 外壳质量分(`ReconstructionResult.quality`)低于阈值(建议 0.45)时整体跳过包裹。
4. **兜底链**:

```
外壳质量高  → 模板 + 收缩包裹(个性化体型)
外壳质量低  → 纯模板(关键点姿态,标准体型)
无关键点   → 现有胶囊兜底(理论上不应触发)
```

### 输出

单一 `BufferGeometry`(共享顶点、平滑法线),与现有 `hull-cache` /
IndexedDB 缓存管线兼容(缓存 key 加入模板参数 hash)。

---

## C. OrientationMask v3 契约

```ts
interface OrientationMask {
  azimuth: number;            // 身体坐标系方位角(0/90/180/270 或连续值,见 03 §T4)
  width: number; height: number;
  mask: string;               // RLE + base64(不变)
  normalized?: boolean;       // v2 遗留
  personAspect?: number;      // v3 起 = 躯干宽度比(肩宽/锚高)
  // —— v3 新增 ——
  anchor?: {
    pelvis: { x: number; y: number };   // 画布像素坐标
    anchorHeight: number;               // 骨盆→头顶像素高
  };
  jointSignature?: number[];  // 8 个关节角(度),供姿势一致性门(T3)
  quality?: number;           // 已有
}
```

规则:

- `anchor` 存在 → 锚定对齐;仅 `normalized` → 包围盒对齐;都无 → 整帧兜底。
- 该契约必须同步写入 `MAC_INTEGRATION.md`,iOS 侧(朋友,`main` 分支)按 T9 镜像。
- `VISUAL_HULL_ALGORITHM_VERSION` 升为 `anchored-hull-v3`,旧缓存自动失效(key 含版本)。

---

## D. 柔和灵体视觉规格(T6)

目标:**分明但柔和** —— 结构清晰可辨,边缘发虚,颜色温和,不刺眼、不科技感。

| 参数 | 现状 | 目标 |
|---|---|---|
| 基色 | 高饱和 + 高发光 | 淡彩(如雾蓝 #AECBEB / 暖白 #F2EBDD),`uEmissive ≤ 0.35` |
| 菲涅尔 | pow 2.2,强边缘光 | pow 1.4–1.7,边缘光颜色 = 基色提亮 15%,不换色相 |
| 扫描线 | vUv.y*28 高频扫描 | **默认关闭**;仅「赛博」风格保留(频率降到 *10,强度减半) |
| 闪烁 | 量子风格噪声闪烁 | 保留但幅度 ≤8% |
| 轮廓 | 硬边 | 洋葱壳 ×2(scale 1.025/1.06,α 0.35/0.15,additive)柔化 |
| 表面 | 静止 | 顶点低频噪声位移,幅度 0.6–1cm,周期 6–10s(呼吸感) |
| 脚部 | 直接落地 | 世界高度 <0.12m 起 alpha 渐隐至 0.15 + 噪声侵蚀 |
| 体饱和 | — | 中心略透(α 0.55),边缘因菲涅尔升到 0.85 —— 「体积感来自边缘」 |

性能红线:不引入后处理(bloom);洋葱壳共享几何仅换材质;手机 30fps 底线。
