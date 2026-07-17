# T6 柔和灵体视觉验收

生成时间：2026-07-17。截图来自当前 Web 生产构建的同一套模板人体、同一相机和同一灯光，
仅切换材质风格。

| 风格 | 截图 |
|---|---|
| 灵体（雾蓝、默认无扫描线） | [t6-wraith.png](./t6-wraith.png) |
| 赛博（唯一保留弱扫描线） | [t6-cyber.png](./t6-cyber.png) |
| 量子（低幅闪烁、无扫描线） | [t6-quantum.png](./t6-quantum.png) |

实现检查：

- 菲涅尔指数 1.5，发光输入钳制到 0.35；
- 灵体基色 `#AECBEB`，基础 alpha 0.55；
- 8 秒周期、最大 0.8cm 的双正弦顶点位移；
- 两层共享几何洋葱壳（1.025 / 1.06，alpha 比例 0.35 / 0.15）；
- 从脚底向上 0.12m 的渐隐与噪声侵蚀；
- 无后处理 pass。

桌面内置 Chromium 的 3 秒 `requestAnimationFrame` 快速检查为 230 FPS，超过 30 FPS
代码门槛。该数字不是 iPhone 性能结论；合入主分支前仍须按任务卡在手机 Chrome / Safari
做一次实机 30 FPS 验证。

## iPhone 自助验收页

生产构建支持 `?fps-test=1`，该页面直接复用正式 `GhostScene`、完整模板人体、三种风格中
开销最大的赛博材质和两层洋葱壳，预热后采样 5 秒 `requestAnimationFrame`，显示平均
FPS、总帧数和慢帧比例。
它不进入普通 App 导航，也不读取相机或本地数据。

1. Windows 与 iPhone 连接同一 Wi-Fi；
2. 在 `core/web` 运行 `npm run dev -- --host 0.0.0.0`；
3. iPhone 打开 `http://<Windows 局域网 IPv4>:5173/?fps-test=1`；
4. 保持页面在前台，等待结果；关闭低电量模式后点「重新测 5 秒」复测一次；
5. 两次平均 FPS 都不低于 30，即完成任务卡的手机实机验收。
