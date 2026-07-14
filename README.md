# Bridge

在真实空间放置"人物虚像"(灵体 / 赛博 / 量子风格),让别人到同一地点用 AR 看见并留言互动。

- **iOS App**(`Bridge/`):SwiftUI + ARKit + RealityKit,真·空间 AR(世界追踪 + `ARWorldMap` 重定位)。这是产品主体。
- **Web 原型**(`core/web/`):Vite + TypeScript + three.js + MediaPipe,可在 Windows / 手机浏览器运行,用于扫描造像、360 预览与社交系统的快速迭代。**无空间 AR**(以 3D 场景模拟),iOS Safari 不支持 WebXR,故空间 AR 永远是 iOS 独有。

---

# 📌 给接手的 AI(Codex)的说明

> 本项目由一位**没有 Mac** 的开发者(以下称"机主")在 Windows 上开发。iOS target 目前已在 GitHub Actions macOS runner 上通过无签名 `xcodebuild` 编译,但**尚未在本机完整 Xcode 中签名安装到 iPhone 真机验证**。现在把**所有需要 Mac / iPhone 的工作**交给你(在机主朋友的 Mac 上运行的 Codex)。
>
> 机主会通过 GitHub 与你协作:你在 Mac 上构建 / 调试 / 实现需要 Mac 的功能,机主在 Windows 上用另一个 AI 改动纯逻辑代码。**所有涉及 Xcode 编译、真机、签名、CloudKit、AR 能力的任务都归你。**
>
> 凡是需要机主本人配合的地方,本文用 **🟡 需要机主配合** 明确标出。

## 协作流程(每次改动)
1. 你或机主在各自端改代码 → `git commit` → `git push`。
2. 另一端 `git pull` 获取最新。
3. 你在 Mac 上 `Cmd+R` 构建到机主的 iPhone 真机验证。
4. 遇到编译错误:直接在 Mac 上修(你能编译,机主不能),修完 push,并在 commit message 里说明改了什么,便于机主端 AI 同步理解。

分支约定:
- `main` = 当前开发版(新架构)。
- `legacy-2026-07-14-1036` = 旧版 Bridge 备份,**不要动**,仅供参考/回滚。

---

## 一、项目现状(交接基线)

### Web 端(已完成,`npm run build` 通过)
- 扫描造像、姿态识别、人体分割(MediaPipe)
- 灵体 / 赛博 / 量子风格虚像 + **视觉外壳(本人轮廓)渲染**(体素雕刻 + marching cubes)
- "我的放置"模块、小黑盒式嵌套评论(一级三态评价+回复 / 二级点赞+回复)、退出/删除确认弹窗、语音提示
- 逐朝向全高人体分割 mask 采集,base64+RLE 存于 `AvatarPose.orientations`

### iOS 端(功能/数据层完成,视觉外壳已实现,**待真机验证**)
- 与 Web 对齐的社交系统:`Comment` / 三态评价 / 点赞、`LocalStore` 持久化、`MyPlacementsView`、`PlacementDetailView`、`CommentThreadView`
- 空间 AR:世界追踪 + `ARWorldMap` 放置/重定位(`PlaceARView` / `DiscoverARView` / `AnchorPersistence`)
- **视觉外壳渲染**:`AR/VisualHull.swift`(RLE 解码→64×128×64 雕刻→marching cubes→`MeshResource`),`GhostEntityBuilder` 在 orientations ≥ 2 时渲染外壳,否则回退胶囊
- 逐朝向分割 mask 采集(`VNGeneratePersonSegmentationRequest`),RLE 格式与 Web 互通
- **阶段 A(Discover 就近重定位)**:已实现 GPS 就近排序、逐 worldmap 尝试、15s 超时引导、稳定点击碰撞目标和实体射线点击命中 —— **需真机验证与调参**
- **阶段 B(CloudKit 云同步)**:仅骨架 `Services/CloudSyncService.swift` —— 方法体是 TODO
- **阶段 C(空间定位抽象)**:仅骨架 `Services/SpatialLocalizer.swift`(WorldMap / AppleGeo / EasyAR / Huawei / GPS 兜底)—— 多为 stub

### 已知配置
- 最低系统:**iOS 17.0**(用了 `ContentUnavailableView` / 双参数 `onChange`)
- `DEVELOPMENT_TEAM` 为空,需设置签名
- Swift 5 / 目标 Xcode 15+
- 33 个 Swift 文件,pbxproj 覆盖已核对为 33/33

---

## 二、第一次构建并装到真机(你的首要任务)

### 前置
- macOS + **Xcode 15 或更新**
- 机主的 iPhone(**iOS 17+**,A12 及以上芯片,因为 AR 需要)
- 数据线或同一 Wi-Fi(无线调试)

### Codex 预检
装好完整 Xcode 后,先在仓库根目录运行:

