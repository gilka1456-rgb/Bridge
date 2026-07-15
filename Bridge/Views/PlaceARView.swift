import ARKit
import CoreLocation
import RealityKit
import SwiftUI

struct PlaceARView: View {
    @EnvironmentObject private var store: LocalStore
    @EnvironmentObject private var diagnostics: BridgeDiagnostics

    @State private var selectedAvatarID: UUID?
    @State private var message = ""
    @State private var headingDegrees: Double = 0
    @State private var previewEntity: Entity?
    @State private var previewAnchor: ARAnchor?
    @State private var previewAnchorEntity: AnchorEntity?
    @State private var previewBaseTransform: simd_float4x4?
    @State private var previewAnchorInCurrentFrame = false
    @State private var reportedPreviewAnchorInCurrentFrame = false
    @State private var previewRevision = 0
    @State private var mappingStatus: ARFrame.WorldMappingStatus = .notAvailable
    @State private var isSaving = false
    @State private var showSuccess = false
    @State private var errorMessage: String?
    @State private var userAdjustedHeading = false
    @State private var lastTrackingStateDescription: String?

    @StateObject private var locationProvider = LocationHeadingProvider()

    @State private var session = ARSession()
    @State private var arView = ARView(frame: .zero)

    var body: some View {
        NavigationStack {
            ZStack(alignment: .bottom) {
                PlaceARViewRepresentable(
                    session: session,
                    arView: arView,
                    onTap: handleTap,
                    onTrackingState: handleTrackingState,
                    onMappingStatus: { mappingStatus = $0 },
                    onFrame: handleFrame,
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

                placementPanel
            }
            .navigationTitle("放置虚像")
            .onAppear {
                ensureSelectedAvatar()
                locationProvider.requestAuthorization()
                runWorldTracking()
            }
            .onChange(of: locationProvider.headingRevision) { _, _ in
                applyInitialDeviceHeadingIfNeeded()
            }
            .onChange(of: locationProvider.statusRevision) { _, _ in
                if let message = locationProvider.statusMessage {
                    diagnostics.record(message, scope: "Place")
                }
            }
            .onChange(of: store.avatars.map(\.id)) { _, _ in
                validateSelectedAvatar()
            }
            .onDisappear {
                handleViewDisappeared()
            }
            .alert("放置成功", isPresented: $showSuccess) {
                Button("好", role: .cancel) {}
            } message: {
                Text("虚像已锚定在当前空间。回到同一地点即可在「看见」中重定位。")
            }
            .alert("放置失败", isPresented: Binding(
                get: { errorMessage != nil },
                set: { if !$0 { errorMessage = nil } }
            )) {
                Button("好", role: .cancel) {}
            } message: {
                Text(errorMessage ?? "")
            }
        }
    }

    private var placementPanel: some View {
        VStack(spacing: 12) {
            if store.avatars.isEmpty {
                Text("请先在「虚像」中扫描创建一个虚像。")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            } else {
                Picker("虚像", selection: $selectedAvatarID) {
                    ForEach(store.avatars) { avatar in
                        Text(avatar.label).tag(Optional(avatar.id))
                    }
                }
                .pickerStyle(.menu)
                .onChange(of: selectedAvatarID) { _, _ in
                    refreshPreviewTransform()
                }

                MessageInputView(
                    text: $message,
                    placeholder: "例如：此处晚风很好，适合站一会儿。"
                )

                VStack(alignment: .leading) {
                    Text("朝向 \(Int(headingDegrees))°")
                        .font(.caption)
                    Slider(value: $headingDegrees, in: 0...359, step: 1)
                        .onChange(of: headingDegrees) { _, _ in
                            userAdjustedHeading = true
                            refreshPreviewTransform()
                        }
                }

                Text(mappingHint)
                    .font(.caption2)
                    .foregroundStyle(.secondary)

                Button(isSaving ? "保存中…" : "保存到此锚点") {
                    Task { await savePlacement() }
                }
                .buttonStyle(.borderedProminent)
                .disabled(isSaving || previewAnchor == nil || selectedAvatarID == nil || !previewAnchorInCurrentFrame || !canPersistWorldMap)
            }
        }
        .padding()
        .background(.ultraThinMaterial)
    }

    private var canPersistWorldMap: Bool {
        AnchorPersistence.isPersistableMappingStatus(mappingStatus)
    }

    private var mappingHint: String {
        if previewAnchor != nil, !previewAnchorInCurrentFrame {
            return "锚点正在写入当前 AR frame，请继续缓慢环视后再保存。"
        }

        switch mappingStatus {
        case .mapped, .extending:
            return "空间映射良好，锚点精度较高。"
        case .limited:
            return "映射有限，请缓慢环视周围；状态变好后才能保存。"
        default:
            return "正在建立空间地图…"
        }
    }

    private var mappingStatusName: String {
        switch mappingStatus {
        case .mapped:
            return "mapped"
        case .extending:
            return "extending"
        case .limited:
            return "limited"
        case .notAvailable:
            return "notAvailable"
        @unknown default:
            return "unknown"
        }
    }

    private func runWorldTracking() {
        guard ARWorldTrackingConfiguration.isSupported else {
            errorMessage = "这台设备不支持 AR 空间放置。请使用支持 ARKit World Tracking 的 iPhone 真机。"
            diagnostics.record("设备不支持 World Tracking", scope: "Place")
            return
        }

        let configuration = ARWorldTrackingConfiguration()
        configuration.planeDetection = [.horizontal, .vertical]
        configuration.environmentTexturing = .automatic
        configuration.isAutoFocusEnabled = true
        if ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh) {
            configuration.sceneReconstruction = .mesh
        }
        session.run(configuration, options: [.resetTracking, .removeExistingAnchors])
        arView.session = session
        diagnostics.record("World Tracking 会话已启动", scope: "Place")
    }

