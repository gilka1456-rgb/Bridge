import ARKit
import CoreLocation
import RealityKit
import SwiftUI

struct PlaceARView: View {
    @EnvironmentObject private var store: LocalStore

    @State private var selectedAvatarID: UUID?
    @State private var message = ""
    @State private var headingDegrees: Double = 0
    @State private var previewEntity: Entity?
    @State private var previewAnchor: ARAnchor?
    @State private var previewAnchorEntity: AnchorEntity?
    @State private var previewBaseTransform: simd_float4x4?
    @State private var mappingStatus: ARFrame.WorldMappingStatus = .notAvailable
    @State private var isSaving = false
    @State private var showSuccess = false
    @State private var errorMessage: String?

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
                    onMappingStatus: { mappingStatus = $0 },
                    onError: { errorMessage = $0 }
                )

                placementPanel
            }
            .navigationTitle("放置虚像")
            .onAppear {
                selectedAvatarID = store.avatars.first?.id
                locationProvider.requestAuthorization()
                runWorldTracking()
            }
            .onDisappear {
                session.pause()
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
                Text("请先在「扫描」中创建一个虚像。")
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
                .disabled(isSaving || previewAnchor == nil || selectedAvatarID == nil)
            }
        }
        .padding()
        .background(.ultraThinMaterial)
    }

    private var mappingHint: String {
        switch mappingStatus {
        case .mapped, .extending:
            return "空间映射良好，锚点精度较高。"
        case .limited:
            return "映射有限，请缓慢环视周围以提升精度。"
        default:
            return "正在建立空间地图…"
        }
    }

    private func runWorldTracking() {
        guard ARWorldTrackingConfiguration.isSupported else {
            errorMessage = "这台设备不支持 AR 空间放置。请使用支持 ARKit World Tracking 的 iPhone 真机。"
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
    }

    private func handleTap(_ point: CGPoint) {
        guard
            let avatarID = selectedAvatarID,
            let avatar = store.avatar(for: avatarID),
            let result = arView.raycastOnPlane(in: point)
        else {
            errorMessage = "未能命中平面，请对准地面或墙面。"
            return
        }

        removePreview()

        previewBaseTransform = result.worldTransform
        let transform = transformWithHeading(from: result.worldTransform)
        let anchor = ARAnchor(transform: transform)
        previewAnchor = anchor
        arView.session.add(anchor: anchor)

        let ghost = GhostEntityBuilder.makeEntity(from: avatar)
        previewEntity = ghost

        let anchorEntity = AnchorEntity(anchor: anchor)
        anchorEntity.addChild(ghost)
        arView.scene.addAnchor(anchorEntity)
        previewAnchorEntity = anchorEntity
    }

    private func refreshPreviewTransform() {
        guard let baseTransform = previewBaseTransform else { return }

        removePreview()
        let newTransform = transformWithHeading(from: baseTransform)
        let newAnchor = ARAnchor(transform: newTransform)
        previewAnchor = newAnchor
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

    private func savePlacement() async {
        guard
            let avatarID = selectedAvatarID,
            let anchor = previewAnchor
        else { return }

        isSaving = true
        defer { isSaving = false }

        do {
            let approvedMessage = try MessageModeration.validate(message)
            let worldMapFilename = try await AnchorPersistence.persistWorldMap(from: session)
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
            message = ""
            showSuccess = true
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

private struct PlaceARViewRepresentable: UIViewRepresentable {
    let session: ARSession
    let arView: ARView
    let onTap: (CGPoint) -> Void
    let onMappingStatus: (ARFrame.WorldMappingStatus) -> Void
    let onError: (String) -> Void

    func makeCoordinator() -> Coordinator {
        let coordinator = Coordinator()
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
        context.coordinator.onTap = onTap
        arView.addGestureRecognizer(tap)
        return arView
    }

    func updateUIView(_ uiView: ARView, context: Context) {
        context.coordinator.onMappingStatusChanged = onMappingStatus
        context.coordinator.onSessionError = { error in
            onError(error.localizedDescription)
        }
    }

    final class Coordinator: ARSessionCoordinator {
        var onTap: ((CGPoint) -> Void)?

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
    /// Bumps on each location update so SwiftUI onChange can observe without Equatable CLLocation.
    @Published private(set) var locationRevision = 0

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyBest
    }

    func requestAuthorization() {
        manager.requestWhenInUseAuthorization()
        manager.startUpdatingLocation()
        manager.startUpdatingHeading()
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        latestLocation = locations.last
        locationRevision += 1
    }
}
