# Bridge

在真实空间放置"人物虚像"(灵体/赛博/量子风格),让别人到同一地点用 AR 看见并留言互动。

- **iOS App**(`Bridge/`):SwiftUI + ARKit + RealityKit,真·空间 AR(世界追踪 + `ARWorldMap` 重定位)。
- **Web 原型**(`core/web/`):Vite + TypeScript + three.js + MediaPipe,可在 Windows/手机浏览器运行,用于扫描造像、360 预览与社交系统迭代(**无空间 AR**,以 3D 场景模拟)。

---

## 一、给帮忙构建 iOS 的朋友(需要 Mac)

> 目标:把 App 装到**机主的 iPhone 真机**上。ARKit 在模拟器里不工作,必须真机。

### 前置
- **Xcode 15 或更新**(macOS)。
- 一根数据线,或与 iPhone 同一 Wi-Fi(无线调试)。
- 一个 Apple ID(免费即可,用于签名;免费签名有效期 7 天)。

### 步骤
1. **克隆**
   ```bash
   git clone <这个仓库地址>
   cd Bridge
   ```
2. **打开工程**:双击 `Bridge.xcodeproj`(用 Xcode 打开)。
3. **配置签名**:
   - 选中左侧顶部 `Bridge` 项目 → `TARGETS` → `Bridge` → `Signing & Capabilities`。
   - 勾选 **Automatically manage signing**。
   - `Team` 选你自己的 Apple ID(没有就点 `Add an Account` 登录 Apple ID)。
   - 若 `Bundle Identifier` 报冲突,改成唯一的,例如 `com.<你的名字>.bridge`。
4. **连接机主的 iPhone**,在 Xcode 顶部设备下拉里选中它。
5. **运行**:点左上角 ▶️(或 `Cmd+R`)。首次会自动构建并安装。
6. **iPhone 上信任证书**(免费签名首次必做):
   - iPhone → 设置 → 通用 → VPN 与设备管理 → 点开你的开发者 App → **信任**。
   - 回到桌面打开 App。

### 权限
首次运行会请求**相机**、**定位**权限,请允许(AR 与放置定位需要)。

### 已知情况 / 若构建报错
- 本项目在 Windows 上开发,Swift 代码**可能有个别编译错误**。请把 Xcode 的报错**截图**发给机主,由 AI 协助修改后重新拉取即可,通常几轮就能通过。
- 需要联网能力(未来云同步)时,会用到 iCloud/CloudKit;当前为骨架,**不影响本地功能构建运行**,如提示 capability 相关可暂时忽略或移除该 capability。

---

## 二、Web 原型(Windows / 手机浏览器,机主自测)

```bash
cd core/web
npm install
npm run dev      # 本地开发,浏览器打开提示的 localhost 地址
npm run build    # 生产构建
```

- **相机功能需要 HTTPS 或 localhost**。在手机浏览器打开时,请用 HTTPS(如隧道工具),否则相机会被拦截。
- 覆盖功能:扫描造像、姿态/人体分割、视觉外壳(本人轮廓)渲染、我的放置、嵌套评论、语音提示。空间 AR 锚定为 iOS 独有。

---

## 三、目录结构

```
Bridge/                 iOS 源码
  Models/               数据模型(AvatarPose, Placement, Comment, OrientationMask...)
  Services/             LocalStore, 分割, 锚点持久化, CloudSync/SpatialLocalizer 骨架
  AR/                   GhostEntityBuilder, VisualHull(视觉外壳), 相机/姿态
  Views/                SwiftUI 界面(扫描/放置/看见/我的放置/虚像)
Bridge.xcodeproj/       Xcode 工程
core/web/               Web 原型(Vite + TS + three.js)
```
