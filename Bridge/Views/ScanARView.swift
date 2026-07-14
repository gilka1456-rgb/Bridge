import ARKit
import RealityKit
import SwiftUI

struct ScanARView: View {
    @EnvironmentObject private var store: LocalStore
    @EnvironmentObject private var diagnostics: BridgeDiagnostics
    @Binding var hasUnsavedScan: Bool
    let discardGeneration: Int

    @StateObject private var coach = ScanCoach()

    @State private var scanMode: ScanMode = .guided
    @State private var selectedStyle: GhostStyle = .wraith
    @State private var poseLabel = "站立"
    @State private var latestBodyAnchor: ARBodyAnchor?
    @State private var latestFrame: ARFrame?
    @State private var capturedViews: [PoseView] = []
    @State private var capturedOrientations: [OrientationMask] = []
    @State private var showSavedAlert = false
    @State private var errorMessage: String?
    @State private var statusMessage = ""

    @State private var session = ARSession()

    init(hasUnsavedScan: Binding<Bool> = .constant(false), discardGeneration: Int = 0) {
        _hasUnsavedScan = hasUnsavedScan
        self.discardGeneration = discardGeneration
    }

    var body: some View {
        NavigationStack {
            ZStack(alignment: .bottom) {
                ScanARViewRepresentable(
                    session: session,
                    onBodyAnchor: { latestBodyAnchor = $0 },
                    onBodyAnchorRemoved: {
                        latestBodyAnchor = nil
                        statusMessage = "人体已离开画面，请重新对准全身。"
                        diagnostics.record("人体 anchor 已移除", scope: "Scan")
                    },
                    onFrame: { latestFrame = $0 },
                    onError: {
                        errorMessage = $0
                        diagnostics.record($0, scope: "Scan")
                    },
                    onInterrupted: {
                        handleSessionInterrupted()
                    },
                    onInterruptionEnded: {
                        handleSessionInterruptionEnded()
                    }
                )
                .overlay(alignment: .top) {
                    instructionOverlay
                }
                .onAppear {
                    runBodyTracking()
                    coach.reset(mode: scanMode)
                    syncUnsavedFlag()
                }
                .onDisappear {
                    handleViewDisappeared()
                }
                .onChange(of: capturedViews.count) { _, _ in syncUnsavedFlag() }
                .onChange(of: discardGeneration) { _, _ in
                    resetScanSession()
                }

                controlPanel
            }
            .navigationTitle("扫描虚像")
            .alert("已保存虚像", isPresented: $showSavedAlert) {
                Button("好", role: .cancel) {}
            }
            .alert("无法保存", isPresented: Binding(
                get: { errorMessage != nil },
                set: { if !$0 { errorMessage = nil } }
            )) {
                Button("好", role: .cancel) {}
            } message: {
                Text(errorMessage ?? "")
            }
        }
    }