    private func handleSessionInterrupted() {
        errorMessage = "AR 放置被系统中断，请恢复后重新点击现实平面确认锚点。"
        diagnostics.record("ARSession 被中断，已清除放置预览", scope: "Place")
        removePreview()
        previewBaseTransform = nil
    }

    private func handleSessionError(_ message: String) {
        errorMessage = message
        diagnostics.record("ARSession 失败，已清除放置预览：\(message)", scope: "Place")
        removePreview()
        previewBaseTransform = nil
        mappingStatus = .notAvailable
        lastTrackingStateDescription = nil
    }

    private func handleSessionInterruptionEnded() {
        diagnostics.record("ARSession 中断已结束，重启 World Tracking", scope: "Place")
        runWorldTracking()
    }

    private func handleViewDisappeared() {
        if previewAnchor != nil || previewBaseTransform != nil {
            diagnostics.record("离开放置页，已清除未保存放置预览", scope: "Place")
        }
        removePreview()
        previewBaseTransform = nil
        mappingStatus = .notAvailable
        lastTrackingStateDescription = nil
        session.pause()
    }

    private func handleTrackingState(_ trackingState: ARCamera.TrackingState) {
        let description = trackingStateDescription(trackingState)
        guard lastTrackingStateDescription != description else { return }
        lastTrackingStateDescription = description
        diagnostics.record("Place tracking：\(description)", scope: "Place")
    }