```bash
./scripts/static_audit.sh
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
./scripts/preflight.sh
```

静态审计不依赖 Xcode,会先确认 Info.plist 权限、iOS target、工程文件引用和单机 AR MVP 关键标记。预检会继续确认 Xcode / iPhoneOS SDK / Xcode project / Web build。通过后再进入真机签名和 `Cmd+R`。

真机签名、装机、权限和日志诊断见 [`docs/iphone_device_setup.md`](docs/iphone_device_setup.md)。
真机单机 MVP 的逐项验收记录见 [`docs/iphone_mvp_test_plan.md`](docs/iphone_mvp_test_plan.md)。
App 内置 `诊断` Tab 会显示设备 AR 支持、本地数据数量、WorldMap 文件状态和最近 AR 事件；真机失败时先导出诊断报告，再附 Xcode 日志和录屏。

### 步骤
1. `git clone https://github.com/gilka1456-rgb/Bridge.git && cd Bridge`
2. 打开 `Bridge.xcodeproj`
3. **签名**:项目 → TARGETS → Bridge → Signing & Capabilities
   - 勾选 Automatically manage signing
   - **🟡 需要机主配合**:`Team` 需要一个 Apple ID。可用你(朋友)的免费 Apple ID 先跑(签名 7 天有效);若要长期/TestFlight,需机主的 **Apple 开发者账号($99/年)**。
   - Bundle Identifier 若冲突,改成唯一值如 `com.<名字>.bridge`
4. 顶部选中机主的 iPhone → `Cmd+R`
5. **🟡 需要机主配合**:iPhone 首次装完,到"设置→通用→VPN 与设备管理→信任开发者证书";运行时**允许相机 / 定位 / 运动**权限

### 若构建报错
你能编译,直接在 Mac 上修。常见风险见第四节。修完 `git commit && git push`,commit message 写清改动点。

---

## 三、真机验证清单(构建通过后逐项测)

| # | 验证项 | 预期 | 需要机主? |
|---|--------|------|-----------|
| 1 | 扫描造像 | 正/右/背/左 四朝向采集,生成虚像 | 🟡 机主本人被扫 |
| 2 | 视觉外壳 | 采到 ≥2 朝向后,预览/看见里是**本人轮廓网格**而非胶囊;仅 1 朝向时回退胶囊 | 🟡 |
| 3 | 外壳质量 | 无明显破面/穿插(见第四节 MarchingCubes 风险) | |
| 4 | 放置 | 对准地面点击放置虚像,`ARWorldMap` 保存成功 | 🟡 需在真实空间 |
| 5 | 看见/重定位 | 回到放置点,GPS 就近加载 worldmap,重定位成功后原位显示虚像 | 🟡 需回到原地点 |
| 6 | 重定位失败引导 | 失败时提示"缓慢环视…"并尝试下一张地图 | 🟡 |
| 7 | 点击命中 | 点某个虚像弹出**它**的卡片 + 评论线程 | 🟡 |
| 8 | 社交 | 评论/三态评价/回复/点赞/删除(确认)均正常持久化 | |
| 9 | 我的放置 | 列表、汇总、删除(确认)正常 | |
| 10 | 退出确认 | 扫描中途切页有确认弹窗 | |

把有问题的项截图/录屏,连同 Xcode 日志发机主转交对应 AI。

---

## 四、已知风险与排查点(静态审查发现,你在 Mac 上确认)

1. **签名**:`DEVELOPMENT_TEAM` 为空,必设(见上)。
2. **CloudKit**:`CloudKitSyncService` 能编译但**未启用**;若添加 iCloud capability 后报错,需配置容器与 record schema(见第五节阶段 B),否则可暂不加该 capability,不影响本地功能。
3. **ARGeoTracking**:`AppleGeoLocalizer` 仅在 Apple 支持的城市/户外可用,stub 在不支持处会抛错——阶段 C 才启用,当前不影响。
4. **MarchingCubes 三角表**:`AR/MarchingCubesTables.swift` 的 `triTable` 有 360 组(标准 256)。索引 0–255 使用,多出部分为冗余。**不阻断编译**,但**可能导致外壳网格破面**。若验证项 3 出现破面,需用标准 256 组 triTable 校对替换。
5. **Body tracking**:`ARBodyTrackingConfiguration` 需 A12+ 且后置摄像头;模拟器不支持,必须真机。
6. **定位朝向**:目前 GPS 已接,但 heading(罗盘朝向)尚未完全接入放置朝向,阶段 A 可完善。
7. **iOS 版本**:静态审查基于常见 API;若 Xcode/iOS 版本差异导致 `MeshDescriptor` / `onChange` / `ContentUnavailableView` 报错,按报错微调。

---

## 五、路线图任务(交给你实现,需 Mac + 部分机主配合)

> 建议顺序:先把第二~四节的**构建+验证**跑通(纯本地,零成本),再做阶段 B/C。

