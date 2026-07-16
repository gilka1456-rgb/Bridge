import ARKit
import Foundation
import RealityKit
import SwiftUI

class ARSessionCoordinator: NSObject, ARSessionDelegate {
    var onBodyAnchor: ((ARBodyAnchor) -> Void)?
    var onBodyAnchorRemoved: (() -> Void)?
    var onFrame: ((ARFrame) -> Void)?
    var onRelocalizationChanged: ((Bool) -> Void)?
    var onMappingStatusChanged: ((ARFrame.WorldMappingStatus) -> Void)?
    var onSessionError: ((Error) -> Void)?
    var onSessionInterrupted: (() -> Void)?
    var onSessionInterruptionEnded: (() -> Void)?

    func dispatchToMain(_ work: @escaping () -> Void) {
        if Thread.isMainThread {
            work()
        } else {
            DispatchQueue.main.async(execute: work)
        }
    }

    func session(_ session: ARSession, didAdd anchors: [ARAnchor]) {
        for anchor in anchors {
            if let bodyAnchor = anchor as? ARBodyAnchor {
                dispatchToMain { [weak self] in
                    self?.onBodyAnchor?(bodyAnchor)
                }
            }
        }
    }

    func session(_ session: ARSession, didUpdate anchors: [ARAnchor]) {
        for anchor in anchors {
            if let bodyAnchor = anchor as? ARBodyAnchor {
                dispatchToMain { [weak self] in
                    self?.onBodyAnchor?(bodyAnchor)
                }
            }
        }
    }

    func session(_ session: ARSession, didRemove anchors: [ARAnchor]) {
        if anchors.contains(where: { $0 is ARBodyAnchor }) {
            dispatchToMain { [weak self] in
                self?.onBodyAnchorRemoved?()
            }
        }
    }

    func session(_ session: ARSession, cameraDidChangeTrackingState camera: ARCamera) {
        switch camera.trackingState {
        case .normal:
            dispatchToMain { [weak self] in
                self?.onRelocalizationChanged?(true)
            }
        case .limited(.relocalizing):
            dispatchToMain { [weak self] in
                self?.onRelocalizationChanged?(false)
            }
        default:
            break
        }
    }

    func session(_ session: ARSession, didUpdate frame: ARFrame) {
        dispatchToMain { [weak self] in
            self?.onMappingStatusChanged?(frame.worldMappingStatus)
            self?.onFrame?(frame)
        }
    }

    func session(_ session: ARSession, didFailWithError error: Error) {
        dispatchToMain { [weak self] in
            self?.onSessionError?(error)
        }
    }

    func sessionWasInterrupted(_ session: ARSession) {
        dispatchToMain { [weak self] in
            self?.onSessionInterrupted?()
        }
    }

    func sessionInterruptionEnded(_ session: ARSession) {
        dispatchToMain { [weak self] in
            self?.onSessionInterruptionEnded?()
        }
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
        let query = currentFrame.raycastQuery(from: point, allowing: target, alignment: alignment)
        return session.raycast(query).first
    }
}
