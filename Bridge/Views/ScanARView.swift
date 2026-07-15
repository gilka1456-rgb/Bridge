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
    @State private var lastTrackingStateDescription: String?
    @State private var bodyDetectionWatchdog: Task<Void, Never>?
    @State private var bodyDetectionWatchdogGeneration = 0
    @State private var hasDetectedBodyInCurrentSession = false

    @State private var session = ARSession()
    private let bodyDetectionTimeoutSeconds: UInt64 = 12

    init(hasUnsavedScan: Binding<Bool> = .constant(false), discardGeneration: Int = 0) {
        _hasUnsavedScan = hasUnsavedScan
        self.discardGeneration = discardGeneration
    }

    var body: some View {
        NavigationStack {
            ZStack(alignment: .bottom) {
                ScanARViewRepresentable(
                    session: session,
                    onBodyAnchor: handleBodyAnchor,
                    onBodyAnchorRemoved: {
                        latestBodyAnchor = nil
                        hasDetectedBodyInCurrentSession = false
                        statusMessage = "人体已离开画面，请重新对准全身。"
                        diagnostics.record("人体 anchor 已移除", scope: "Scan")
                        startBodyDetectionWatchdog(reason: "人体离开画面")
                    },
                    onTrackingState: handleTrackingState,
                    onFrame: { latestFrame = $0 },
                    onError: {
                        handleSessionError($0)
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
                if !capturedViews.isEmpty || !capturedOrientations.isEmpty {
                    diagnostics.record(
                        "切换扫描模式，已清空未保存扫描：views=\(capturedViews.count)，masks=\(capturedOrientations.count)，newMode=\(newValue.title)",
                        scope: "Scan"
                    )
                }
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

        let replacedExistingView = capturedViews.contains { $0.angle == angle }
        let azimuth = OrientationAzimuth.azimuth(for: angle)
        let replacedExistingMask = azimuth.map { azimuth in
            capturedOrientations.contains { $0.azimuth == azimuth }
        } ?? false

        capturedViews.removeAll { $0.angle == angle }
        let segmentationResult = latestFrame
            .map { PersonSegmentationCapture.captureResult(from: $0.capturedImage) }
        let segmentation = segmentationResult?.capture
        let segmentationFailureReason = segmentationResult?.failureReason ?? "no-current-frame"
        capturedViews.append(
            PoseView(
                angle: angle,
                joints: joints,
                silhouetteContour: segmentation?.contour,
                bodyProfile: segmentation?.bodyProfile
            )
        )

        // 视觉外壳前置数据：重拍同一方位时先清掉旧 mask，避免新姿态混用旧轮廓。
        if let azimuth {
            capturedOrientations.removeAll { $0.azimuth == azimuth }
            if let segmentation {
                capturedOrientations.append(
                    OrientationMask(
                        azimuth: azimuth,
                        width: segmentation.maskWidth,
                        height: segmentation.maskHeight,
                        mask: PersonMaskRLE.encode(segmentation.binaryMask)
                    )
                )
            }
        }

        if segmentation == nil {
            statusMessage = "已记录\(angle.displayName)方位，但人体分割失败（\(segmentationFailureReason)）；虚像可能退回胶囊外形。"
            diagnostics.record("已记录\(angle.displayName)方位，但未取得分割 mask：\(segmentationFailureReason)", scope: "Scan")
        } else {
            statusMessage = "已记录\(angle.displayName)方位。"
            diagnostics.record("已记录\(angle.displayName)方位，已取得分割 mask", scope: "Scan")
        }
        if replacedExistingView || replacedExistingMask {
            diagnostics.record(
                "重拍方位：\(angle.displayName)，replacedView=\(replacedExistingView)，replacedMask=\(replacedExistingMask)，newMask=\(segmentation != nil)",
                scope: "Scan"
            )
        }
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
        let validMaskCount = capturedOrientations.filter { $0.hasValidMaskData }.count
        let invalidMasks = capturedOrientations.filter { !$0.hasValidMaskData }.count
        let maskStates = capturedOrientations
            .map { "\($0.azimuth):\($0.validationSummary)" }
            .joined(separator: ",")
        let hullState = validMaskCount >= 2 ? "visualHullCandidate" : "fallbackSkeleton"
        let avatar = AvatarPose(
            label: poseLabel.isEmpty ? "未命名虚像" : poseLabel,
            style: selectedStyle,
            joints: primaryJoints,
            views: capturedViews,
            orientations: capturedOrientations.isEmpty ? nil : capturedOrientations
        )
        store.addAvatar(avatar)
        diagnostics.record("已保存虚像：\(avatar.label)，方位 \(capturedViews.count)，mask \(capturedOrientations.count)，validMasks \(validMaskCount)，invalidMasks \(invalidMasks)，hull=\(hullState)，maskStates=\(maskStates.isEmpty ? "none" : maskStates)", scope: "Scan")
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
        hasDetectedBodyInCurrentSession = false
        startBodyDetectionWatchdog(reason: "Body Tracking 启动")
        diagnostics.record("Body Tracking 会话已启动", scope: "Scan")
    }

    private func handleBodyAnchor(_ bodyAnchor: ARBodyAnchor) {
        latestBodyAnchor = bodyAnchor
        bodyDetectionWatchdog?.cancel()
        bodyDetectionWatchdog = nil
        if !hasDetectedBodyInCurrentSession {
            hasDetectedBodyInCurrentSession = true
            statusMessage = "已检测到人体，请按提示记录当前方位。"
            diagnostics.record("Body Tracking 已检测到人体 anchor", scope: "Scan")
        }
    }

    private func startBodyDetectionWatchdog(reason: String) {
        bodyDetectionWatchdog?.cancel()
        bodyDetectionWatchdogGeneration += 1
        let watchdogGeneration = bodyDetectionWatchdogGeneration
        bodyDetectionWatchdog = Task { @MainActor in
            try? await Task.sleep(nanoseconds: bodyDetectionTimeoutSeconds * 1_000_000_000)
            guard !Task.isCancelled else { return }
            guard watchdogGeneration == bodyDetectionWatchdogGeneration else {
                diagnostics.record("忽略过期 Body Tracking 超时：\(reason)，generation=\(watchdogGeneration)/\(bodyDetectionWatchdogGeneration)", scope: "Scan")
                return
            }
            guard latestBodyAnchor == nil else { return }
            statusMessage = "超过 \(bodyDetectionTimeoutSeconds) 秒未检测到全身。请后退到全身入镜、改善光线，并让被扫描者面向相机。"
            diagnostics.record("Body Tracking 超时未检测到人体：\(reason)，\(bodyDetectionTimeoutSeconds) 秒", scope: "Scan")
        }
    }

    private func handleViewDisappeared() {
        bodyDetectionWatchdog?.cancel()
        bodyDetectionWatchdog = nil
        latestBodyAnchor = nil
        latestFrame = nil
        hasDetectedBodyInCurrentSession = false
        lastTrackingStateDescription = nil
        diagnostics.record("离开扫描页，已清除实时人体缓存", scope: "Scan")
        session.pause()
    }

    private func handleSessionInterrupted() {
        bodyDetectionWatchdog?.cancel()
        bodyDetectionWatchdog = nil
        latestBodyAnchor = nil
        latestFrame = nil
        hasDetectedBodyInCurrentSession = false
        lastTrackingStateDescription = nil
        statusMessage = "AR 扫描被系统中断，恢复后请重新对准全身。"
        diagnostics.record("ARSession 被中断，已清除扫描缓存", scope: "Scan")
    }

    private func handleSessionError(_ message: String) {
        bodyDetectionWatchdog?.cancel()
        bodyDetectionWatchdog = nil
        latestBodyAnchor = nil
        latestFrame = nil
        hasDetectedBodyInCurrentSession = false
        lastTrackingStateDescription = nil
        errorMessage = message
        statusMessage = "AR 扫描会话失败，请重新进入扫描页或检查相机权限。"
        diagnostics.record("ARSession 失败，已清除扫描缓存：\(message)", scope: "Scan")
    }

    private func handleSessionInterruptionEnded() {
        latestBodyAnchor = nil
        latestFrame = nil
        hasDetectedBodyInCurrentSession = false
        lastTrackingStateDescription = nil
        statusMessage = "AR 扫描已恢复，请重新对准全身后再记录。"
        diagnostics.record("ARSession 中断已结束，重启 Body Tracking", scope: "Scan")
        runBodyTracking()
    }

    private func handleTrackingState(_ trackingState: ARCamera.TrackingState) {
        let description = trackingStateDescription(trackingState)
        guard lastTrackingStateDescription != description else { return }
        lastTrackingStateDescription = description
        diagnostics.record("Scan tracking：\(description)", scope: "Scan")
    }

    private func trackingStateDescription(_ trackingState: ARCamera.TrackingState) -> String {
        switch trackingState {
        case .normal:
            return "normal"
        case .notAvailable:
            return "notAvailable"
        case .limited(let reason):
            return "limited(\(trackingLimitedReasonDescription(reason)))"
        }
    }

    private func trackingLimitedReasonDescription(_ reason: ARCamera.TrackingState.Reason) -> String {
        switch reason {
        case .initializing:
            return "initializing"
        case .excessiveMotion:
            return "excessiveMotion"
        case .insufficientFeatures:
            return "insufficientFeatures"
        case .relocalizing:
            return "relocalizing"
        @unknown default:
            return "unknown"
        }
    }
}

private struct ScanARViewRepresentable: UIViewRepresentable {
    let session: ARSession
    let onBodyAnchor: (ARBodyAnchor) -> Void
    let onBodyAnchorRemoved: () -> Void
    let onTrackingState: (ARCamera.TrackingState) -> Void
    let onFrame: (ARFrame) -> Void
    let onError: (String) -> Void
    let onInterrupted: () -> Void
    let onInterruptionEnded: () -> Void

    func makeCoordinator() -> Coordinator {
        let coordinator = Coordinator()
        coordinator.onBodyAnchor = onBodyAnchor
        coordinator.onBodyAnchorRemoved = onBodyAnchorRemoved
        coordinator.onTrackingStateChanged = onTrackingState
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
        context.coordinator.onTrackingStateChanged = onTrackingState
        context.coordinator.onFrame = onFrame
        context.coordinator.onSessionError = { error in
            onError(error.localizedDescription)
        }
        context.coordinator.onSessionInterrupted = onInterrupted
        context.coordinator.onSessionInterruptionEnded = onInterruptionEnded
    }

    final class Coordinator: ARSessionCoordinator {
        var onTrackingStateChanged: ((ARCamera.TrackingState) -> Void)?

        override func session(_ session: ARSession, cameraDidChangeTrackingState camera: ARCamera) {
            onTrackingStateChanged?(camera.trackingState)
        }
    }
}
