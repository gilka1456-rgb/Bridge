import CloudKit
import CoreLocation
import Foundation

// MARK: - Cloud record types

enum CloudRecordType {
    static let placement = "PlacementRecord"
    static let avatarPose = "AvatarPoseRecord"
    static let comment = "CommentRecord"
    static let commentReaction = "CommentReactionRecord"
    static let commentLike = "CommentLikeRecord"
}

struct CloudPlacementPayload: Codable, Hashable {
    let id: UUID
    let avatarRef: UUID
    let message: String
    let transform: [Float]
    let headingDegrees: Double?
    let latitude: Double?
    let longitude: Double?
    let altitude: Double?
    let visibility: PlacementVisibility
    let createdAt: Date
    let owner: String
}

struct CloudAvatarPayload: Codable, Hashable {
    let id: UUID
    let label: String
    let styleRaw: String
    let jointsJSON: Data
    let viewsJSON: Data
    let orientationsJSON: Data?
    let createdAt: Date
    let owner: String
}

// MARK: - Protocol

protocol CloudSyncService: AnyObject {
    func hostNearbyPlacements(_ placements: [Placement]) async throws
    func fetchNearbyPlacements(around location: CLLocation, radiusMeters: Double) async throws -> [Placement]
    func uploadPlacement(_ placement: Placement, worldMapData: Data) async throws
    func uploadAvatar(_ avatar: AvatarPose) async throws
    func syncComments(for placementID: UUID) async throws -> [Comment]
    func uploadComment(_ comment: Comment) async throws
    func uploadCommentReaction(_ reaction: CommentReaction) async throws
    func uploadCommentLike(_ like: CommentLike) async throws
}

// MARK: - CloudKit skeleton

final class CloudKitSyncService: CloudSyncService {
    private let container: CKContainer
    private let database: CKDatabase

    init(container: CKContainer = .default()) {
        self.container = container
        database = container.publicCloudDatabase
    }

    func hostNearbyPlacements(_ placements: [Placement]) async throws {
        // TODO: publish placement metadata for nearby discovery queries.
        _ = placements
    }

    func fetchNearbyPlacements(around location: CLLocation, radiusMeters: Double) async throws -> [Placement] {
        // TODO: query PlacementRecord by CLLocation distance.
        _ = location
        _ = radiusMeters
        return []
    }

    func uploadPlacement(_ placement: Placement, worldMapData: Data) async throws {
        // TODO: write PlacementRecord with worldMap CKAsset + indexed location.
        let record = CKRecord(recordType: CloudRecordType.placement, recordID: CKRecord.ID(recordName: placement.id.uuidString))
        record["avatarRef"] = placement.avatarPoseID.uuidString as CKRecordValue
        record["message"] = placement.message as CKRecordValue
        record["transform"] = (try? JSONEncoder().encode(placement.anchor.transform)) as CKRecordValue?
        record["heading"] = placement.anchor.headingDegrees as CKRecordValue?
        if let latitude = placement.anchor.latitude, let longitude = placement.anchor.longitude {
            record["location"] = CLLocation(latitude: latitude, longitude: longitude) as CKRecordValue
        }
        record["visibility"] = placement.visibility.rawValue as CKRecordValue
        record["createdAt"] = placement.createdAt as CKRecordValue
        record["owner"] = placement.ownerID as CKRecordValue
        record["worldMap"] = CKAsset(fileURL: writeTemporaryAsset(data: worldMapData, filename: placement.anchor.worldMapFilename))
        _ = try await database.save(record)
    }

    func uploadAvatar(_ avatar: AvatarPose) async throws {
        // TODO: upload joints/views/orientations JSON blobs to AvatarPoseRecord.
        let record = CKRecord(recordType: CloudRecordType.avatarPose, recordID: CKRecord.ID(recordName: avatar.id.uuidString))
        record["label"] = avatar.label as CKRecordValue
        record["style"] = avatar.style.rawValue as CKRecordValue
        record["createdAt"] = avatar.createdAt as CKRecordValue
        _ = try await database.save(record)
    }

    func syncComments(for placementID: UUID) async throws -> [Comment] {
        // TODO: fetch CommentRecord + reactions/likes for placementID.
        _ = placementID
        return []
    }

    func uploadComment(_ comment: Comment) async throws {
        // TODO: upsert CommentRecord.
        let record = CKRecord(recordType: CloudRecordType.comment, recordID: CKRecord.ID(recordName: comment.id.uuidString))
        record["placementID"] = comment.placementID.uuidString as CKRecordValue
        record["text"] = comment.text as CKRecordValue
        record["createdAt"] = comment.createdAt as CKRecordValue
        _ = try await database.save(record)
    }

    func uploadCommentReaction(_ reaction: CommentReaction) async throws {
        // TODO: upsert CommentReactionRecord.
        let record = CKRecord(
            recordType: CloudRecordType.commentReaction,
            recordID: CKRecord.ID(recordName: reaction.commentID.uuidString)
        )
        record["commentID"] = reaction.commentID.uuidString as CKRecordValue
        record["kind"] = reaction.kind.rawValue as CKRecordValue
        _ = try await database.save(record)
    }

    func uploadCommentLike(_ like: CommentLike) async throws {
        // TODO: upsert CommentLikeRecord.
        let record = CKRecord(
            recordType: CloudRecordType.commentLike,
            recordID: CKRecord.ID(recordName: like.commentID.uuidString)
        )
        record["commentID"] = like.commentID.uuidString as CKRecordValue
        _ = try await database.save(record)
    }

    private func writeTemporaryAsset(data: Data, filename: String) -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(filename)
        try? data.write(to: url, options: .atomic)
        return url
    }
}
