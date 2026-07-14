import Foundation

@MainActor
final class LocalStore: ObservableObject {
    @Published private(set) var avatars: [AvatarPose] = []
    @Published private(set) var placements: [Placement] = []
    @Published private(set) var comments: [Comment] = []
    @Published private(set) var authorName = "我"
    @Published private(set) var lastMaintenanceSummary: String?

    private let snapshotURL: URL
    private let reactionsURL: URL
    private let commentsURL: URL
    private let commentReactionsURL: URL
    private let commentLikesURL: URL
    private let authorURL: URL
    private let migratedURL: URL

    private var legacyReactions: [ReactionRecord] = []
    private var commentReactions: [CommentReaction] = []
    private var commentLikes: [CommentLike] = []

    init() {
        let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        snapshotURL = documents.appendingPathComponent("bridge_snapshot.json")
        reactionsURL = documents.appendingPathComponent("bridge_reactions.json")
        commentsURL = documents.appendingPathComponent("bridge_comments.json")
        commentReactionsURL = documents.appendingPathComponent("bridge_comment_reactions.json")
        commentLikesURL = documents.appendingPathComponent("bridge_comment_likes.json")
        authorURL = documents.appendingPathComponent("bridge_author.txt")
        migratedURL = documents.appendingPathComponent("bridge_reactions_migrated.flag")
        load()
    }

    // MARK: - Snapshot

    func load() {
        if FileManager.default.fileExists(atPath: snapshotURL.path) {
            do {
                let data = try Data(contentsOf: snapshotURL)
                let snapshot = try JSONDecoder().decode(BridgeSnapshot.self, from: data)
                avatars = snapshot.avatars
                placements = snapshot.placements.map { placement in
                    var copy = placement
                    if copy.ownerID.isEmpty {
                        copy.ownerID = Placement.localOwnerID
                    }
                    return copy
                }
            } catch {
                avatars = []
                placements = []
            }
        }

        legacyReactions = readJSON(from: reactionsURL, fallback: [])
        comments = readJSON(from: commentsURL, fallback: [])
        commentReactions = readJSON(from: commentReactionsURL, fallback: [])
        commentLikes = readJSON(from: commentLikesURL, fallback: [])

        if let savedAuthor = try? String(contentsOf: authorURL, encoding: .utf8) {
            let trimmed = savedAuthor.trimmingCharacters(in: .whitespacesAndNewlines)
            authorName = trimmed.isEmpty ? "我" : trimmed
        }

        migrateLegacyReactions()
    }

    func save() {
        let snapshot = BridgeSnapshot(avatars: avatars, placements: placements)
        writeJSON(snapshot, to: snapshotURL)
    }

    // MARK: - Avatars & placements

    func addAvatar(_ avatar: AvatarPose) {
        avatars.insert(avatar, at: 0)
        save()
    }

    func deleteAvatar(_ avatar: AvatarPose) {
        avatars.removeAll { $0.id == avatar.id }
        let removedPlacements = placements.filter { $0.avatarPoseID == avatar.id }
        placements.removeAll { $0.avatarPoseID == avatar.id }
        removedPlacements.forEach { purgePlacementEngagement(placementID: $0.id) }
        purgeUnreferencedWorldMaps(removedPlacements.map(\.anchor.worldMapFilename))
        save()
    }

    func addPlacement(_ placement: Placement) {
        var copy = placement
        if copy.ownerID.isEmpty {
            copy.ownerID = Placement.localOwnerID
        }
        placements.insert(copy, at: 0)
        save()
    }

    func deletePlacement(_ placement: Placement) {
        placements.removeAll { $0.id == placement.id }
        purgePlacementEngagement(placementID: placement.id)
        purgeUnreferencedWorldMaps([placement.anchor.worldMapFilename])
        save()
    }

    func deletePlacement(id: UUID) {
        guard let placement = placements.first(where: { $0.id == id }) else { return }
        deletePlacement(placement)
    }

    func myPlacements() -> [Placement] {
        placements.filter { ($0.ownerID.isEmpty ? Placement.localOwnerID : $0.ownerID) == Placement.localOwnerID }
    }

    func avatar(for id: UUID) -> AvatarPose? {
        avatars.first { $0.id == id }
    }

    func placement(for id: UUID) -> Placement? {
        placements.first { $0.id == id }
    }

    // MARK: - Author name

    func setAuthorName(_ name: String) {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        authorName = trimmed.isEmpty ? "我" : trimmed
        try? authorName.write(to: authorURL, atomically: true, encoding: .utf8)
    }

    // MARK: - Comments

    @discardableResult
    func addComment(
        placementID: UUID,
        text: String,
        parentID: UUID?,
        replyToName: String? = nil
    ) throws -> Comment {
        let approved = try MessageModeration.validate(text)
        let comment = Comment(
            placementID: placementID,
            parentID: parentID,
            replyToName: replyToName,
            authorName: authorName,
            text: approved,
            createdAt: Date()
        )
        comments.append(comment)
        persistComments()
        return comment
    }

    func topLevelComments(placementID: UUID) -> [Comment] {
        comments
            .filter { $0.placementID == placementID && $0.parentID == nil }
            .sorted { $0.createdAt < $1.createdAt }
    }

    func replies(to commentID: UUID) -> [Comment] {
        comments
            .filter { $0.parentID == commentID }
            .sorted { $0.createdAt < $1.createdAt }
    }

