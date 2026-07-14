import RealityKit
import SwiftUI

struct GhostPreviewView: UIViewRepresentable {
    let avatar: AvatarPose
    var rotationY: Float = 0

    func makeUIView(context: Context) -> ARView {
        let view = ARView(frame: .zero, cameraMode: .nonAR, automaticallyConfigureSession: false)
        view.environment.background = .color(.init(red: 0.01, green: 0.01, blue: 0.03, alpha: 1))
        context.coordinator.attach(to: view)
        return view
    }

    func updateUIView(_ uiView: ARView, context: Context) {
        context.coordinator.update(avatar: avatar, rotationY: rotationY, in: uiView)
    }

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    final class Coordinator {
        private var anchor: AnchorEntity?

        func attach(to view: ARView) {
            let camera = PerspectiveCamera()
            camera.position = [0, 1.2, 2.8]
            camera.look(at: [0, 0.9, 0], from: camera.position, relativeTo: nil)

            let cameraAnchor = AnchorEntity(world: .zero)
            cameraAnchor.addChild(camera)
            view.scene.addAnchor(cameraAnchor)
        }

        func update(avatar: AvatarPose, rotationY: Float, in view: ARView) {
            if let anchor {
                view.scene.removeAnchor(anchor)
            }

            let anchor = AnchorEntity(world: [0, 0, 0])
            let ghost = GhostEntityBuilder.makeEntity(from: avatar)
            ghost.orientation = simd_quatf(angle: rotationY * .pi / 180, axis: [0, 1, 0])
            anchor.addChild(ghost)
            view.scene.addAnchor(anchor)
            self.anchor = anchor
        }
    }
}
