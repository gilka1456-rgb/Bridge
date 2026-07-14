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
    @State private var relocalizationWatchdog: Task<Void, Never>?
    @State private var selectedPlacement: Placement?
    @State private var snapshotImage: UIImage?
    @State private var showSnapshot = false
    @State private var renderedWorldMapName: String?
    @State private var observedRelocalizing = false
    @State private var reportedNormalBeforeRelocalizing = false

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
                    onTap: handleTap(at:),
                    onError: {
                        relocalizationGuidance = $0
                        diagnostics.record($0, scope: "Discover")
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
                    if let activeWorldMapName, renderedWorldMapName != activeWorldMapName {
                        diagnostics.record("重定位成功：\(activeWorldMapName)", scope: "Discover")
                        renderPlacements(for: activeWorldMapName)
                    }
                }
            }
            .onChange(of: locationProvider.locationRevision) { _, _ in
                guard !store.placements.isEmpty else { return }
                guard worldMapQueue.isEmpty || (!worldMapQueueUsesLocation && !relocalized) else { return }
                beginRelocalization()
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
                Text(relocalizationGuidance)
                    .font(.footnote)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                    .background(.ultraThinMaterial, in: Capsule())
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
        worldMapQueue = rankedWorldMapFilenames(currentLocation: currentLocation)
        worldMapAttemptIndex = 0
        if worldMapQueueUsesLocation {
            diagnostics.record("按 GPS 距离排序 WorldMap 队列", scope: "Discover")
        } else {
            diagnostics.record("定位未就绪，先按稳定文件名排序 WorldMap 队列", scope: "Discover")
        }
        tryNextWorldMap()
    }

    private func rankedWorldMapFilenames(currentLocation: CLLocation?) -> [String] {
        guard !store.placements.isEmpty else { return [] }

        var nearestDistanceByWorldMap: [String: Double] = [:]
        for placement in store.placements {
            let filename = placement.anchor.worldMapFilename
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

        return nearestDistanceByWorldMap
            .sorted { lhs, rhs in
                if lhs.value == rhs.value {
                    return lhs.key < rhs.key
                }
                return lhs.value < rhs.value
            }
            .map(\.key)
    }

    private func tryNextWorldMap() {
        relocalizationWatchdog?.cancel()

        guard ARWorldTrackingConfiguration.isSupported else {
            relocalized = false
            activeWorldMapName = nil
            renderedWorldMapName = nil
            worldMapQueueUsesLocation = false
            observedRelocalizing = false
            reportedNormalBeforeRelocalizing = false
            arView.scene.anchors.removeAll()
            relocalizationGuidance = "这台设备不支持 AR 空间重定位。请使用支持 ARKit World Tracking 的 iPhone 真机。"
            diagnostics.record("设备不支持 World Tracking", scope: "Discover")
            return
        }

        guard worldMapAttemptIndex < worldMapQueue.count else {
            relocalized = false
            activeWorldMapName = nil
            renderedWorldMapName = nil
            worldMapQueueUsesLocation = false
            observedRelocalizing = false
            reportedNormalBeforeRelocalizing = false
            arView.scene.anchors.removeAll()
            relocalizationGuidance = "无法匹配附近放置。请回到放置地点，缓慢环视你放置时的位置。"
            diagnostics.record("重定位失败：没有可继续尝试的 WorldMap", scope: "Discover")
            return
        }

        let filename = worldMapQueue[worldMapAttemptIndex]
        activeWorldMapName = filename
        renderedWorldMapName = nil
        relocalized = false
        observedRelocalizing = false
        reportedNormalBeforeRelocalizing = false
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
            diagnostics.record("开始尝试 WorldMap：\(filename)", scope: "Discover")

            relocalizationWatchdog = Task { @MainActor in
                try? await Task.sleep(nanoseconds: relocalizationTimeoutSeconds * 1_000_000_000)
                guard !Task.isCancelled, !relocalized else { return }
                diagnostics.record("WorldMap 超时：\(filename)", scope: "Discover")
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

        switch trackingState {
        case .normal:
            guard observedRelocalizing else {
                if !reportedNormalBeforeRelocalizing {
                    reportedNormalBeforeRelocalizing = true
                    diagnostics.record("Tracking 已 normal，但尚未进入 relocalizing，继续等待 WorldMap 匹配", scope: "Discover")
                }
                return
            }
            relocalized = true
        case .limited(.relocalizing):
            observedRelocalizing = true
            relocalized = false
            relocalizationGuidance = "正在识别放置时的空间，请缓慢环视原位置。"
            diagnostics.record("进入 WorldMap relocalizing", scope: "Discover")
        case .limited(let reason):
            relocalized = false
            relocalizationGuidance = trackingGuidance(for: reason)
        case .notAvailable:
            relocalized = false
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

    private func renderPlacements(for worldMapFilename: String) {
        arView.scene.anchors.removeAll()
        renderedWorldMapName = worldMapFilename

        let matching = store.placements.filter { $0.anchor.worldMapFilename == worldMapFilename }
        diagnostics.record("渲染放置：\(matching.count) 个", scope: "Discover")
        for placement in matching {
            guard let avatar = store.avatar(for: placement.avatarPoseID) else { continue }

            let transform = AnchorPersistence.deserializeTransform(placement.anchor.transform)
            let anchor = ARAnchor(name: placement.id.uuidString, transform: transform)
            session.add(anchor: anchor)

            let ghost = GhostEntityBuilder.makeEntity(from: avatar)
            let anchorEntity = AnchorEntity(anchor: anchor)
            anchorEntity.name = "placement-\(placement.id.uuidString)"
            anchorEntity.addChild(ghost)
            anchorEntity.generateCollisionShapes(recursive: true)
            arView.scene.addAnchor(anchorEntity)
        }
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
    let onTap: (CGPoint) -> Void
    let onError: (String) -> Void

    func makeCoordinator() -> Coordinator {
        let coordinator = Coordinator(onTap: onTap)
        coordinator.onTrackingStateChanged = onTrackingState
        coordinator.onMappingStatusChanged = onMappingStatus
        coordinator.onSessionError = { error in
            onError(error.localizedDescription)
        }
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
        context.coordinator.onTap = onTap
        context.coordinator.onSessionError = { error in
            onError(error.localizedDescription)
        }
    }

    final class Coordinator: ARSessionCoordinator {
        weak var arView: ARView?
        var onTap: (CGPoint) -> Void
        var onTrackingStateChanged: ((ARCamera.TrackingState) -> Void)?

        init(onTap: @escaping (CGPoint) -> Void) {
            self.onTap = onTap
            super.init()
        }

        override func session(_ session: ARSession, cameraDidChangeTrackingState camera: ARCamera) {
            onTrackingStateChanged?(camera.trackingState)
        }

        @objc func handleTap(_ recognizer: UITapGestureRecognizer) {
            guard let view = recognizer.view as? ARView else { return }
            onTap(recognizer.location(in: view))
        }
    }
}
