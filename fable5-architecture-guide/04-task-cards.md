# 04 · 任务卡(交付 GPT-5.6-sol 逐项执行)

> 执行约定:
> - 分支:全部在 `gilka1456-rgb/ui-refactor` 上做,**不碰 `main`**;
> - 每张卡独立 commit,跑 `npm run test:run` + `npm run build` 通过后再进下一张;
> - 顺序:T1 → T2 → T3 → T5 → T6 → T4 → T7 → T8(T4 之后的可按需调序);
> - T9 是 iOS 侧(朋友负责),仅需在契约文档写清,不在本分支实现。

---

## T1 · 关键点锚定归一化 ★根因修复

**文件**:`pose/segmentation.ts`、`main.ts`(`applyBucketCapture`)、`models/types.ts`

**步骤**:
1. `models/types.ts`:`OrientationMask` 增加 `anchor?: { pelvis: {x,y}; anchorHeight: number }`
   与 `jointSignature?: number[]`(契约见 02 §C);
2. `segmentation.ts` 新增 `anchorNormalizePersonMask(mask, w, h, landmarks)`:
   - 按 02 §A 公式:骨盆中点→画布 (128, 296),骨盆→头顶像素高→210,画布 256×512;
   - 内部仍做最大连通域 + 闭运算(复用现有工具);
   - 返回 `{ mask, width, height, personAspect(=肩宽/锚高), anchor }`;
   - 关键点不足(髋/鼻不可见)时返回 null,调用方回退现有 `normalizePersonMask`;
3. `applyBucketCapture` 优先走锚定版,成功时写入 `anchor` 字段;
4. `visual-hull.ts` 的 `projectToMaskUV`:视角带 `anchor` 时,世界 y=0 ↔ 画布
   `anchor.pelvis.y`,比例由 `anchorHeight` 换算(02 §A);无 anchor 走现有逻辑;
5. `VISUAL_HULL_ALGORITHM_VERSION` → `"anchored-hull-v3"`。

**验收**:
- 新单测:同一人形掩码 + 举手变体(手顶到画面顶),包围盒版头部错位 >10%,
  锚定版头部纵向偏差 <2%;
- 四向锚定掩码雕刻出的网格,头部区域(y > 0.6×身高)有独立凸起(用
  `visual-hull.test.ts` 的分层截面统计断言);
- 旧数据(v2/v1)解码路径回归测试不破。

---

## T2 · 双线性栅格化(消横纹)

**文件**:`pose/segmentation.ts`

**步骤**:
1. 归一化重采样从「正向逐源像素 round 写入」改为「逆向遍历目标像素 + 双线性采样,
   ≥0.5 判 1」;
2. 输出前一次 3×3 盒式模糊 + 0.5 阈值化(替代/叠加现有闭运算,以实测为准);
3. 锚定版(T1)与包围盒版共用该栅格化。

**验收**:
- 单测:斜线边缘掩码经归一化后,逐行边缘 x 坐标的二阶差分绝对值之和
  较现实现下降 ≥50%(量化「台阶感」);
- 雕刻结果目视无水平棱纹(预览页人工确认)。

---

## T3 · 姿势一致性门

**文件**:`pose/scan-session.ts`、`main.ts`、`models/types.ts`

**步骤**:
1. `scan-session.ts` 新增 `computeJointSignature(landmarks): number[]`
   (8 关节角:左右肩外展/肘弯/髋外展/膝弯)与
   `signatureDeviation(a, b): number`(最大关节角差,度);
2. 会话首个捕获向的签名为基准;后续向偏差 >25° → 不入库,
   guidance 文案:「姿势和正面不一致,请保持同一姿势转身」;
3. 签名写入 `OrientationMask.jointSignature`;
4. 扫描引导语开头加一句:「双臂自然下垂或微微张开,扫描全程保持不动」。

**验收**:
- 单测:构造肘弯 90° vs 0° 的两组关键点,`signatureDeviation` >25°,门拦截;
  同姿势轻微抖动(<10°)放行;
- 语音/文字提示在拦截时出现(现有 guidance 管道)。

---

## T5 · 模板人体混合 ★完整性保证

**文件**:新增 `ghost/template-body.ts`;改 `ghost/body-silhouette.ts`、
`ghost/reconstruction-provider.ts`

**步骤**:
1. `template-body.ts`:
   - `buildTemplateBodyGeometry(landmarks, params): BufferGeometry` ——
     程序化生成 14 段连续蒙皮人体(02 §B),params = { 肩宽、髋宽、身高、头径 },
     由关键点估计,缺省用标准比例;
   - 关节共享顶点环,平滑法线;三角形 ≤5k;
2. `shrinkWrapToHull(templateGeom, hullSdfSampler, regionMask)`:
   躯干/骨盆/大腿顶点沿法线位移(clamp −3cm/+6cm),其余部位不动;
   hull SDF 采样器由 `visual-hull.ts` 导出(复用雕刻期的体素场,
   随 mesh 一起缓存或按需重建);
3. `body-silhouette.ts` 兜底链改为:
   `外壳质量 ≥0.45 → 模板+包裹;有关键点 → 纯模板;否则 → 现有胶囊`;
