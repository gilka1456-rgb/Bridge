import ARKit
import CoreLocation
import RealityKit
import SwiftUI

struct DiscoverARView: View {
    @EnvironmentObject private var store: LocalStore
    @EnvironmentObject private var diagnostics: BridgeDiagnostics

    @StateObject private var locationProvider = LocationHeadingProvider()

    @State private var relocalized = false
    @State private var activeWorldMapName: String?
    @State private var mappingStatus: ARFrame.WorldMappingStatus = .notAvailable
    @State private var relocalizationGuidance: String?
    @State private var worldMapQueue: [String] = []
    @State private var worldMapQueueUsesLocation = false
    @State private var worldMapAttemptIndex = 0
    @State private var worldMapQueueSkipSummary: String?
    @State private var relocalizationWatchdog: Task<Void, Never>?
    @State private var selectedPlacement: Placement?
    @State private var snapshotImage: UIImage?
    @State private var showSnapshot = false
    @State private var renderedWorldMapName: String?
    @State private var renderedPlacementIDs: Set<UUID> = []
    @State private var observedRelocalizing = false
    @State private var reportedNormalBeforeRelocalizing = false
    @State private var trackingIsNormalAfterRelocalizing = false
    @State private var lastTrackingStateDescription: String?
    @State private var lastRestoredAnchorSummary: String?

    @State private var session = ARSession()
    @State private var arView = ARView(frame: .zero)
    private let relocalizationTimeoutSeconds: UInt64 = 15

    var body: some View {
        NavigationStack {
            ZStack {
                DiscoverARViewRepresentable(
                    session: session,
                    arView: arView,
                    onTrackingState: handleTrackingState,
                    onMappingStatus: { mappingStatus = $0 },
                    onAnchorsAdded: handleAnchorsAdded,
                    onTap: handleTap(at:),
                    onError: {
                        relocalizationGuidance = $0
                        diagnostics.record($0, scope: "Discover")
                    },
                    onInterrupted: {
                        handleSessionInterrupted()
                    },
                    onInterruptionEnded: {
                        handleSessionInterruptionEnded()
                    }
                )

                overlayHUD

                if let placement = selectedPlacement {
                    placementCard(placement)
                }
            }
            .navigationTitle("看见")
            .onAppear {
                locationProvider.requestAuthorization()
                beginRelocalization()
            }
            .onDisappear {
                relocalizationWatchdog?.cancel()
                session.pause()
            }
            .onChange(of: relocalized) { _, isLocalized in
                if isLocalized {
                    relocalizationWatchdog?.cancel()
                    relocalizationGuidance = nil
                    if let activeWorldMapName, renderedWorldMapName == activeWorldMapName {
                        diagnostics.record("重定位成功：\(activeWorldMapName)", scope: "Discover")
                    }
                }
            }
            .onChange(of: locationProvider.locationRevision) { _, _ in
                guard !store.placements.isEmpty else { return }
                guard worldMapQueue.isEmpty || (!worldMapQueueUsesLocation && !relocalized) else { return }
                beginRelocalization()
            }
            .onChange(of: locationProvider.statusRevision) { _, _ in
                if let message = locationProvider.statusMessage {
                    diagnostics.record(message, scope: "Discover")
                }
            }
            .sheet(isPresented: $showSnapshot) {
                if let snapshotImage {
                    VStack(spacing: 16) {
                        Image(uiImage: snapshotImage)
                            .resizable()
                            .scaledToFit()
                        Text("已保存到预览。Phase 0 可截图存相册；联网版会加入见闻册。")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                            .padding(.horizontal)
                    }
                    .padding()
                }
            }
        }
    }

