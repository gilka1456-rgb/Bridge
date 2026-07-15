import Foundation
import simd

struct JointSnapshot: Codable, Hashable {
    static let transformElementCount = 16

    let name: String
    let transform: [Float]

    init(name: String, matrix: simd_float4x4) {
        self.name = name
        self.transform = [
            matrix.columns.0.x, matrix.columns.0.y, matrix.columns.0.z, matrix.columns.0.w,
            matrix.columns.1.x, matrix.columns.1.y, matrix.columns.1.z, matrix.columns.1.w,
            matrix.columns.2.x, matrix.columns.2.y, matrix.columns.2.z, matrix.columns.2.w,
            matrix.columns.3.x, matrix.columns.3.y, matrix.columns.3.z, matrix.columns.3.w
        ]
    }

    var hasValidTransform: Bool {
        transform.count == Self.transformElementCount
    }

    var matrix: simd_float4x4 {
        guard hasValidTransform else {
            return matrix_identity_float4x4
        }

        simd_float4x4(
            SIMD4(transform[0], transform[1], transform[2], transform[3]),
            SIMD4(transform[4], transform[5], transform[6], transform[7]),
            SIMD4(transform[8], transform[9], transform[10], transform[11]),
            SIMD4(transform[12], transform[13], transform[14], transform[15])
        )
    }

    var position: SIMD3<Float> {
        SIMD3(matrix.columns.3.x, matrix.columns.3.y, matrix.columns.3.z)
    }
}

enum ScanViewAngle: String, Codable, CaseIterable, Identifiable {
    case front
    case left
    case right
    case back
    case gesture

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .front: return "正面"
        case .left: return "左侧"
        case .right: return "右侧"
        case .back: return "背面"
        case .gesture: return "建言"
        }
    }
}

struct PoseView: Codable, Hashable, Identifiable {
    let id: UUID
    var angle: ScanViewAngle
    var joints: [JointSnapshot]
    var silhouetteContour: [SilhouettePoint]?
    var bodyProfile: [BodyProfileSlice]?
    let capturedAt: Date

    init(
        id: UUID = UUID(),
        angle: ScanViewAngle,
        joints: [JointSnapshot],
        silhouetteContour: [SilhouettePoint]? = nil,
        bodyProfile: [BodyProfileSlice]? = nil,
        capturedAt: Date = Date()
    ) {
        self.id = id
        self.angle = angle
        self.joints = joints
        self.silhouetteContour = silhouetteContour
        self.bodyProfile = bodyProfile
        self.capturedAt = capturedAt
    }
}

struct AvatarPose: Codable, Identifiable, Hashable {
    let id: UUID
    var label: String
    var style: GhostStyle
    /// 主展示姿势关节（建言优先）
    var joints: [JointSnapshot]
    /// 全身各方位记录
    var views: [PoseView]
    /// 逐朝向全高分割 mask，供视觉外壳重建；可选，旧数据没有
    var orientations: [OrientationMask]?
    let createdAt: Date

    init(
        id: UUID = UUID(),
        label: String,
        style: GhostStyle,
        joints: [JointSnapshot],
        views: [PoseView] = [],
        orientations: [OrientationMask]? = nil,
        createdAt: Date = Date()
    ) {
        self.id = id
        self.label = label
        self.style = style
        self.joints = joints
        self.views = views
        self.orientations = orientations
        self.createdAt = createdAt
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(UUID.self, forKey: .id)
        label = try container.decode(String.self, forKey: .label)
        style = try container.decode(GhostStyle.self, forKey: .style)
        joints = try container.decode([JointSnapshot].self, forKey: .joints)
        createdAt = try container.decode(Date.self, forKey: .createdAt)
        orientations = try container.decodeIfPresent([OrientationMask].self, forKey: .orientations)
        let decodedViews = try container.decodeIfPresent([PoseView].self, forKey: .views) ?? []
        if decodedViews.isEmpty, !joints.isEmpty {
            views = [PoseView(angle: .front, joints: joints, capturedAt: createdAt)]
        } else {
            views = decodedViews
        }
    }

    private enum CodingKeys: String, CodingKey {
        case id, label, style, joints, views, orientations, createdAt
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(label, forKey: .label)
        try container.encode(style, forKey: .style)
        try container.encode(joints, forKey: .joints)
        try container.encode(views, forKey: .views)
        try container.encodeIfPresent(orientations, forKey: .orientations)
        try container.encode(createdAt, forKey: .createdAt)
    }

    static func primaryJoints(from views: [PoseView]) -> [JointSnapshot] {
        if let gesture = views.first(where: { $0.angle == .gesture }) {
            return gesture.joints
        }
        if let front = views.first(where: { $0.angle == .front }) {
            return front.joints
        }
        return views.first?.joints ?? []
    }

    func pose(for angle: ScanViewAngle) -> AvatarPose {
        var copy = self
        if let view = views.first(where: { $0.angle == angle }) {
            copy.joints = view.joints
        }
        return copy
    }

    func previewPose(rotationY: Float) -> (pose: AvatarPose, fineRotation: Float) {
        let normalized = ((rotationY.truncatingRemainder(dividingBy: 360)) + 360).truncatingRemainder(dividingBy: 360)
        let angle: ScanViewAngle
        switch normalized {
        case 45..<135: angle = .right
        case 135..<225: angle = .back
        case 225..<315: angle = .left
        default: angle = .front
        }

        let base: Float
        switch angle {
        case .front: base = 0
        case .right: base = 90
        case .back: base = 180
        case .left: base = 270
        case .gesture: base = 0
        }

        var pose = self
        if let view = views.first(where: { $0.angle == angle }) ?? views.first(where: { $0.angle == .front }) {
            pose.joints = view.joints
        }
        return (pose, normalized - base)
    }

    func viewData(for angle: ScanViewAngle) -> PoseView? {
        views.first(where: { $0.angle == angle }) ?? views.first(where: { $0.angle == .front })
    }

    var availableAngles: [ScanViewAngle] {
        ScanViewAngle.allCases.filter { angle in
            views.contains(where: { $0.angle == angle })
        }
    }
}

enum ScanMode: String, CaseIterable, Identifiable {
    case guided
    case assisted

    var id: String { rawValue }

    var title: String {
        switch self {
        case .guided: return "自助扫描"
        case .assisted: return "朋友代扫"
        }
    }
}