    private func handleFrame(_ frame: ARFrame) {
        guard let previewAnchor else { return }

        let containsPreviewAnchor = frame.anchors.contains { $0.identifier == previewAnchor.identifier }
        if containsPreviewAnchor {
            previewAnchorInCurrentFrame = true
            if !reportedPreviewAnchorInCurrentFrame {
                reportedPreviewAnchorInCurrentFrame = true
                diagnostics.record("预览锚点已进入当前 ARFrame，可尝试保存 WorldMap", scope: "Place")
            }
        } else if previewAnchorInCurrentFrame {
            previewAnchorInCurrentFrame = false
            reportedPreviewAnchorInCurrentFrame = false
            diagnostics.record("预览锚点暂未出现在当前 ARFrame，暂停保存", scope: "Place")
        }
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

    private func validateSelectedAvatar() {
        ensureSelectedAvatar()
    }

    private func ensureSelectedAvatar() {
        guard let selectedAvatarID else {
            selectedAvatarID = store.avatars.first?.id
            return
        }
        guard store.avatar(for: selectedAvatarID) == nil else { return }

        removePreview()
        previewBaseTransform = nil
        self.selectedAvatarID = store.avatars.first?.id
        errorMessage = "选中的虚像已经不存在，请重新选择后再放置。"
        diagnostics.record("选中的虚像已删除，已清除放置预览", scope: "Place")
    }

    private func applyInitialDeviceHeadingIfNeeded() {
        guard !userAdjustedHeading, let heading = locationProvider.latestHeadingDegrees else { return }
        headingDegrees = heading
        diagnostics.record("使用设备罗盘初始化朝向：\(Int(heading))°", scope: "Place")
    }

    private func handleTap(_ point: CGPoint) {
        guard
            let avatarID = selectedAvatarID,
            let avatar = store.avatar(for: avatarID),
            let result = arView.raycastOnPlane(in: point)
        else {
            errorMessage = "未能命中平面，请对准地面或墙面。"
            diagnostics.record("放置预览失败：未命中平面", scope: "Place")
            return
        }

        removePreview()

        previewBaseTransform = result.worldTransform
        previewAnchorInCurrentFrame = false
        reportedPreviewAnchorInCurrentFrame = false
        let transform = transformWithHeading(from: result.worldTransform)
        let anchor = ARAnchor(transform: transform)
        previewAnchor = anchor
        previewRevision += 1
        arView.session.add(anchor: anchor)

        let ghost = GhostEntityBuilder.makeEntity(from: avatar)
        previewEntity = ghost

        let anchorEntity = AnchorEntity(anchor: anchor)
        anchorEntity.addChild(ghost)
        arView.scene.addAnchor(anchorEntity)
        previewAnchorEntity = anchorEntity
        diagnostics.record("已创建放置预览锚点", scope: "Place")
    }

    private func refreshPreviewTransform() {
        guard let baseTransform = previewBaseTransform else { return }

        removePreview()
        let newTransform = transformWithHeading(from: baseTransform)
        let newAnchor = ARAnchor(transform: newTransform)
        previewAnchor = newAnchor
        previewAnchorInCurrentFrame = false
        reportedPreviewAnchorInCurrentFrame = false
        previewRevision += 1
        arView.session.add(anchor: newAnchor)

        if
            let avatarID = selectedAvatarID,
            let avatar = store.avatar(for: avatarID)
        {
            let ghost = GhostEntityBuilder.makeEntity(from: avatar)
            previewEntity = ghost
            let anchorEntity = AnchorEntity(anchor: newAnchor)
            anchorEntity.addChild(ghost)
            arView.scene.addAnchor(anchorEntity)
            previewAnchorEntity = anchorEntity
        }
    }

    private func removePreview() {
        if let oldAnchor = previewAnchor {
            arView.session.remove(anchor: oldAnchor)
        }
        previewAnchorEntity?.removeFromParent()
        previewEntity?.removeFromParent()
        previewAnchor = nil
        previewAnchorEntity = nil
        previewEntity = nil
        previewAnchorInCurrentFrame = false
        reportedPreviewAnchorInCurrentFrame = false
        previewRevision += 1
    }

    private func transformWithHeading(from baseTransform: simd_float4x4) -> simd_float4x4 {
        let rotation = simd_quatf(angle: Float(headingDegrees * .pi / 180), axis: SIMD3(0, 1, 0))
        let right = rotation.act(SIMD3(baseTransform.columns.0.x, baseTransform.columns.0.y, baseTransform.columns.0.z))
        let forward = rotation.act(SIMD3(baseTransform.columns.2.x, baseTransform.columns.2.y, baseTransform.columns.2.z))

        var transform = baseTransform
        transform.columns.0 = SIMD4(right.x, right.y, right.z, baseTransform.columns.0.w)
        transform.columns.2 = SIMD4(forward.x, forward.y, forward.z, baseTransform.columns.2.w)
        return transform
    }

    private func locationSummary(_ location: CLLocation?) -> String {
        guard let location else { return "unavailable" }
        return String(format: "%.5f,%.5f", location.coordinate.latitude, location.coordinate.longitude)
    }

    private func savePlacement() async {
        guard !isSaving else {
            diagnostics.record("保存放置已在进行中，忽略重复保存请求", scope: "Place")
            return
        }
        guard let avatarID = selectedAvatarID else {
            errorMessage = "请先选择一个虚像再保存放置。"
            diagnostics.record("保存放置失败：未选择虚像", scope: "Place")
            return
        }
        guard let anchor = previewAnchor else {
            errorMessage = "请先点击现实平面确认锚点，再保存放置。"
            diagnostics.record("保存放置失败：缺少预览锚点", scope: "Place")
            return
        }
        guard previewAnchorInCurrentFrame else {
            errorMessage = "当前锚点还没有进入 AR frame，请继续缓慢环视后再保存。"
            diagnostics.record("保存放置失败：预览锚点尚未进入当前 ARFrame", scope: "Place")
            return
        }
        guard canPersistWorldMap else {
            errorMessage = "空间映射还不够稳定，请缓慢环视周围，等状态变好后再保存。"
            diagnostics.record("保存放置失败：mapping=\(mappingStatusName)，WorldMap 尚不可保存", scope: "Place")
            return
        }
        guard store.avatar(for: avatarID) != nil else {
            errorMessage = "选中的虚像已经不存在，请重新选择后再放置。"
            diagnostics.record("保存放置失败：选中的虚像已删除", scope: "Place")
            removePreview()
            previewBaseTransform = nil
            selectedAvatarID = store.avatars.first?.id
            return
        }

        isSaving = true
        defer { isSaving = false }
        let savePreviewRevision = previewRevision

        do {
            let approvedMessage = try MessageModeration.validate(message)
            let worldMapInfo = try await AnchorPersistence.persistWorldMapInfo(
                from: session,
                requiringAnchor: anchor.identifier
            )
            let worldMapFilename = worldMapInfo.filename
            guard previewRevision == savePreviewRevision,
                  previewAnchor?.identifier == anchor.identifier else {
                let cleanupResult = AnchorPersistence.deleteWorldMap(named: worldMapFilename)
                diagnostics.record(
                    "保存放置取消：预览锚点已变化，已丢弃 WorldMap \(worldMapFilename)，cleanup=\(cleanupResult.diagnosticDescription)",
                    scope: "Place"
                )
                return
            }
            let location = locationProvider.latestLocation

            let record = PlacementAnchorRecord(
                anchorIdentifier: anchor.identifier,
                transform: AnchorPersistence.serializeTransform(anchor.transform),
                worldMapFilename: worldMapFilename,
                latitude: location?.coordinate.latitude,
                longitude: location?.coordinate.longitude,
                altitude: location?.altitude,
                headingDegrees: headingDegrees
            )

            let placement = Placement(
                avatarPoseID: avatarID,
                message: approvedMessage,
                anchor: record
            )
            store.addPlacement(placement)
            diagnostics.record("已保存放置：worldMap=\(worldMapFilename)，anchors=\(worldMapInfo.anchorCount)，bytes=\(worldMapInfo.fileSizeBytes)，mapping=\(mappingStatusName)，location=\(locationSummary(location))，heading=\(Int(headingDegrees))°", scope: "Place")
            diagnostics.record("Place 定位/罗盘摘要：\(locationProvider.diagnosticsSummary)", scope: "Place")
            removePreview()
            previewBaseTransform = nil
            message = ""
            showSuccess = true
        } catch {
            errorMessage = error.localizedDescription
            diagnostics.record("保存放置失败：\(error.localizedDescription)", scope: "Place")
        }
    }
}

private struct PlaceARViewRepresentable: UIViewRepresentable {
    let session: ARSession
    let arView: ARView
    let onTap: (CGPoint) -> Void
    let onTrackingState: (ARCamera.TrackingState) -> Void
    let onMappingStatus: (ARFrame.WorldMappingStatus) -> Void
    let onFrame: (ARFrame) -> Void
    let onError: (String) -> Void
    let onInterrupted: () -> Void
    let onInterruptionEnded: () -> Void

