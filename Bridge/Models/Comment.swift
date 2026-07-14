import Foundation

enum ReactionKind: String, Codable, CaseIterable, Identifiable {
    case useful
    case useless
    case joyful

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .useful: return "有用"
        case .useless: return "无用"
        case .joyful: return "欢乐"
        }
    }

    var systemImage: String {
        switch self {
        case .useful: return "hand.thumbsup"
        case .useless: return "hand.thumbsdown"
        case .joyful: return "face.smiling"
        }
    }
}

/// 一级评论 parentID=nil；二级回复挂在某条一级评论下，扁平结构。
struct Comment: Codable, Identifiable, Hashable {
    let id: UUID
    let placementID: UUID
    let parentID: UUID?
    var replyToName: String?
    let authorName: String
    let text: String
    let createdAt: Date

    init(
        id: UUID = UUID(),
        placementID: UUID,
        parentID: UUID?,
        replyToName: String? = nil,
        authorName: String,
        text: String,
        createdAt: Date = Date()
    ) {
        self.id = id
        self.placementID = placementID
        self.parentID = parentID
        self.replyToName = replyToName
        self.authorName = authorName
        self.text = text
        self.createdAt = createdAt
    }
}

/// 对一级评论的三态评价，每设备每条评论仅一条。
struct CommentReaction: Codable, Hashable {
    let commentID: UUID
    let kind: ReactionKind
}

/// 对二级回复的点赞。
struct CommentLike: Codable, Hashable {
    let commentID: UUID
}

/// 旧版放置级评价，迁移后并入评论体系。
struct ReactionRecord: Codable, Hashable {
    let placementID: UUID
    let kind: ReactionKind
}

struct CommentReactionCounts: Hashable {
    var useful: Int = 0
    var useless: Int = 0
    var joyful: Int = 0
}

struct PlacementEngagement: Hashable {
    var commentCount: Int
    var reactionCounts: CommentReactionCounts
}