    private var overlayHUD: some View {
        VStack {
            HStack {
                statusBadge
                Spacer()
                Button {
                    captureSnapshot()
                } label: {
                    Label("留存", systemImage: "camera")
                }
                .buttonStyle(.bordered)
            }
            .padding()

            if let relocalizationGuidance, !relocalized {
                VStack(spacing: 8) {
                    Text(relocalizationGuidance)
                        .font(.footnote)
                        .multilineTextAlignment(.center)

                    if !store.placements.isEmpty {
                        Button {
                            retryRelocalization()
                        } label: {
                            Label("重新匹配", systemImage: "arrow.clockwise")
                        }
                        .buttonStyle(.bordered)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
                .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 14))
                .padding(.horizontal)
            }

            Spacer()

            if store.placements.isEmpty {
                Text("附近还没有放置。去「放置」留下第一个虚像。")
                    .font(.footnote)
                    .padding()
                    .background(.ultraThinMaterial, in: Capsule())
                    .padding(.bottom, 24)
            } else if relocalized {
                Text("点击虚像查看留言与评论")
                    .font(.footnote)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 8)
                    .background(.ultraThinMaterial, in: Capsule())
                    .padding(.bottom, 24)
            }
        }
    }

    private var statusBadge: some View {
        Label(relocalized ? "已重定位" : "定位中", systemImage: relocalized ? "location.fill" : "location")
            .font(.caption)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(.ultraThinMaterial, in: Capsule())
    }

    private func placementCard(_ placement: Placement) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                if let avatar = store.avatar(for: placement.avatarPoseID) {
                    Text(avatar.style.displayName)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button {
                    selectedPlacement = nil
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(.secondary)
                }
            }
            .padding(.horizontal)
            .padding(.top, 12)

            Text(placement.message)
                .font(.body)
                .padding(.horizontal)
                .padding(.bottom, 8)

            ScrollView {
                CommentThreadView(placementID: placement.id)
                    .padding(.horizontal)
                    .padding(.bottom, 12)
            }
            .frame(maxHeight: 280)
        }
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 16))
        .padding()
        .frame(maxHeight: .infinity, alignment: .bottom)
    }

    private func beginRelocalization() {
        relocalizationWatchdog?.cancel()
        let currentLocation = locationProvider.latestLocation
        worldMapQueueUsesLocation = currentLocation != nil
        worldMapQueueSkipSummary = nil
        worldMapQueue = rankedWorldMapFilenames(currentLocation: currentLocation)
        worldMapAttemptIndex = 0
        diagnostics.record("WorldMap 候选队列：\(worldMapQueue.count) 张", scope: "Discover")
        diagnostics.record("Discover 定位/罗盘摘要：\(locationProvider.diagnosticsSummary)", scope: "Discover")
        if worldMapQueueUsesLocation {
            diagnostics.record("按 GPS 距离排序 WorldMap 队列", scope: "Discover")
        } else {
            diagnostics.record("定位未就绪，先按稳定文件名排序 WorldMap 队列", scope: "Discover")
        }
        tryNextWorldMap()
    }

    private func retryRelocalization() {
        diagnostics.record("用户手动重新匹配 WorldMap", scope: "Discover")
        resetRelocalizationState(clearQueue: false)
        beginRelocalization()
    }

    private func handleSessionInterrupted() {
        relocalizationGuidance = "AR 看见被系统中断，恢复后请重新匹配原位置。"
        diagnostics.record("ARSession 被中断，已清除看见页渲染状态", scope: "Discover")
        resetRelocalizationState(clearQueue: true)
    }

    private func handleSessionInterruptionEnded() {
        diagnostics.record("ARSession 中断已结束，重新匹配 WorldMap", scope: "Discover")
        beginRelocalization()
    }

    private func resetRelocalizationState(clearQueue: Bool) {
        relocalizationWatchdog?.cancel()
        relocalizationWatchdog = nil
        relocalized = false
        activeWorldMapName = nil
        renderedWorldMapName = nil
        renderedPlacementIDs = []
        selectedPlacement = nil
        observedRelocalizing = false
        reportedNormalBeforeRelocalizing = false
        trackingIsNormalAfterRelocalizing = false
        lastTrackingStateDescription = nil
        lastRestoredAnchorSummary = nil
        if clearQueue {
            worldMapQueue = []
            worldMapAttemptIndex = 0
            worldMapQueueUsesLocation = false
        }
        arView.scene.anchors.removeAll()
    }

    private func rankedWorldMapFilenames(currentLocation: CLLocation?) -> [String] {
        guard !store.placements.isEmpty else { return [] }

        var nearestDistanceByWorldMap: [String: Double] = [:]
        var missingAvatarCount = 0
        var missingWorldMapCount = 0
        for placement in store.placements {
            let filename = placement.anchor.worldMapFilename
            guard store.avatar(for: placement.avatarPoseID) != nil else {
                missingAvatarCount += 1
                diagnostics.record("跳过缺失虚像的放置：\(placement.id.uuidString)", scope: "Discover")
                continue
            }
            guard AnchorPersistence.worldMapExists(named: filename) else {
                missingWorldMapCount += 1
                diagnostics.record("跳过缺失 WorldMap：\(filename)", scope: "Discover")
                continue
            }

            let distance: Double
            if let currentLocation,
               let latitude = placement.anchor.latitude,
               let longitude = placement.anchor.longitude {
                let placementLocation = CLLocation(latitude: latitude, longitude: longitude)
                distance = currentLocation.distance(from: placementLocation)
            } else {
                distance = .infinity
            }

            if let existing = nearestDistanceByWorldMap[filename] {
                nearestDistanceByWorldMap[filename] = min(existing, distance)
            } else {
                nearestDistanceByWorldMap[filename] = distance
            }
        }

        let filenames = nearestDistanceByWorldMap
            .sorted { lhs, rhs in
                if lhs.value == rhs.value {
                    return lhs.key < rhs.key
                }
                return lhs.value < rhs.value
            }
            .map(\.key)

        recordWorldMapDistanceSummary(
            filenames: filenames,
            nearestDistanceByWorldMap: nearestDistanceByWorldMap,
            hasCurrentLocation: currentLocation != nil
        )

        if filenames.isEmpty {
            var reasons: [String] = []
            if missingAvatarCount > 0 {
                reasons.append("缺失虚像 \(missingAvatarCount) 个")
            }
            if missingWorldMapCount > 0 {
                reasons.append("缺失 WorldMap \(missingWorldMapCount) 个")
            }
            worldMapQueueSkipSummary = reasons.isEmpty ? nil : reasons.joined(separator: "，")
        }
        return filenames
    }

    private func recordWorldMapDistanceSummary(
        filenames: [String],
        nearestDistanceByWorldMap: [String: Double],
        hasCurrentLocation: Bool
    ) {
        guard !filenames.isEmpty else { return }

        let sample = filenames.prefix(3).map { filename in
            guard let distance = nearestDistanceByWorldMap[filename], distance.isFinite else {
                return "\(filename)=无坐标"
            }
            return "\(filename)=\(Int(distance.rounded()))m"
        }
        let locationStatus = hasCurrentLocation ? "GPS 已就绪" : "GPS 未就绪"
        diagnostics.record("WorldMap 距离摘要（\(locationStatus)）：\(sample.joined(separator: "，"))", scope: "Discover")
    }

    private func tryNextWorldMap() {
        relocalizationWatchdog?.cancel()

        guard ARWorldTrackingConfiguration.isSupported else {
            relocalized = false
            activeWorldMapName = nil
            renderedWorldMapName = nil
            renderedPlacementIDs = []
            worldMapQueueUsesLocation = false
            observedRelocalizing = false
            reportedNormalBeforeRelocalizing = false
            trackingIsNormalAfterRelocalizing = false
            lastTrackingStateDescription = nil
            lastRestoredAnchorSummary = nil
            arView.scene.anchors.removeAll()
            relocalizationGuidance = "这台设备不支持 AR 空间重定位。请使用支持 ARKit World Tracking 的 iPhone 真机。"
            diagnostics.record("设备不支持 World Tracking", scope: "Discover")
            return
        }

        guard worldMapAttemptIndex < worldMapQueue.count else {
            relocalized = false
            activeWorldMapName = nil
            renderedWorldMapName = nil
            renderedPlacementIDs = []
            worldMapQueueUsesLocation = false
            observedRelocalizing = false
            reportedNormalBeforeRelocalizing = false
            trackingIsNormalAfterRelocalizing = false
            lastTrackingStateDescription = nil
            lastRestoredAnchorSummary = nil
            arView.scene.anchors.removeAll()
            if let worldMapQueueSkipSummary {
                relocalizationGuidance = "没有可用于重定位的本地放置：\(worldMapQueueSkipSummary)。请到「诊断」导出报告或重新扫描放置。"
            } else {
                relocalizationGuidance = "无法匹配附近放置。请回到放置地点，缓慢环视你放置时的位置。"
            }
            diagnostics.record("重定位失败：没有可继续尝试的 WorldMap", scope: "Discover")
            return
        }

        let filename = worldMapQueue[worldMapAttemptIndex]
        let attemptNumber = worldMapAttemptIndex + 1
        let attemptTotal = worldMapQueue.count
        activeWorldMapName = filename
        renderedWorldMapName = nil
        renderedPlacementIDs = []
        relocalized = false
        observedRelocalizing = false
        reportedNormalBeforeRelocalizing = false
        trackingIsNormalAfterRelocalizing = false
        lastTrackingStateDescription = nil
        lastRestoredAnchorSummary = nil
        arView.scene.anchors.removeAll()
        relocalizationGuidance = worldMapAttemptIndex == 0
            ? "缓慢环视你放置时的位置，正在匹配空间…"
            : "正在尝试附近的其他放置点…"

        do {
            let worldMap = try AnchorPersistence.loadWorldMap(named: filename)
            let configuration = ARWorldTrackingConfiguration()
            configuration.planeDetection = [.horizontal, .vertical]
            configuration.initialWorldMap = worldMap
            session.run(configuration, options: [.resetTracking, .removeExistingAnchors])
            arView.session = session
            diagnostics.record("开始尝试 WorldMap \(attemptNumber)/\(attemptTotal)：\(filename)", scope: "Discover")

            relocalizationWatchdog = Task { @MainActor in
                try? await Task.sleep(nanoseconds: relocalizationTimeoutSeconds * 1_000_000_000)
                guard !Task.isCancelled, !relocalized else { return }
                diagnostics.record(worldMapTimeoutMessage(attemptNumber: attemptNumber, attemptTotal: attemptTotal, filename: filename), scope: "Discover")
                worldMapAttemptIndex += 1
                tryNextWorldMap()
            }
        } catch {
            diagnostics.record("加载 WorldMap 失败：\(filename)，\(error.localizedDescription)", scope: "Discover")
            worldMapAttemptIndex += 1
            tryNextWorldMap()
        }
    }

    private func handleTrackingState(_ trackingState: ARCamera.TrackingState) {
        guard activeWorldMapName != nil else { return }
        recordTrackingState(trackingState)

        switch trackingState {
        case .normal:
            guard observedRelocalizing else {
                if !reportedNormalBeforeRelocalizing {
                    reportedNormalBeforeRelocalizing = true
                    diagnostics.record("Tracking 已 normal，但尚未进入 relocalizing，继续等待 WorldMap 匹配", scope: "Discover")
                }
                return
            }
            trackingIsNormalAfterRelocalizing = true
            if let activeWorldMapName {
                renderPlacements(for: activeWorldMapName, restoredAnchors: session.currentFrame?.anchors ?? [])
            }
        case .limited(.relocalizing):
            observedRelocalizing = true
            relocalized = false
            trackingIsNormalAfterRelocalizing = false
            relocalizationGuidance = "正在识别放置时的空间，请缓慢环视原位置。"
            diagnostics.record("进入 WorldMap relocalizing", scope: "Discover")
        case .limited(let reason):
            relocalized = false
            trackingIsNormalAfterRelocalizing = false
            relocalizationGuidance = trackingGuidance(for: reason)
        case .notAvailable:
            relocalized = false
            trackingIsNormalAfterRelocalizing = false
        }
    }

    private func recordTrackingState(_ trackingState: ARCamera.TrackingState) {
        let description = trackingStateDescription(trackingState)
        guard lastTrackingStateDescription != description else { return }
        lastTrackingStateDescription = description
        diagnostics.record("Discover tracking：\(description)", scope: "Discover")
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

    private func trackingGuidance(for reason: ARCamera.TrackingState.Reason) -> String {
        switch reason {
        case .initializing:
            return "正在初始化 AR，请缓慢移动手机。"
        case .excessiveMotion:
            return "移动过快，请放慢速度并对准原放置区域。"
        case .insufficientFeatures:
            return "可识别特征不足，请对准有纹理的墙面、地面或物体。"
        case .relocalizing:
            return "正在识别放置时的空间，请缓慢环视原位置。"
        @unknown default:
            return "AR 定位受限，请缓慢环视原放置区域。"
        }
    }

    private func handleAnchorsAdded(_ anchors: [ARAnchor]) {
        guard trackingIsNormalAfterRelocalizing, let activeWorldMapName else { return }
        renderPlacements(for: activeWorldMapName, restoredAnchors: anchors)
    }

    private func renderPlacements(for worldMapFilename: String, restoredAnchors: [ARAnchor]) {
        if renderedWorldMapName != worldMapFilename {
            arView.scene.anchors.removeAll()
            renderedPlacementIDs = []
            renderedWorldMapName = worldMapFilename
        }

        let matching = store.placements.filter { $0.anchor.worldMapFilename == worldMapFilename }
        recordRestoredAnchorSummary(restoredAnchors, expectedPlacements: matching)
        var renderedCount = 0
        var missingRestoredAnchorCount = 0
        var missingAnchorIDs: [String] = []
        for placement in matching {
            guard !renderedPlacementIDs.contains(placement.id) else { continue }
            guard let avatar = store.avatar(for: placement.avatarPoseID) else { continue }
            guard let restoredAnchor = restoredAnchors.first(where: { $0.identifier == placement.anchor.anchorIdentifier }) else {
                missingRestoredAnchorCount += 1
                missingAnchorIDs.append(placement.anchor.anchorIdentifier.uuidString)
                continue
            }

            let ghost = GhostEntityBuilder.makeEntity(from: avatar)
            let anchorEntity = AnchorEntity(anchor: restoredAnchor)
            anchorEntity.name = "placement-\(placement.id.uuidString)"
            anchorEntity.addChild(ghost)
            anchorEntity.addChild(makePlacementHitTarget(for: placement))
            anchorEntity.generateCollisionShapes(recursive: true)
            arView.scene.addAnchor(anchorEntity)
            renderedPlacementIDs.insert(placement.id)
            renderedCount += 1
        }

        if renderedCount > 0 {
            relocalized = true
            diagnostics.record("渲染恢复锚点放置：\(renderedCount) 个", scope: "Discover")
        } else if !relocalized, missingRestoredAnchorCount > 0 {
            relocalizationGuidance = "空间已稳定，正在等待 WorldMap 恢复放置锚点…"
            diagnostics.record("等待恢复锚点：\(missingRestoredAnchorCount) 个，缺失 \(anchorSummary(missingAnchorIDs))", scope: "Discover")
        }
    }

    private func recordRestoredAnchorSummary(_ restoredAnchors: [ARAnchor], expectedPlacements: [Placement]) {
        let restoredIDs = restoredAnchors.map { $0.identifier.uuidString }.sorted()
        let expectedIDs = expectedPlacements.map { $0.anchor.anchorIdentifier.uuidString }.sorted()
        let summary = "restored=\(anchorSummary(restoredIDs)) expected=\(anchorSummary(expectedIDs))"
        guard lastRestoredAnchorSummary != summary else { return }
        lastRestoredAnchorSummary = summary
        diagnostics.record("恢复锚点摘要：\(summary)", scope: "Discover")
    }

    private func anchorSummary(_ identifiers: [String]) -> String {
        guard !identifiers.isEmpty else { return "none" }
        let sample = identifiers.prefix(3).map { String($0.prefix(8)) }.joined(separator: ",")
        if identifiers.count <= 3 {
            return sample
        }
        return "\(sample)+\(identifiers.count - 3)"
    }

    private func worldMapTimeoutMessage(attemptNumber: Int, attemptTotal: Int, filename: String) -> String {
        let tracking = lastTrackingStateDescription ?? "none"
        let anchors = lastRestoredAnchorSummary ?? "none"
        return "WorldMap 超时 \(attemptNumber)/\(attemptTotal)：\(filename)，tracking=\(tracking)，mapping=\(mappingStatusDescription(mappingStatus))，observedRelocalizing=\(observedRelocalizing)，anchors=\(anchors)"
    }

    private func mappingStatusDescription(_ status: ARFrame.WorldMappingStatus) -> String {
        switch status {
        case .notAvailable:
            return "notAvailable"
        case .limited:
            return "limited"
        case .extending:
            return "extending"
        case .mapped:
            return "mapped"
        @unknown default:
            return "unknown"
        }
    }

    private func makePlacementHitTarget(for placement: Placement) -> Entity {
        let entity = Entity()
        entity.name = "placement-\(placement.id.uuidString)"
        entity.position = [0, 0.95, 0]
        entity.components.set(CollisionComponent(shapes: [
            .generateBox(size: [0.8, 1.9, 0.5])
        ]))
        return entity
    }

    private func handleTap(at point: CGPoint) {
        guard let entity = arView.entity(at: point) else { return }
        var current: Entity? = entity
        while let node = current {
            if node.name.hasPrefix("placement-") {
                let idString = String(node.name.dropFirst("placement-".count))
                if let placementID = UUID(uuidString: idString),
                   let placement = store.placement(for: placementID) {
                    selectedPlacement = placement
                    diagnostics.record("点击命中放置：\(placementID.uuidString)", scope: "Discover")
                }
                return
            }
            current = node.parent
        }
    }

    private func captureSnapshot() {
        arView.snapshot(saveToHDR: false) { image in
            Task { @MainActor in
                snapshotImage = image
                showSnapshot = image != nil
            }
        }
    }
}