    func makeCoordinator() -> Coordinator {
        let coordinator = Coordinator()
        coordinator.onTrackingStateChanged = onTrackingState
        coordinator.onMappingStatusChanged = onMappingStatus
        coordinator.onFrame = onFrame
        coordinator.onSessionError = { error in
            onError(error.localizedDescription)
        }
        coordinator.onSessionInterrupted = onInterrupted
        coordinator.onSessionInterruptionEnded = onInterruptionEnded
        return coordinator
    }

    func makeUIView(context: Context) -> ARView {
        arView.session = session
        arView.session.delegate = context.coordinator
        arView.automaticallyConfigureSession = false
        arView.environment.background = .cameraFeed()

        let tap = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.handleTap(_:)))
        context.coordinator.onTap = onTap
        arView.addGestureRecognizer(tap)
        return arView
    }

    func updateUIView(_ uiView: ARView, context: Context) {
        context.coordinator.onTrackingStateChanged = onTrackingState
        context.coordinator.onMappingStatusChanged = onMappingStatus
        context.coordinator.onFrame = onFrame
        context.coordinator.onSessionError = { error in
            onError(error.localizedDescription)
        }
        context.coordinator.onSessionInterrupted = onInterrupted
        context.coordinator.onSessionInterruptionEnded = onInterruptionEnded
    }

    final class Coordinator: ARSessionCoordinator {
        var onTap: ((CGPoint) -> Void)?
        var onTrackingStateChanged: ((ARCamera.TrackingState) -> Void)?

        override func session(_ session: ARSession, cameraDidChangeTrackingState camera: ARCamera) {
            onTrackingStateChanged?(camera.trackingState)
        }

        @objc func handleTap(_ recognizer: UITapGestureRecognizer) {
            guard let view = recognizer.view as? ARView else { return }
            let point = recognizer.location(in: view)
            onTap?(point)
        }
    }
}

