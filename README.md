# Bridge

Bridge 是一个“真人扫描 → 3D 虚像 → 场景展示”的产品原型。当前仓库同时包含：

- Web/3D 原型：在 Windows 和移动端浏览器中完成人体扫描、3D 建模、虚像预览、模拟放置与内容记录。
- iOS 原生 App：使用 SwiftUI、ARKit 与 RealityKit 实现真实空间中的放置和重定位。

Web 端的“看见”和“放置”是相机叠加与 3D 场景模拟，不是空间 AR；真实空间追踪属于 iOS 原生 App。

## 当前分工

| 范围 | 目录 | 负责人 | 分支 |
|---|---|---|---|
| Web 人体扫描、3D 建模、网格生成、Three.js 渲染及相关文档 | `core/web/`、`README.md` | Windows 端 | `gilka1456-rgb/ui-refactor` |
| iOS 原生 App、Xcode、ARKit、RealityKit、CloudKit、签名与真机验证 | `Bridge/`、`Bridge.xcodeproj/`、iOS 文档 | Mac 端 | `main` |

协作规则：

- Windows 端只向 `gilka1456-rgb/ui-refactor` 提交和推送。
- `main` 默认只读；只有在明确提出要求时，Windows 端才拉取或整合 `main`。
- Windows 无法运行 Xcode、连接 iPhone 或执行 macOS 专用检查属于正常情况，不阻塞 Web/3D 工作。

## Web/3D 当前能力

### 人体扫描

- 使用 MediaPipe Pose Landmarker 获取 33 点人体姿态。
- 使用 MediaPipe Image Segmenter 生成人体二值分割掩码。
- 优先使用 GPU，初始化失败时自动回退到 CPU。
- 根据肩部深度估计正面、右侧、背面、左侧四个朝向。
- 按人物垂直覆盖、边缘裁切和掩码面积计算采集质量；四个真实朝向全部有效后才能完成扫描。
- 支持实时覆盖率、转身提示、语音引导和退出保护。
- 每个朝向融合 5 帧稳定分割结果，并将人体等比例居中到统一的 `128 × 256` 坐标画布。
- 各朝向规范化掩码使用 base64 + RLE 保存到 `AvatarPose.orientations`，同时记录宽高比、帧数和质量。

### 3D 建模与渲染

- 将多朝向人体掩码转换为有符号距离场，在 `64 × 128 × 64` 体素空间执行带误差容忍的 Visual Hull 雕刻。
- 使用共享顶点的 Marching Cubes 生成网格，再通过 Taubin 平滑和法线重算获得连续表面。
- 雕刻、网格生成和平滑在 Web Worker 中执行；结果按源数据哈希缓存在 IndexedDB。
- 新扫描只有在完整人体网格通过验证后才能保存，不再静默回退为火柴人；旧数据使用兼容重建或连续圆润人形近似。
- 兼容灵体、幽灵、赛博、量子四种既有存档 ID；Spectral V3 将前两者映射为奇幻家族、后两者映射为赛博家族。
- 正式 Web 路径默认启用连续人体、V3 渲染、V5 奇幻灵体与 V6 赛博投影；奇幻和赛博效果会按存档风格自动分流，不会叠加。紧急回退可分别使用 `ghost-body-v3=0`、`ghost-render-v3=0`、`ghost-fantasy-v5=0`、`ghost-cyber-v6=0`。
- 虚像库支持旋转预览、删除和重复使用已保存扫描结果。

### 当前产品流程

Web 端包含五个主入口：

1. `看见`：相机画面与虚像叠加，支持全部、别人、自己三种筛选及快门拍摄。
2. `虚像`：扫描新虚像、查看虚像库和旋转预览。
3. `放置`：选择虚像、调整位置与方向、保存本地模拟放置。
4. `记录`：从“我的照片”选择图片发布本地记录，并支持点赞、评论与分享。
5. `我的`：管理照片、放置、个人资料、好友、聊天和设置。

当前 Web 原型没有后端：

- 结构化数据保存在 `localStorage`。
- 照片和头像媒体保存在 IndexedDB。
- 发布记录时会复制独立媒体资产，删除源照片不会同时删除帖子图片。
- 启动时会迁移旧数据并清理没有引用的媒体文件。
- 漂流模式会隐藏评论和社交入口，只保留点赞能力。

## 技术栈

| 类型 | 技术 |
|---|---|
| 开发语言 | TypeScript |
| 构建工具 | Vite 6 |
| 3D 渲染 | Three.js |
| 姿态与人体分割 | MediaPipe Tasks Vision |
| 本地媒体存储 | IndexedDB |
| 结构化数据存储 | localStorage |
| 测试 | Vitest、jsdom、fake-indexeddb |
| CI 基线 | Node.js 20 |

## 在 Windows 运行 Web 原型

要求：

- Node.js 20 或更新版本。
- 支持 WebGL、摄像头和 IndexedDB 的现代浏览器。
- 首次加载 MediaPipe WASM 和模型时需要网络连接。