4. 缓存 key 加模板参数 hash(`reconstruction-provider.ts`)。

**验收**:
- 单测:任意合法关键点输入,输出几何无 NaN、三角形 ≤5k、
  包围盒高宽比在人体合理区间(2.2–4.5);
- 单测:只有 2 个视角且质量分 0.3 时,输出仍是完整人形(纯模板路径);
- 预览目视:头/颈/肩/臂/腿分明,不再是柱体。

---

## T6 · 柔和灵体材质

**文件**:`ghost/ghost-shader.ts`、`ghost/body-silhouette.ts`、`ghost/styles.ts`

**步骤**(规格全表见 02 §D):
1. 菲涅尔指数 2.2 → 1.5;发光钳制 `uEmissive ≤0.35`;扫描线默认关,
   仅 cyber 风格保留(频率 *10、强度减半);
2. styles.ts 调色:灵体=雾蓝 #AECBEB,基础 α 0.55;
3. 顶点噪声位移(幅度 0.8cm,周期 8s,两个不同频率正弦叠加即可,无需噪声纹理);
4. 洋葱壳:`body-silhouette.ts` 对最终几何加 2 层膨胀副本
   (scale 1.025/1.06,α 0.35/0.15,`AdditiveBlending`,共享几何);
5. 脚部消散:fragment 按世界高度 <0.12m 渐隐 + hash 噪声侵蚀。

**验收**:
- 三风格截图对比留档;手机 Chrome 实测 ≥30fps(用现有测试页);
- 无后处理 pass 引入。

---

## T4 · 身体直立坐标系(躺姿支持)

**文件**:`pose/scan-session.ts`、`pose/segmentation.ts`、`main.ts`

**步骤**:
1. `computeBodyTilt(landmarks): number`(neck-pelvis 轴与竖直夹角);
2. `tilt > 15°` 时:关键点与掩码绕图心旋转 `-tilt` 后再进 T1 锚定归一化
   (掩码旋转用逆向映射双线性,复用 T2 采样器);
3. 方位角估计改在旋转后的关键点上执行;
4. `tilt > 60°` UI 提示「检测到躺姿,已自动校正」;可见关键点 <20 拒收。

**验收**:
- 单测:站姿关键点整体旋转 90°(模拟躺姿)后,归一化输出与站姿原始输出
  IoU ≥0.85;
- 方位角在旋转前后判定一致。

---

## T7 · 调试可视化

**文件**:`main.ts`(扫描预览页)

**步骤**:
1. 预览页加「调试」折叠区(默认收起):四向归一化掩码缩略图(canvas 直绘)、
   每向 quality / jointSignature 偏差 / anchor 是否存在;
2. 重建失败码与耗时展示(`ReconstructionResult` 已有字段)。

**验收**:目视可在 10 秒内判断「哪个视角错位/质量差」。

---

## T8 · 照片导入采集

**文件**:`main.ts`(虚像页)、`pose/capture.ts`、复用 `features/image-file.ts`

**步骤**:
1. 虚像页加「从照片创建」入口:选 2–4 张图 → MediaPipe 静态图模式逐张跑
   关键点+分割;
2. 每张走 T4→T3→T1→T2 同一管线;方位角自动判定 + 四槽位(正/背/左/右)
   手动拖拽纠正 UI;
3. 质量门不合格给具体原因文案;原图不入库,只存 OrientationMask(隐私);
4. 入库后走统一重建管线。

**验收**:用本次测试的四张生成图走完整流程,产出完整分明人形
(这是本文档的直接成因,作为端到端回归用例)。

---

## T9 · iOS 镜像清单(朋友,`main` 分支,仅契约同步)

在 `MAC_INTEGRATION.md` 写入 OrientationMask v3 契约(02 §C)后通知朋友:

| iOS 文件 | 镜像内容 |
|---|---|
| `Services/PersonMaskRLE.swift` | v3 anchor 字段编解码;v2/v1 兼容规则同 Web |
| `Services/PersonSegmentationCapture.swift` | Vision 关键点锚定归一化(骨盆+锚高,同参数 256×512/(128,296)/210) |
| `AR/VisualHull.swift` | anchor 投影(世界 y=0 ↔ pelvis.y);算法版本号同步 `anchored-hull-v3` |
| `AR/GhostEntityBuilder.swift` | 兜底链对齐:模板+包裹 → 纯模板 → 胶囊(模板生成算法可从 Web 移植) |
| 材质 | RealityKit CustomMaterial 按 02 §D 参数对齐(色值/α/菲涅尔/消散) |

汇合点:双方各自完成后,机主分支 PR 进 `main`,真机验证数据互通。

---

## 端到端验收(全部完成后)

1. 四张测试生成图 → 照片导入 → 产出**头/臂/腿分明、轮廓柔和、颜色温和**的完整灵体;
2. 活体扫描挥手干扰下,一致性门拦截或模板兜底,不再出现柱体;
3. 躺姿模拟关键点可正常建像;
4. 只扫上半身 → 完整人形(下半身标准体型)+ `partial` 标记;
5. `npm run test:run` 全绿,`npm run build` 通过,手机 30fps。
