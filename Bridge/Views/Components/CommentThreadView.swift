import SwiftUI

struct CommentThreadView: View {
    @EnvironmentObject private var store: LocalStore
    @EnvironmentObject private var diagnostics: BridgeDiagnostics

    let placementID: UUID

    @State private var topLevelText = ""
    @State private var authorName = ""
    @State private var replyTarget: ReplyTarget?
    @State private var replyText = ""
    @State private var errorMessage: String?
    @State private var commentToDelete: UUID?
    @State private var showDeleteCommentConfirm = false

    private struct ReplyTarget: Identifiable {
        let id: UUID
        let topCommentID: UUID
        let replyToName: String?
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            engagementSummary

            if !placementExists {
                Text("这条放置已经不存在，评论区已停止写入。")
                    .font(.caption)
                    .foregroundStyle(.red)
            } else {
                activeThreadContent
            }
        }
        .alert("删除评论", isPresented: $showDeleteCommentConfirm) {
            Button("取消", role: .cancel) {
                commentToDelete = nil
            }
            Button("删除", role: .destructive) {
                if let id = commentToDelete {
                    store.deleteComment(id: id)
                    diagnostics.record("删除评论：\(id.uuidString)", scope: "Comments")
                }
                commentToDelete = nil
            }
        } message: {
            Text("确定删除这条评论吗？其下的回复也会一并删除。")
        }
        .onAppear {
            authorName = store.authorName
        }
    }

    private var activeThreadContent: some View {
        Group {
            authorField

            let topComments = store.topLevelComments(placementID: placementID)
            if topComments.isEmpty {
                Text("还没有评论，来说两句。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            if !topComments.isEmpty {
                ForEach(topComments) { comment in
                    topLevelCommentRow(comment)
                }
            }

            topLevelCompose

            if let errorMessage {
                Text(errorMessage)
                    .font(.caption)
                    .foregroundStyle(.red)
            }
        }
    }

    private var engagementSummary: some View {
        let engagement = store.placementEngagement(placementID: placementID)
        return Text(
            "💬 \(engagement.commentCount) · 有用 \(engagement.reactionCounts.useful) · 无用 \(engagement.reactionCounts.useless) · 欢乐 \(engagement.reactionCounts.joyful)"
        )
        .font(.caption)
        .foregroundStyle(.secondary)
    }

    private var authorField: some View {
        HStack(spacing: 8) {
            Text("昵称")
                .font(.caption)
                .foregroundStyle(.secondary)
            TextField("我", text: $authorName)
                .textFieldStyle(.roundedBorder)
                .onChange(of: authorName) { _, newValue in
                    store.setAuthorName(newValue)
                }
        }
    }

    private var topLevelCompose: some View {
        HStack(spacing: 8) {
            TextField("写下你的评价…", text: $topLevelText)
                .textFieldStyle(.roundedBorder)
            Button("评论") {
                submitTopLevel()
            }
            .buttonStyle(.borderedProminent)
            .disabled(!placementExists)
        }
    }

    private var placementExists: Bool {
        store.placement(for: placementID) != nil
    }

    private func topLevelCommentRow(_ comment: Comment) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            commentHeader(comment)

            Text(comment.text)
                .font(.subheadline)

            HStack(spacing: 6) {
                ForEach(ReactionKind.allCases) { kind in
                    reactionButton(commentID: comment.id, kind: kind)
                }
                Button("回复") {
                    replyTarget = ReplyTarget(
                        id: comment.id,
                        topCommentID: comment.id,
                        replyToName: comment.authorName
                    )
                    replyText = ""
                }
                .buttonStyle(.bordered)
                .font(.caption)
                .disabled(!placementExists)

                Button("删除", role: .destructive) {
                    commentToDelete = comment.id
                    showDeleteCommentConfirm = true
                }
                .buttonStyle(.bordered)
                .font(.caption)
                .disabled(!placementExists)
            }

            let replies = store.replies(to: comment.id)
            if !replies.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(replies) { reply in
                        replyRow(reply, topCommentID: comment.id)
                    }
                }
                .padding(.leading, 12)
            }

            if replyTarget?.topCommentID == comment.id {
                replyCompose(topCommentID: comment.id)
            }
        }
        .padding(10)
        .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 10))
    }

    private func replyRow(_ reply: Comment, topCommentID: UUID) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Text(reply.authorName)
                    .font(.caption.bold())
                if let name = reply.replyToName {
                    Text("回复 @\(name)")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Text(reply.createdAt.formatted(date: .abbreviated, time: .shortened))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }

            Text(reply.text)
                .font(.caption)

            HStack(spacing: 6) {
                let liked = store.isCommentLiked(reply.id)
                Button(liked ? "已赞" : "赞") {
                    if store.toggleCommentLike(commentID: reply.id) {
                        errorMessage = nil
                        diagnostics.record("切换评论点赞：\(reply.id.uuidString)", scope: "Comments")
                    } else {
                        errorMessage = LocalStoreConsistencyError.parentCommentMissing.localizedDescription
                        diagnostics.record("评论点赞失败：评论或放置已不存在，comment=\(reply.id.uuidString)", scope: "Comments")
                    }
                }
                .buttonStyle(.bordered)
                .font(.caption)
                .tint(liked ? .accentColor : .secondary)
                .disabled(!placementExists)

                Button("回复") {
                    replyTarget = ReplyTarget(
                        id: reply.id,
                        topCommentID: topCommentID,
                        replyToName: reply.authorName
                    )
                    replyText = ""
                }
                .buttonStyle(.bordered)
                .font(.caption)
                .disabled(!placementExists)

                Button("删除", role: .destructive) {
                    commentToDelete = reply.id
                    showDeleteCommentConfirm = true
                }
                .buttonStyle(.bordered)
                .font(.caption)
                .disabled(!placementExists)
            }
        }
        .padding(8)
        .background(Color.primary.opacity(0.03), in: RoundedRectangle(cornerRadius: 8))
    }

    private func replyCompose(topCommentID: UUID) -> some View {
        let placeholder = replyTarget?.replyToName.map { "回复 @\($0)" } ?? "回复…"
        return VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                TextField(placeholder, text: $replyText)
                    .textFieldStyle(.roundedBorder)
                Button("发送") {
                    submitReply(topCommentID: topCommentID)
                }
                .buttonStyle(.borderedProminent)
                .disabled(!placementExists)
                Button("取消") {
                    replyTarget = nil
                    replyText = ""
                }
                .buttonStyle(.bordered)
            }
        }
        .padding(.top, 4)
    }

    private func commentHeader(_ comment: Comment) -> some View {
        HStack {
            Text(comment.authorName)
                .font(.caption.bold())
            Spacer()
            Text(comment.createdAt.formatted(date: .abbreviated, time: .shortened))
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
    }

    private func reactionButton(commentID: UUID, kind: ReactionKind) -> some View {
        let active = store.commentReaction(for: commentID) == kind
        let count = active ? 1 : 0
        return Button {
            if store.setCommentReaction(commentID: commentID, kind: kind) {
                errorMessage = nil
                diagnostics.record("切换评论反应：\(commentID.uuidString)，\(kind.rawValue)", scope: "Comments")
            } else {
                errorMessage = LocalStoreConsistencyError.parentCommentMissing.localizedDescription
                diagnostics.record("评论反应失败：评论或放置已不存在，comment=\(commentID.uuidString)", scope: "Comments")
            }
        } label: {
            Label("\(kind.displayName) \(count)", systemImage: kind.systemImage)
                .font(.caption)
        }
        .buttonStyle(.bordered)
        .tint(active ? .accentColor : .secondary)
        .disabled(!placementExists)
    }

    private func submitTopLevel() {
        guard placementExists else {
            let message = LocalStoreConsistencyError.placementMissing.localizedDescription
            errorMessage = message
            diagnostics.record("评论失败：\(message)", scope: "Comments")
            return
        }
        do {
            let comment = try store.addComment(placementID: placementID, text: topLevelText, parentID: nil)
            topLevelText = ""
            errorMessage = nil
            diagnostics.record("新增一级评论：\(comment.id.uuidString)", scope: "Comments")
        } catch {
            errorMessage = error.localizedDescription
            diagnostics.record("评论失败：\(error.localizedDescription)", scope: "Comments")
        }
    }

    private func submitReply(topCommentID: UUID) {
        guard placementExists else {
            let message = LocalStoreConsistencyError.placementMissing.localizedDescription
            errorMessage = message
            diagnostics.record("回复失败：\(message)", scope: "Comments")
            return
        }
        do {
            let comment = try store.addComment(
                placementID: placementID,
                text: replyText,
                parentID: topCommentID,
                replyToName: replyTarget?.replyToName
            )
            replyText = ""
            replyTarget = nil
            errorMessage = nil
            diagnostics.record("新增回复：\(comment.id.uuidString)，parent=\(topCommentID.uuidString)", scope: "Comments")
        } catch {
            errorMessage = error.localizedDescription
            diagnostics.record("回复失败：\(error.localizedDescription)", scope: "Comments")
        }
    }
}