在仓库根目录执行：

```powershell
npm.cmd --prefix core/web ci
npm.cmd --prefix core/web run dev
```

开发服务器默认地址为 `https://localhost:5173`，也会监听局域网地址。首次打开时浏览器可能提示本地开发证书风险。

摄像头 API 需要 HTTPS 或 localhost。手机测试时应打开开发服务器提供的 HTTPS 局域网地址，并在浏览器中允许摄像头权限。

如果当前 PowerShell 允许直接运行 `npm`，也可以使用：

```powershell
cd core/web
npm ci
npm run dev
```

## 测试与构建

在仓库根目录执行：

```powershell
npm.cmd --prefix core/web run test:run
npm.cmd --prefix core/web run build
```

提交 Web/3D 修改前，这两个命令都应通过。

`scripts/static_audit.sh` 和 Xcode 编译属于 macOS/Linux 或 CI 环境检查；Windows 端无法直接运行时不视为 Web/3D 阻塞。

## 目录结构

```text
core/web/
  src/
    app/             页面生命周期、DOM 与隐私工具
    features/        导航、记录、聊天、图标与图片工具
    ghost/           Visual Hull、Marching Cubes、材质和 Three.js 渲染
    models/          Web 数据类型
    pose/            MediaPipe 捕获、分割、朝向判断与扫描质量
    services/        本地数据、媒体存储和文本审核
    views/           看见与记录等页面模块
    main.ts          Web 应用入口和页面协调

Bridge/
  AR/                iOS AR 与原生视觉外壳
  Models/            iOS 数据模型
  Services/          本地存储、锚点、诊断与同步接口
  Views/             SwiftUI 页面

Bridge.xcodeproj/    Xcode 工程
docs/                iPhone 构建与真机测试文档
scripts/             CI、静态检查和设备预检脚本
```

## 当前 Web/3D 开发重点

当前沿 `fable5-architecture-guide/06-spectral-v3-task-cards.md` 实施 Spectral V3：

1. V0 已固定 17 骨契约、功能开关和旧几何四视图基线。
2. V1 已建立 1.8cm 解剖隐式场、受限 Visual Hull 融合和连续水密标准 A-pose；现已成为正式默认人体路径。
3. V2 已完成程序化四骨权重、链式姿势烘焙和版本隔离的 `GhostBodyModel` 本地缓存。
4. V3 已完成结构深度预写、预乘透明主表面、加色背壳、sRGB/NoToneMapping 和确定性视觉证据；默认启用并保留独立回退开关。
5. V4 已完成同源 1.8/2.8/4.2cm 融合场、预算内三级重网格、GPU `SkinnedMesh` 姿势、CPU 回退及 120 帧质量建议控制；自动切档等待 V7 iPhone 实测后再开启。
6. V5.7 红灵/白灵共用同一奇幻 shader：体内能量、主轮廓壳与低密度外层光晕分工渲染；主表面使用视线厚度吸收代替实体式方向高光，厚处沉入阴影、薄处透出魂光，并以稳定雾化噪声打散外缘。向上流动的内层魂流与连续孔隙进一步削弱透明塑料感，同时保留完整人体轮廓。180/72/0 分档 GPU 微粒只提供轻雾漂移；白灵另有正常混合的深色对比轮廓，在明亮场景中也不会融入背景。
7. V6.6 赛博人物投影已实现青／紫双预设、细扫描带、数据块、地面投影源、96/40/0 分档空间信号符号，以及每 3.2 秒一次、持续 120ms 且可完全恢复的局部相位事件；最高画质增加独立相位余像层，在平时保留微弱载波断层、相位事件中生成短距离色散错位。投影源作为地面与人体之间的独立 decal 渲染，不再被预览地板遮挡，身体周围的十字数据包用于表现低信号传输。
8. 两种风格共享同一人体、骨骼、深度、LOD 和质量架构；四张全身测试图已全部通过识别（单图轮廓质量 91%–97%，重建质量 90%）。姿势以标准骨盆为根节点，照片取景偏移不会再平移或压低人物；局部缺脚的正面帧会自动让位给完整背面帧，不再破坏躯干和双腿。
9. 当前预览采用适合手机审查且能容纳举手姿势的全身构图；掌心由拇指／食指／小指关键点独立控制，不再只能沿前臂拉成长尖片。手掌、髋部、腿间分离及两类近距离材质均已完成新一轮收敛；下一步进入 iPhone 真机验收。
10. 持续保持扫描、媒体生命周期、本地数据迁移和旧渲染回退测试完整。

## 相关文档

- [隐私说明](PRIVACY_POLICY.md)
- [Web 与 iOS 数据整合约定](MAC_INTEGRATION.md)
- [iPhone 设备配置](docs/iphone_device_setup.md)
- [iPhone MVP 真机测试计划](docs/iphone_mvp_test_plan.md)

iOS、Xcode 和真机文档由 Mac 端维护；Windows 端仅在明确需要同步接口或修正文档时修改。