    private var instructionOverlay: some View {
        VStack(spacing: 8) {
            Picker("模式", selection: $scanMode) {
                ForEach(ScanMode.allCases) { mode in
                    Text(mode.title).tag(mode)
                }
            }
            .pickerStyle(.segmented)
            .padding(.horizontal)
            .onChange(of: scanMode) { _, newValue in
                capturedViews = []
                capturedOrientations = []
                coach.reset(mode: newValue)
                syncUnsavedFlag()
            }

            Text(coach.currentInstruction)
                .font(.subheadline)
                .multilineTextAlignment(.center)
                .padding()
                .frame(maxWidth: .infinity)
                .background(.ultraThinMaterial)

            Text(progressText)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(.top, 8)
    }

    private var progressText: String {
        if capturedViews.isEmpty {
            return "已记录 0 / \(ScanCoach.viewSequence.count) 方位"
        }
        let labels = capturedViews.map { $0.angle.displayName }.joined(separator: "、")
        return "已记录 \(capturedViews.count) / \(ScanCoach.viewSequence.count) 方位（\(labels)）"
    }

    private var controlPanel: some View {
        VStack(spacing: 12) {
            HStack {
                TextField("姿势名称", text: $poseLabel)
                    .textFieldStyle(.roundedBorder)
                Picker("风格", selection: $selectedStyle) {
                    ForEach(GhostStyle.allCases) { style in
                        Text(style.displayName).tag(style)
                    }
                }
                .pickerStyle(.menu)
            }

            if !statusMessage.isEmpty {
                Text(statusMessage)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            HStack(spacing: 12) {
                Button(scanMode == .guided ? "记录此方位" : "朋友代拍此方位") {
                    recordCurrentView()
                }
                .buttonStyle(.bordered)

                Button("保存虚像") {
                    saveAvatar()
                }
                .buttonStyle(.borderedProminent)
                .disabled(capturedViews.count < 2)
            }
        }
        .padding()
        .background(.ultraThinMaterial)
    }

    private func recordCurrentView() {
        guard let bodyAnchor = latestBodyAnchor else {
            errorMessage = "尚未检测到人体，请调整距离与光线。"
            diagnostics.record("记录方位失败：尚未检测到人体", scope: "Scan")
            return
        }

        let joints = PoseCaptureManager.snapshot(from: bodyAnchor)
        let validation = PoseCaptureManager.validateFullBody(joints: joints)
        guard validation.ok else {
            errorMessage = validation.message
            diagnostics.record("记录方位失败：\(validation.message)", scope: "Scan")
            return
        }

        let angle: ScanViewAngle
        if scanMode == .guided {
            guard let currentAngle = coach.currentAngle else {
                saveAvatar()
                return
            }
            angle = currentAngle
        } else {
            angle = coach.suggestNextAngle(existing: capturedViews)
        }

        capturedViews.removeAll { $0.angle == angle }
        let segmentation = latestFrame.flatMap { PersonSegmentationCapture.capture(from: $0.capturedImage) }
        capturedViews.append(
            PoseView(
                angle: angle,
                joints: joints,
                silhouetteContour: segmentation?.contour,
                bodyProfile: segmentation?.bodyProfile
            )
        )

        // 视觉外壳前置数据：为参与雕刻的朝向采集全高二值 mask。
        if let azimuth = OrientationAzimuth.azimuth(for: angle),
           let segmentation {
            capturedOrientations.removeAll { $0.azimuth == azimuth }
            capturedOrientations.append(
                OrientationMask(
                    azimuth: azimuth,
                    width: segmentation.maskWidth,
                    height: segmentation.maskHeight,
                    mask: PersonMaskRLE.encode(segmentation.binaryMask)
                )
            )
        }

        statusMessage = "已记录\(angle.displayName)方位。"
        diagnostics.record("已记录\(angle.displayName)方位", scope: "Scan")
        if scanMode == .guided {
            coach.advance(mode: scanMode)
        }
    }

    private func saveAvatar() {
        guard capturedViews.count >= 2 else {
            errorMessage = "请至少记录 2 个方位（建议正面 + 建言姿势）。"
            diagnostics.record("保存虚像失败：方位不足", scope: "Scan")
            return
        }

        let primaryJoints = AvatarPose.primaryJoints(from: capturedViews)
        let avatar = AvatarPose(
            label: poseLabel.isEmpty ? "未命名虚像" : poseLabel,
            style: selectedStyle,
            joints: primaryJoints,
            views: capturedViews,
            orientations: capturedOrientations.isEmpty ? nil : capturedOrientations
        )
        store.addAvatar(avatar)
        diagnostics.record("已保存虚像：\(avatar.label)，方位 \(capturedViews.count)", scope: "Scan")
        resetScanSession()
        showSavedAlert = true
    }

    private func resetScanSession() {
        capturedViews = []
        capturedOrientations = []
        coach.reset(mode: scanMode)
        statusMessage = ""
        syncUnsavedFlag()
    }

    private func syncUnsavedFlag() {
        hasUnsavedScan = !capturedViews.isEmpty
    }

    private func runBodyTracking() {
        guard ARBodyTrackingConfiguration.isSupported else {
            errorMessage = "这台设备不支持人体 AR 扫描。请使用 iOS 17+ 且支持 ARKit Body Tracking 的 iPhone 真机。"
            diagnostics.record("设备不支持 Body Tracking", scope: "Scan")
            return
        }

        let configuration = ARBodyTrackingConfiguration()
        configuration.isLightEstimationEnabled = true
        session.run(configuration, options: [.resetTracking, .removeExistingAnchors])
        diagnostics.record("Body Tracking 会话已启动", scope: "Scan")
    }

    private func handleViewDisappeared() {
        latestBodyAnchor = nil
        latestFrame = nil
        diagnostics.record("离开扫描页，已清除实时人体缓存", scope: "Scan")
        session.pause()
    }

    private func handleSessionInterrupted() {
        latestBodyAnchor = nil
        latestFrame = nil
        statusMessage = "AR 扫描被系统中断，恢复后请重新对准全身。"
        diagnostics.record("ARSession 被中断，已清除扫描缓存", scope: "Scan")
    }

    private func handleSessionInterruptionEnded() {
        latestBodyAnchor = nil
        latestFrame = nil
        statusMessage = "AR 扫描已恢复，请重新对准全身后再记录。"
        diagnostics.record("ARSession 中断已结束，重启 Body Tracking", scope: "Scan")
        runBodyTracking()
    }
}

private struct ScanARViewRepresentable: UIViewRepresentable {
    let session: ARSession
    let onBodyAnchor: (ARBodyAnchor) -> Void
    let onBodyAnchorRemoved: () -> Void
    let onFrame: (ARFrame) -> Void
    let onError: (String) -> Void
    let onInterrupted: () -> Void
    let onInterruptionEnded: () -> Void

    func makeCoordinator() -> ARSessionCoordinator {
        let coordinator = ARSessionCoordinator()
        coordinator.onBodyAnchor = onBodyAnchor
        coordinator.onBodyAnchorRemoved = onBodyAnchorRemoved
        coordinator.onFrame = onFrame
        coordinator.onSessionError = { error in
            onError(error.localizedDescription)
        }
        coordinator.onSessionInterrupted = onInterrupted
        coordinator.onSessionInterruptionEnded = onInterruptionEnded
        return coordinator
    }

    func makeUIView(context: Context) -> ARView {
        let view = ARView(frame: .zero)
        view.session = session
        view.session.delegate = context.coordinator
        view.automaticallyConfigureSession = false
        view.environment.background = .cameraFeed()

        return view
    }

    func updateUIView(_ uiView: ARView, context: Context) {
        context.coordinator.onBodyAnchor = onBodyAnchor
        context.coordinator.onBodyAnchorRemoved = onBodyAnchorRemoved
        context.coordinator.onFrame = onFrame
        context.coordinator.onSessionError = { error in
            onError(error.localizedDescription)
        }
        context.coordinator.onSessionInterrupted = onInterrupted
        context.coordinator.onSessionInterruptionEnded = onInterruptionEnded
    }
}
