import CoreLocation
import Foundation

enum PlacementVisibility: String, Codable, CaseIterable, Hashable {
    case `private`
    case `public`

    var displayName: String {
        switch self {
        case .private: return "仅自己"
        case .public: return "公开"
        }
    }
}

struct PlacementAnchorRecord: Codable, Hashable {
    static let transformElementCount = 16

    /// Stable identifier for the AR anchor within a world map session.
    let anchorIdentifier: UUID
    /// Serialized 4x4 transform (column-major) at placement time.
    let transform: [Float]
    /// Filename of persisted ARWorldMap in app documents.
    let worldMapFilename: String
    /// Optional geo metadata for future cloud sync / outdoor hints.
    var latitude: Double?
    var longitude: Double?
    var altitude: Double?
    var headingDegrees: Double?
    /// ARGeoAnchor 元数据，支持多锚点定位链。
    var geoAnchorLatitude: Double?
    var geoAnchorLongitude: Double?
    var geoAnchorAltitude: Double?
    var geoAnchorHeadingDegrees: Double?
    var vpsMapId: String?
    var vpsAnchorId: String?

    init(
        anchorIdentifier: UUID,
        transform: [Float],
        worldMapFilename: String,
        latitude: Double? = nil,
        longitude: Double? = nil,
        altitude: Double? = nil,
        headingDegrees: Double? = nil,
        geoAnchorLatitude: Double? = nil,
        geoAnchorLongitude: Double? = nil,
        geoAnchorAltitude: Double? = nil,
        geoAnchorHeadingDegrees: Double? = nil,
        vpsMapId: String? = nil,
        vpsAnchorId: String? = nil
    ) {
        self.anchorIdentifier = anchorIdentifier
        self.transform = transform
        self.worldMapFilename = worldMapFilename
        self.latitude = latitude
        self.longitude = longitude
        self.altitude = altitude
        self.headingDegrees = headingDegrees
        self.geoAnchorLatitude = geoAnchorLatitude
        self.geoAnchorLongitude = geoAnchorLongitude
        self.geoAnchorAltitude = geoAnchorAltitude
        self.geoAnchorHeadingDegrees = geoAnchorHeadingDegrees
        self.vpsMapId = vpsMapId
        self.vpsAnchorId = vpsAnchorId
    }

    var hasValidTransform: Bool {
        transform.count == Self.transformElementCount
    }
}

struct Placement: Codable, Identifiable, Hashable {
    static let localOwnerID = "me"

    let id: UUID
    let avatarPoseID: UUID
    var message: String
    var anchor: PlacementAnchorRecord
    /// 放置者标识；本机单用户默认 "me"
    var ownerID: String
    /// 可见性；旧数据缺省为 private
    var visibility: PlacementVisibility
    let createdAt: Date

    init(
        id: UUID = UUID(),
        avatarPoseID: UUID,
        message: String,
        anchor: PlacementAnchorRecord,
        ownerID: String = Placement.localOwnerID,
        visibility: PlacementVisibility = .private,
        createdAt: Date = Date()
    ) {
        self.id = id
        self.avatarPoseID = avatarPoseID
        self.message = message
        self.anchor = anchor
        self.ownerID = ownerID
        self.visibility = visibility
        self.createdAt = createdAt
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(UUID.self, forKey: .id)
        avatarPoseID = try container.decode(UUID.self, forKey: .avatarPoseID)
        message = try container.decode(String.self, forKey: .message)
        anchor = try container.decode(PlacementAnchorRecord.self, forKey: .anchor)
        ownerID = try container.decodeIfPresent(String.self, forKey: .ownerID) ?? Placement.localOwnerID
        visibility = try container.decodeIfPresent(PlacementVisibility.self, forKey: .visibility) ?? .private
        createdAt = try container.decode(Date.self, forKey: .createdAt)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(avatarPoseID, forKey: .avatarPoseID)
        try container.encode(message, forKey: .message)
        try container.encode(anchor, forKey: .anchor)
        try container.encode(ownerID, forKey: .ownerID)
        try container.encode(visibility, forKey: .visibility)
        try container.encode(createdAt, forKey: .createdAt)
    }

    private enum CodingKeys: String, CodingKey {
        case id, avatarPoseID, message, anchor, ownerID, visibility, createdAt
    }
}

struct BridgeSnapshot: Codable {
    var avatars: [AvatarPose]
    var placements: [Placement]
}
