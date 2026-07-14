import ARKit
import RealityKit
import SwiftUI

class ARSessionCoordinator: NSObject, ARSessionDelegate {
    var onBodyAnchor: ((ARBodyAnchor) -> Void)?
    var onFrame: ((ARFrame) -> Void)?
    var onRelocalizationChanged: ((Bool) -> Void)?
    var onMappingStatusChanged: ((ARFrame.WorldMappingStatus) -> Void)?

    func session(_ session: ARSession, didUpdate anchors: [ARAnchor]) {
        for anchor in anchors {
            if let bodyAnchor = anchor as? ARBodyAnchor {
                onBodyAnchor?(bodyAnchor)
            }
        }
    }

    func session(_ session: ARSession, cameraDidChangeTrackingState camera: ARCamera) {
        switch camera.trackingState {
        case .normal:
            onRelocalizationChanged?(true)
        case .limited(.relocalizing):
            onRelocalizationChanged?(false)
        default:
            break
        }
    }

    func session(_ session: ARSession, didUpdate frame: ARFrame) {
        onMappingStatusChanged?(frame.worldMappingStatus)
        onFrame?(frame)
    }
}

struct ARViewContainer: UIViewRepresentable {
    let session: ARSession
    let configuration: ARConfiguration
    let onViewCreated: ((ARView) -> Void)?

    init(
        session: ARSession = ARSession(),
        configuration: ARConfiguration,
        onViewCreated: ((ARView) -> Void)? = nil
    ) {
        self.session = session
        self.configuration = configuration
        self.onViewCreated = onViewCreated
    }

    func makeCoordinator() -> ARSessionCoordinator {
        ARSessionCoordinator()
    }

    func makeUIView(context: Context) -> ARView {
        let view = ARView(frame: .zero)
        view.session = session
        view.session.delegate = context.coordinator
        view.automaticallyConfigureSession = false
        view.environment.background = .cameraFeed()
        onViewCreated?(view)
        session.run(configuration, options: [.resetTracking, .removeExistingAnchors])
        return view
    }

    func updateUIView(_ uiView: ARView, context: Context) {
        context.coordinator.onBodyAnchor = nil
    }
}

extension ARView {
    func raycastOnPlane(in point: CGPoint) -> ARRaycastResult? {
        guard let currentFrame = session.currentFrame else { return nil }
        let target = ARRaycastQuery.Target.estimatedPlane
        let alignment: ARRaycastQuery.TargetAlignment = .any
        if let query = currentFrame.raycastQuery(from: point, allowing: target, alignment: alignment) {
            return session.raycast(query).first
        }
        return nil
    }
}