@MainActor
final class LocationHeadingProvider: NSObject, ObservableObject, @preconcurrency CLLocationManagerDelegate {
    private let manager = CLLocationManager()
    private(set) var latestLocation: CLLocation?
    private(set) var latestHeadingDegrees: Double?
    private(set) var statusMessage: String?
    /// Bumps on each location update so SwiftUI onChange can observe without Equatable CLLocation.
    @Published private(set) var locationRevision = 0
    /// Bumps on each heading update so SwiftUI onChange can observe compass heading changes.
    @Published private(set) var headingRevision = 0
    /// Bumps when location/heading availability changes and should be logged by the owning view.
    @Published private(set) var statusRevision = 0

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyBest
        manager.headingFilter = 5
    }

    func requestAuthorization() {
        guard CLLocationManager.locationServicesEnabled() else {
            clearLocationAndHeadingCache()
            updateStatus("系统定位服务关闭，无法按 GPS 排序放置点或记录放置位置")
            return
        }

        manager.requestWhenInUseAuthorization()
        startUpdatesIfAuthorized()
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        startUpdatesIfAuthorized()
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        latestLocation = locations.last
        locationRevision += 1
    }

    func locationManager(_ manager: CLLocationManager, didUpdateHeading newHeading: CLHeading) {
        let heading = newHeading.trueHeading >= 0 ? newHeading.trueHeading : newHeading.magneticHeading
        guard heading >= 0 else { return }
        latestHeadingDegrees = heading
        headingRevision += 1
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        updateStatus("定位更新失败：\(error.localizedDescription)")
    }

    var diagnosticsSummary: String {
        let services = CLLocationManager.locationServicesEnabled() ? "services=on" : "services=off"
        let authorization = "auth=\(authorizationStatusDescription(manager.authorizationStatus))"
        let location = latestLocation.map { location in
            let age = Int(Date().timeIntervalSince(location.timestamp).rounded())
            return String(
                format: "location=%.6f,%.6f acc=%.0fm age=%ds",
                location.coordinate.latitude,
                location.coordinate.longitude,
                location.horizontalAccuracy,
                age
            )
        } ?? "location=none"
        let headingAvailable = CLLocationManager.headingAvailable() ? "headingAvailable=yes" : "headingAvailable=no"
        let heading = latestHeadingDegrees.map { "heading=\(Int($0))deg" } ?? "heading=none"
        return "\(services)，\(authorization)，\(location)，\(headingAvailable)，\(heading)"
    }

    private func startUpdatesIfAuthorized() {
        switch manager.authorizationStatus {
        case .authorizedAlways, .authorizedWhenInUse:
            manager.startUpdatingLocation()
            if CLLocationManager.headingAvailable() {
                manager.startUpdatingHeading()
            } else {
                clearHeadingCache()
                updateStatus("设备不支持罗盘 heading，放置朝向需要手动调整")
            }
        case .denied, .restricted:
            manager.stopUpdatingLocation()
            manager.stopUpdatingHeading()
            clearLocationAndHeadingCache()
            updateStatus("定位权限未开启，Discover 将无法按 GPS 距离优先匹配 WorldMap")
        case .notDetermined:
            break
        @unknown default:
            updateStatus("定位权限状态未知，GPS 排序可能不可用")
        }
    }

    private func updateStatus(_ message: String) {
        guard statusMessage != message else { return }
        statusMessage = message
        statusRevision += 1
    }

    private func clearLocationAndHeadingCache() {
        if latestLocation != nil {
            latestLocation = nil
            locationRevision += 1
        }
        clearHeadingCache()
    }

    private func clearHeadingCache() {
        guard latestHeadingDegrees != nil else { return }
        latestHeadingDegrees = nil
        headingRevision += 1
    }

    private func authorizationStatusDescription(_ status: CLAuthorizationStatus) -> String {
        switch status {
        case .notDetermined:
            return "notDetermined"
        case .restricted:
            return "restricted"
        case .denied:
            return "denied"
        case .authorizedAlways:
            return "authorizedAlways"
        case .authorizedWhenInUse:
            return "authorizedWhenInUse"
        @unknown default:
            return "unknown"
        }
    }
}