### 阶段 A — Discover 就近重定位打磨(纯本地,可立即做)
现状:已实现 GPS 排序 + 逐图尝试 + 超时引导 + 点击命中。你的任务:
- 真机调参:重定位超时时长、就近半径、失败重试 UX
- 把罗盘 heading 接入放置/显示朝向(见风险 6)
- **🟡 需要机主配合**:到真实地点反复放置/重定位测试成功率

### 阶段 B — CloudKit 云同步(让"别人也能看到")
目标:worldmap + 放置 + 虚像 + 评论上云,别人按 GPS 就近下载并重定位。
- 实现 `CloudSyncService` / `CloudKitSyncService` 的 TODO:Public DB 记录(`PlacementRecord` 含 location 索引 + worldMap CKAsset + visibility、`AvatarPoseRecord`、`Comment*Record`)
- 本地 `LocalStore` 作缓存,写先本地后入队上传;读先本地后云端刷新
- 放置上传 worldmap(CKAsset)+ 元数据;看见按 GPS `CKQuery` 距离查询→下载→重定位
- 隐私:每条放置 public/private 开关(数据模型已有 `visibility` 字段);上传 worldmap 前需用户同意(worldmap 含他人空间特征点)
- 审核兜底:举报 / 隐藏 / 拉黑(留言已过 `MessageModeration`)
- **🟡 需要机主配合(凭证类)**:
  - 开通 **Apple 开发者账号($99/年)**
  - 在 Xcode 加 **iCloud / CloudKit capability**,创建容器 `iCloud.com.<team>.Bridge`,启用 **Public Database**
  - CloudKit Dashboard 里建好各 record type 的字段与索引(location 需建 queryable 索引)

### 阶段 C — 户外城市级 VPS(可选,后期)
抽象层 `SpatialLocalizer` 已就位,按区域择优:室内/近场用 worldmap,户外用 VPS。
- 海外:实现 `AppleGeoLocalizer`(`ARGeoTrackingConfiguration` + `checkAvailability(at:)` + `ARGeoAnchor`)
- 中国大陆:实现 `EasyARLocalizer` 或 `HuaweiCloudAnchorLocalizer`(Apple/Google 服务在陆不可用)
- 兜底:`GpsCompassLocalizer`(米级,会漂)
- 放置记录已预留 `geoAnchor` + `vpsMapId/vpsAnchorId` 多锚点字段
- **🟡 需要机主配合(凭证类)**:
  - 中国大陆:申请 **EasyAR(视辰)Spatial Map** 或 **华为 AR Engine 云锚点** 的授权 key
  - 海外:Apple GeoAnchor 无需 key(仅需区域支持);若用 ARCore Cloud Anchors 需 Google API key

---

## 六、🟡 需要机主配合的事项(汇总)
| 事项 | 何时 | 说明 |
|------|------|------|
| 提供 iPhone 真机(iOS 17+, A12+) | 构建前 | ARKit 必须真机 |
| 信任开发者证书 + 授权相机/定位 | 首次运行 | iPhone 设置里操作 |
| 被扫描 / 到真实地点测试放置与重定位 | 验证阶段 | AR 只能实地测 |
| Apple 开发者账号($99/年) | 阶段 B 或想用 TestFlight | 免费 Apple ID 也能装,但 7 天过期 |
| 开通 iCloud/CloudKit 容器 | 阶段 B | 云同步前提 |
| 申请 VPS key(EasyAR/华为/Google) | 阶段 C | 户外城市级定位 |

---

## 七、Web 原型(机主在 Windows / 手机自测,零成本)

```bash
cd core/web
npm install
npm run dev      # 本地开发
npm run build    # 生产构建
```
- **相机需 HTTPS 或 localhost**;手机浏览器打开请用 HTTPS 隧道,否则相机被拦。
- 覆盖:扫描造像、视觉外壳、我的放置、嵌套评论、语音。空间 AR 为 iOS 独有。

---

## 八、目录结构
```
Bridge/                 iOS 源码
  Models/               AvatarPose, Placement, Comment, OrientationMask, GhostStyle, SilhouetteTypes
  Services/             LocalStore, AnchorPersistence, PersonSegmentationCapture, PersonMaskRLE,
                        MessageModeration, CloudSyncService(骨架), SpatialLocalizer(骨架)
  AR/                   GhostEntityBuilder, VisualHull, MarchingCubesTables, ARViewContainer, PoseCaptureManager
  Views/                MainTabView, ScanARView, PlaceARView, DiscoverARView, MyPlacementsView,
                        PlacementDetailView, AvatarsListView, AvatarDetailView, GhostPreviewView,
                        Components/(CommentThreadView, AvatarDeleteConfirmation, MessageInputView)
Bridge.xcodeproj/       Xcode 工程
core/web/               Web 原型(Vite + TS + three.js)
```