    func deleteComment(id: UUID) {
        var toRemove = Set<UUID>([id])
        comments.forEach { comment in
            if comment.parentID == id {
                toRemove.insert(comment.id)
            }
        }
        comments.removeAll { toRemove.contains($0.id) }
        commentReactions.removeAll { toRemove.contains($0.commentID) }
        commentLikes.removeAll { toRemove.contains($0.commentID) }
        persistComments()
    }

    // MARK: - Reactions & likes

    func setCommentReaction(commentID: UUID, kind: ReactionKind) {
        if let existing = commentReactions.first(where: { $0.commentID == commentID }), existing.kind == kind {
            commentReactions.removeAll { $0.commentID == commentID }
        } else {
            commentReactions.removeAll { $0.commentID == commentID }
            commentReactions.append(CommentReaction(commentID: commentID, kind: kind))
        }
        writeJSON(commentReactions, to: commentReactionsURL)
    }

    func commentReaction(for commentID: UUID) -> ReactionKind? {
        commentReactions.first { $0.commentID == commentID }?.kind
    }

    func toggleCommentLike(commentID: UUID) {
        if commentLikes.contains(where: { $0.commentID == commentID }) {
            commentLikes.removeAll { $0.commentID == commentID }
        } else {
            commentLikes.append(CommentLike(commentID: commentID))
        }
        writeJSON(commentLikes, to: commentLikesURL)
    }

    func isCommentLiked(_ commentID: UUID) -> Bool {
        commentLikes.contains { $0.commentID == commentID }
    }

    func placementEngagement(placementID: UUID) -> PlacementEngagement {
        let placementComments = comments.filter { $0.placementID == placementID }
        let topLevelIDs = Set(
            placementComments.filter { $0.parentID == nil }.map(\.id)
        )
        var reactionCounts = CommentReactionCounts()
        commentReactions.forEach { reaction in
            if topLevelIDs.contains(reaction.commentID) {
                switch reaction.kind {
                case .useful: reactionCounts.useful += 1
                case .useless: reactionCounts.useless += 1
                case .joyful: reactionCounts.joyful += 1
                }
            }
        }
        return PlacementEngagement(
            commentCount: placementComments.count,
            reactionCounts: reactionCounts
        )
    }

    // MARK: - Private

    private func purgePlacementEngagement(placementID: UUID) {
        let removedIDs = Set(
            comments.filter { $0.placementID == placementID }.map(\.id)
        )
        comments.removeAll { $0.placementID == placementID }
        commentReactions.removeAll { removedIDs.contains($0.commentID) }
        commentLikes.removeAll { removedIDs.contains($0.commentID) }
        legacyReactions.removeAll { $0.placementID == placementID }
        writeJSON(legacyReactions, to: reactionsURL)
        persistComments()
    }

    private func purgeUnreferencedWorldMaps(_ filenames: [String]) {
        let stillReferenced = Set(placements.map(\.anchor.worldMapFilename))
        let results = Set(filenames)
            .filter { !stillReferenced.contains($0) }
            .map { AnchorPersistence.deleteWorldMap(named: $0) }
        guard !results.isEmpty else { return }

        let deleted = results.filter {
            if case .deleted = $0 { return true }
            return false
        }.count
        let missing = results.filter {
            if case .missing = $0 { return true }
            return false
        }.count
        let failed = results.compactMap { result -> String? in
            if case .failed(let filename, let message) = result {
                return "\(filename): \(message)"
            }
            return nil
        }

        var parts = ["WorldMap 清理：删除 \(deleted)，已缺失 \(missing)"]
        if !failed.isEmpty {
            parts.append("失败 \(failed.count)：\(failed.joined(separator: "；"))")
        }
        lastMaintenanceSummary = parts.joined(separator: "；")
    }

    private func persistComments() {
        writeJSON(comments, to: commentsURL)
        writeJSON(commentReactions, to: commentReactionsURL)
        writeJSON(commentLikes, to: commentLikesURL)
    }

    /// 旧版放置级评价迁移为系统一级评论 + 评论评价。
    private func migrateLegacyReactions() {
        guard !FileManager.default.fileExists(atPath: migratedURL.path) else { return }

        if !legacyReactions.isEmpty {
            for record in legacyReactions {
                guard placements.contains(where: { $0.id == record.placementID }) else { continue }
                let seed = Comment(
                    placementID: record.placementID,
                    parentID: nil,
                    authorName: "历史评价",
                    text: "（迁移自旧版评价）",
                    createdAt: Date()
                )
                comments.append(seed)
                commentReactions.append(CommentReaction(commentID: seed.id, kind: record.kind))
            }
            persistComments()
        }

        try? "1".write(to: migratedURL, atomically: true, encoding: .utf8)
    }

    private func readJSON<T: Decodable>(from url: URL, fallback: T) -> T {
        guard FileManager.default.fileExists(atPath: url.path),
              let data = try? Data(contentsOf: url),
              let decoded = try? JSONDecoder().decode(T.self, from: data) else {
            return fallback
        }
        return decoded
    }

    private func writeJSON<T: Encodable>(_ value: T, to url: URL) {
        guard let data = try? JSONEncoder().encode(value) else { return }
        try? data.write(to: url, options: .atomic)
    }
}
