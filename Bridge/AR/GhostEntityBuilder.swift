import RealityKit
import UIKit

enum GhostEntityBuilder {
    private static let limbChains: [(String, String, String)] = [
        ("left_shoulder_1_joint", "left_arm_joint", "left_forearm_joint"),
        ("right_shoulder_1_joint", "right_arm_joint", "right_forearm_joint"),
        ("left_upLeg_joint", "left_leg_joint", "left_foot_joint"),
        ("right_upLeg_joint", "right_leg_joint", "right_foot_joint")
    ]

    private static let limbRadii: [Float] = [0.048, 0.04, 0.034]
    private static let legRadii: [Float] = [0.062, 0.05, 0.038]

    private static var hullMeshCache: [UUID: MeshResource] = [:]

    static func makeEntity(from pose: AvatarPose) -> Entity {
        let root = Entity()
        root.name = "ghost-\(pose.id.uuidString)"

        var jointMap: [String: JointSnapshot] = [:]
        for joint in pose.joints {
            jointMap[joint.name] = joint
        }

        let body = buildBodyCore(jointMap: jointMap, style: pose.style, pose: pose)
        root.addChild(body)

        if pose.style.rimGlow > 0 {
            let glow = buildBodyCore(jointMap: jointMap, style: pose.style, pose: pose, brighter: true)
            glow.scale = SIMD3(repeating: 1.06)
            root.addChild(glow)
        }

        return root
    }

    private static func buildBodyCore(
        jointMap: [String: JointSnapshot],
        style: GhostStyle,
        pose: AvatarPose,
        brighter: Bool = false
    ) -> Entity {
        if let orientations = pose.orientations,
           orientations.count >= 2,
           let hullEntity = makeHullEntity(avatarID: pose.id, orientations: orientations, style: style, brighter: brighter) {
            return hullEntity
        }

        let root = Entity()

        if
            let leftShoulder = jointMap["left_shoulder_1_joint"],
            let rightShoulder = jointMap["right_shoulder_1_joint"],
            let leftHip = jointMap["left_upLeg_joint"],
            let rightHip = jointMap["right_upLeg_joint"]
        {
            let torso = makeTorso(
                leftShoulder: leftShoulder.position,
                rightShoulder: rightShoulder.position,
                leftHip: leftHip.position,
                rightHip: rightHip.position,
                style: style,
                brighter: brighter
            )
            root.addChild(torso)
        }

        if let head = makeHead(jointMap: jointMap, style: style, brighter: brighter) {
            root.addChild(head)
        }

        for (index, chain) in limbChains.enumerated() {
            let radii = index < 2 ? limbRadii : legRadii
            addLimbChain(
                to: root,
                jointMap: jointMap,
                names: chain,
                radii: radii,
                style: style,
                brighter: brighter
            )
        }

        return root
    }

    private static func makeHullEntity(
        avatarID: UUID,
        orientations: [OrientationMask],
        style: GhostStyle,
        brighter: Bool
    ) -> ModelEntity? {
        let mesh: MeshResource
        if let cached = hullMeshCache[avatarID] {
            mesh = cached
        } else if let built = VisualHull.buildMesh(from: orientations) {
            hullMeshCache[avatarID] = built
            mesh = built
        } else {
            return nil
        }

        let entity = ModelEntity(mesh: mesh, materials: [makeMaterial(style: style, brighter: brighter)])
        entity.position = [0, 0, 0]
        return entity
    }

    private static func addLimbChain(
        to root: Entity,
        jointMap: [String: JointSnapshot],
        names: (String, String, String),
        radii: [Float],
        style: GhostStyle,
        brighter: Bool
    ) {
        guard
            let start = jointMap[names.0],
            let mid = jointMap[names.1],
            let end = jointMap[names.2]
        else { return }

        let points = [start.position, mid.position, end.position]
        for index in 0..<(points.count - 1) {
            let radius = (radii[index] + radii[index + 1]) / 2
            let segment = makeCapsule(
                from: points[index],
                to: points[index + 1],
                radius: radius,
                style: style,
                brighter: brighter
            )
            root.addChild(segment)
        }
    }

    private static func makeTorso(
        leftShoulder: SIMD3<Float>,
        rightShoulder: SIMD3<Float>,
        leftHip: SIMD3<Float>,
        rightHip: SIMD3<Float>,
        style: GhostStyle,
        brighter: Bool
    ) -> ModelEntity {
        let shoulderCenter = (leftShoulder + rightShoulder) / 2
        let hipCenter = (leftHip + rightHip) / 2
        let shoulderWidth = simd_distance(leftShoulder, rightShoulder)
        let hipWidth = simd_distance(leftHip, rightHip)
        let width = max(shoulderWidth, hipWidth) * 0.72
        let depth = width * 0.48
        let height = max(simd_distance(shoulderCenter, hipCenter), 0.12)

        let mesh = MeshResource.generateBox(size: [width, height, depth], cornerRadius: width * 0.12)
        let entity = ModelEntity(mesh: mesh, materials: [makeMaterial(style: style, brighter: brighter)])
        entity.position = (shoulderCenter + hipCenter) / 2
        return entity
    }

    private static func makeHead(jointMap: [String: JointSnapshot], style: GhostStyle, brighter: Bool) -> ModelEntity? {
        let headJoint = jointMap["head_joint"]
        let leftShoulder = jointMap["left_shoulder_1_joint"]
        let rightShoulder = jointMap["right_shoulder_1_joint"]

        guard let headJoint else { return nil }

        var radius: Float = 0.11
        if let leftShoulder, let rightShoulder {
            radius = max(simd_distance(leftShoulder.position, rightShoulder.position) * 0.22, 0.08)
        }

        let mesh = MeshResource.generateSphere(radius: radius)
        let entity = ModelEntity(mesh: mesh, materials: [makeMaterial(style: style, brighter: brighter)])
        entity.position = headJoint.position
        return entity
    }

    private static func makeCapsule(
        from start: SIMD3<Float>,
        to end: SIMD3<Float>,
        radius: Float,
        style: GhostStyle,
        brighter: Bool
    ) -> ModelEntity {
        let delta = end - start
        let length = max(simd_length(delta) - radius * 2, 0.04)
        let mesh = MeshResource.generateBox(size: [radius * 2, length, radius * 2], cornerRadius: radius)
        let entity = ModelEntity(mesh: mesh, materials: [makeMaterial(style: style, brighter: brighter)])
        entity.position = (start + end) / 2

        let up = SIMD3<Float>(0, 1, 0)
        let direction = simd_normalize(delta)
        entity.orientation = simd_quatf(from: up, to: direction)
        return entity
    }

    private static func makeMaterial(style: GhostStyle, brighter: Bool = false) -> SimpleMaterial {
        var material = SimpleMaterial()
        let alpha = brighter ? min(style.opacity + 0.12, 0.75) : style.opacity
        material.color = .init(tint: style.tint.withAlphaComponent(CGFloat(alpha)))
        material.metallic = .float(style == .cyber || style == .quantum ? 0.8 : 0.08)
        material.roughness = .float(style == .phantom ? 0.95 : (style.isHolographic ? 0.15 : 0.3))
        if style.isHolographic {
            material.color = .init(tint: style.tint.withAlphaComponent(CGFloat(alpha * 1.1)))
        }
        return material
    }
}