private struct DiscoverARViewRepresentable: UIViewRepresentable {
    let session: ARSession
    let arView: ARView
    let onTrackingState: (ARCamera.TrackingState) -> Void
    let onMappingStatus: (ARFrame.WorldMappingStatus) -> Void
    let onAnchorsAdded: ([ARAnchor]) -> Void
    let onTap: (CGPoint) -> Void
    let onError: (String) -> Void
    let onInterrupted: () -> Void
    let onInterruptionEnded: () -> Void

    func makeCoordinator() -> Coordinator {
        let coordinator = Coordinator(onTap: onTap)
        coordinator.onTrackingStateChanged = onTrackingState
        coordinator.onMappingStatusChanged = onMappingStatus
        coordinator.onAnchorsAdded = onAnchorsAdded
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
        arView.addGestureRecognizer(tap)
        context.coordinator.arView = arView

        return arView
    }

    func updateUIView(_ uiView: ARView, context: Context) {
        context.coordinator.onTrackingStateChanged = onTrackingState
        context.coordinator.onMappingStatusChanged = onMappingStatus
        context.coordinator.onAnchorsAdded = onAnchorsAdded
        context.coordinator.onTap = onTap
        context.coordinator.onSessionError = { error in
            onError(error.localizedDescription)
        }
        context.coordinator.onSessionInterrupted = onInterrupted
        context.coordinator.onSessionInterruptionEnded = onInterruptionEnded
    }

    final class Coordinator: ARSessionCoordinator {
        weak var arView: ARView?
        var onTap: (CGPoint) -> Void
        var onTrackingStateChanged: ((ARCamera.TrackingState) -> Void)?
        var onAnchorsAdded: (([ARAnchor]) -> Void)?

        init(onTap: @escaping (CGPoint) -> Void) {
            self.onTap = onTap
            super.init()
        }

        override func session(_ session: ARSession, cameraDidChangeTrackingState camera: ARCamera) {
            onTrackingStateChanged?(camera.trackingState)
        }

        override func session(_ session: ARSession, didAdd anchors: [ARAnchor]) {
            super.session(session, didAdd: anchors)
            onAnchorsAdded?(anchors)
        }

        @objc func handleTap(_ recognizer: UITapGestureRecognizer) {
            guard let view = recognizer.view as? ARView else { return }
            onTap(recognizer.location(in: view))
        }
    }
}
