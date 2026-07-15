import Foundation

enum LocalStoreConsistencyError: LocalizedError {
    case placementMissing
    case parentCommentMissing

    var errorDescription: String? {
        switch self {
        case .placementMissing:
            return "这条放置已经不存在，请返回列表刷新后再评论。"
        case .parentCommentMissing:
            return "要回复的评论已经不存在，请刷新评论区后重试。"
        }
    }
}

@MainActor
final class LocalStore: ObservableObject {
    @Published private(set) var avatars: [AvatarPose] = []
    @Published private(set) var placements: [Placement] = []
    @Published private(set) var comments: [Comment] = []
    @Published private(set) var authorName = "我"
    @Published private(set) var lastLoadSummary: String?
    @Published private(set) var lastSaveSummary: String?
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
        lastLoadSummary = nil
        lastSaveSummary = nil
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
                appendLoadWarning("本地快照加载失败：\(error.localizedDescription)")
            }
        }

        legacyReactions = readJSON(from: reactionsURL, label: "旧版评价", fallback: [])
        comments = readJSON(from: commentsURL, label: "评论", fallback: [])
        commentReactions = readJSON(from: commentReactionsURL, label: "评论评价", fallback: [])
        commentLikes = readJSON(from: commentLikesURL, label: "评论点赞", fallback: [])

        if let savedAuthor = try? String(contentsOf: authorURL, encoding: .utf8) {
            let trimmed = savedAuthor.trimmingCharacters(in: .whitespacesAndNewlines)
            authorName = trimmed.isEmpty ? "我" : trimmed
        }

        migrateLegacyReactions()
        purgeOrphanedEngagement()
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

    @discardableResult
    func purgeInvalidPlacements() -> String {
        let validAvatarIDs = Set(avatars.map(\.id))
        let invalidPlacements = placements.filter { placement in
            !validAvatarIDs.contains(placement.avatarPoseID)
                || !AnchorPersistence.worldMapExists(named: placement.anchor.worldMapFilename)
                || !placement.anchor.hasValidTransform
        }
        guard !invalidPlacements.isEmpty else {
            lastMaintenanceSummary = "无效放置清理：没有发现需要清理的放置"
            return lastMaintenanceSummary ?? ""
        }

        let missingAvatar = invalidPlacements.filter { !validAvatarIDs.contains($0.avatarPoseID) }.count
        let invalidWorldMapFilename = invalidPlacements.filter { !AnchorPersistence.isValidWorldMapFilename($0.anchor.worldMapFilename) }.count
        let missingWorldMap = invalidPlacements.filter {
            AnchorPersistence.isValidWorldMapFilename($0.anchor.worldMapFilename)
                && !AnchorPersistence.worldMapExists(named: $0.anchor.worldMapFilename)
        }.count
        let invalidTransform = invalidPlacements.filter { !$0.anchor.hasValidTransform }.count

        placements.removeAll { placement in
            invalidPlacements.contains(where: { $0.id == placement.id })
        }
        invalidPlacements.forEach { purgePlacementEngagement(placementID: $0.id) }
        let worldMapSummary = purgeUnreferencedWorldMaps(invalidPlacements.map(\.anchor.worldMapFilename))
        save()

        lastMaintenanceSummary = "无效放置清理：删除 \(invalidPlacements.count)，缺失虚像 \(missingAvatar)，WorldMap 文件名无效 \(invalidWorldMapFilename)，缺失 WorldMap \(missingWorldMap)，坏 transform \(invalidTransform)；\(worldMapSummary)"
        return lastMaintenanceSummary ?? ""
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
        guard placements.contains(where: { $0.id == placementID }) else {
            throw LocalStoreConsistencyError.placementMissing
        }
        if let parentID {
            guard let parent = comments.first(where: { $0.id == parentID && $0.placementID == placementID }),
                  parent.parentID == nil else {
                throw LocalStoreConsistencyError.parentCommentMissing
            }
        }

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
        var changed = true
        while changed {
            changed = false
            comments.forEach { comment in
                guard let parentID = comment.parentID, toRemove.contains(parentID), !toRemove.contains(comment.id) else {
                    return
                }
                toRemove.insert(comment.id)
                changed = true
            }
        }
        comments.removeAll { toRemove.contains($0.id) }
        commentReactions.removeAll { toRemove.contains($0.commentID) }
        commentLikes.removeAll { toRemove.contains($0.commentID) }
        persistComments()
    }

    // MARK: - Reactions & likes

    @discardableResult
    func setCommentReaction(commentID: UUID, kind: ReactionKind) -> Bool {
        guard topLevelCommentHasExistingPlacement(commentID: commentID) else {
            commentReactions.removeAll { $0.commentID == commentID }
            writeJSON(commentReactions, to: commentReactionsURL)
            return false
        }

        if let existing = commentReactions.first(where: { $0.commentID == commentID }), existing.kind == kind {
            commentReactions.removeAll { $0.commentID == commentID }
        } else {
            commentReactions.removeAll { $0.commentID == commentID }
            commentReactions.append(CommentReaction(commentID: commentID, kind: kind))
        }
        writeJSON(commentReactions, to: commentReactionsURL)
        return true
    }

    func commentReaction(for commentID: UUID) -> ReactionKind? {
        commentReactions.first { $0.commentID == commentID }?.kind
    }

    @discardableResult
    func toggleCommentLike(commentID: UUID) -> Bool {
        guard replyCommentHasExistingPlacement(commentID: commentID) else {
            commentLikes.removeAll { $0.commentID == commentID }
            writeJSON(commentLikes, to: commentLikesURL)
            return false
        }

        if commentLikes.contains(where: { $0.commentID == commentID }) {
            commentLikes.removeAll { $0.commentID == commentID }
        } else {
            commentLikes.append(CommentLike(commentID: commentID))
        }
        writeJSON(commentLikes, to: commentLikesURL)
        return true
    }

    func isCommentLiked(_ commentID: UUID) -> Bool {
        commentLikes.contains { $0.commentID == commentID }
    }

    private func topLevelCommentHasExistingPlacement(commentID: UUID) -> Bool {
        guard let comment = comments.first(where: { $0.id == commentID }) else { return false }
        return comment.parentID == nil && placements.contains { $0.id == comment.placementID }
    }

    private func replyCommentHasExistingPlacement(commentID: UUID) -> Bool {
        guard let comment = comments.first(where: { $0.id == commentID }) else { return false }
        return comment.parentID != nil && placements.contains { $0.id == comment.placementID }
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

    var commentIntegritySummary: String {
        let validPlacementIDs = Set(placements.map(\.id))
        let orphanedCount = orphanedCommentIDs(validPlacementIDs: validPlacementIDs).count
        let topLevelCount = comments.filter { $0.parentID == nil }.count
        let replyCount = comments.filter { $0.parentID != nil }.count
        let invalidReactionCount = commentReactions.filter {
            !topLevelCommentHasExistingPlacement(commentID: $0.commentID)
        }.count
        let invalidLikeCount = commentLikes.filter {
            !replyCommentHasExistingPlacement(commentID: $0.commentID)
        }.count
        return "一级 \(topLevelCount)，回复 \(replyCount)，孤立 \(orphanedCount)，无效评价 \(invalidReactionCount)，无效点赞 \(invalidLikeCount)"
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

    private func purgeOrphanedEngagement() {
        let validPlacementIDs = Set(placements.map(\.id))
        let orphanedCommentIDs = orphanedCommentIDs(validPlacementIDs: validPlacementIDs)
        guard !orphanedCommentIDs.isEmpty else { return }

        comments.removeAll { orphanedCommentIDs.contains($0.id) }
        commentReactions.removeAll { orphanedCommentIDs.contains($0.commentID) }
        commentLikes.removeAll { orphanedCommentIDs.contains($0.commentID) }
        legacyReactions.removeAll { !validPlacementIDs.contains($0.placementID) }
        writeJSON(legacyReactions, to: reactionsURL)
        persistComments()
        lastMaintenanceSummary = "孤立评论清理：删除 \(orphanedCommentIDs.count) 条"
    }

    private func orphanedCommentIDs(validPlacementIDs: Set<UUID>) -> Set<UUID> {
        var orphaned = Set(
            comments.filter { !validPlacementIDs.contains($0.placementID) }.map(\.id)
        )
        var knownComments: [UUID: Comment] = [:]
        comments.forEach { knownComments[$0.id] = $0 }

        var changed = true
        while changed {
            changed = false
            for comment in comments where !orphaned.contains(comment.id) {
                guard let parentID = comment.parentID else { continue }
                guard
                    let parent = knownComments[parentID],
                    !orphaned.contains(parentID),
                    parent.placementID == comment.placementID,
                    parent.parentID == nil
                else {
                    orphaned.insert(comment.id)
                    knownComments.removeValue(forKey: comment.id)
                    changed = true
                    continue
                }
            }
        }
        return orphaned
    }

    @discardableResult
    private func purgeUnreferencedWorldMaps(_ filenames: [String]) -> String {
        let candidates = Set(filenames)
        guard !candidates.isEmpty else {
            lastMaintenanceSummary = "WorldMap 清理：无需清理"
            return lastMaintenanceSummary ?? ""
        }

        let stillReferenced = Set(placements.map(\.anchor.worldMapFilename))
        let referencedCount = candidates.filter { stillReferenced.contains($0) }.count
        let results = candidates
            .filter { !stillReferenced.contains($0) }
            .map { AnchorPersistence.deleteWorldMap(named: $0) }

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

        var parts = ["WorldMap 清理：删除 \(deleted)，已缺失 \(missing)，仍被引用 \(referencedCount)"]
        if !failed.isEmpty {
            parts.append("失败 \(failed.count)：\(failed.joined(separator: "；"))")
        }
        lastMaintenanceSummary = parts.joined(separator: "；")
        return lastMaintenanceSummary ?? ""
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

    private func readJSON<T: Decodable>(from url: URL, label: String, fallback: T) -> T {
        guard FileManager.default.fileExists(atPath: url.path) else {
            return fallback
        }

        do {
            let data = try Data(contentsOf: url)
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            appendLoadWarning("\(label)数据加载失败：\(error.localizedDescription)")
            return fallback
        }
    }

    private func appendLoadWarning(_ message: String) {
        if let lastLoadSummary, !lastLoadSummary.isEmpty {
            self.lastLoadSummary = "\(lastLoadSummary)；\(message)"
        } else {
            lastLoadSummary = message
        }
    }

    private func appendSaveWarning(_ message: String) {
        if let lastSaveSummary, !lastSaveSummary.isEmpty {
            self.lastSaveSummary = "\(lastSaveSummary)；\(message)"
        } else {
            lastSaveSummary = message
        }
    }

    private func writeJSON<T: Encodable>(_ value: T, to url: URL) {
        do {
            let data = try JSONEncoder().encode(value)
            try data.write(to: url, options: .atomic)
        } catch {
            appendSaveWarning("本地数据写入失败：\(url.lastPathComponent)，\(error.localizedDescription)")
        }
    }
}
