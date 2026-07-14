import SwiftUI

struct CommentThreadView: View {
    @EnvironmentObject private var store: LocalStore

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

            authorField

            let topComments = store.topLevelComments(placementID: placementID)
            if topComments.isEmpty {
                Text("还没有评论，来说两句。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
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
        .alert("删除评论", isPresented: $showDeleteCommentConfirm) {
            Button("取消", role: .cancel) {
                commentToDelete = nil
            }
            Button("删除", role: .destructive) {
                if let id = commentToDelete {
                    store.deleteComment(id: id)
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
        }
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

                Button("删除", role: .destructive) {
                    commentToDelete = comment.id
                    showDeleteCommentConfirm = true
                }
                .buttonStyle(.bordered)
                .font(.caption)
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
                    store.toggleCommentLike(commentID: reply.id)
                }
                .buttonStyle(.bordered)
                .font(.caption)
                .tint(liked ? .accentColor : .secondary)

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

                Button("删除", role: .destructive) {
                    commentToDelete = reply.id
                    showDeleteCommentConfirm = true
                }
                .buttonStyle(.bordered)
                .font(.caption)
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
            store.setCommentReaction(commentID: commentID, kind: kind)
        } label: {
            Label("\(kind.displayName) \(count)", systemImage: kind.systemImage)
                .font(.caption)
        }
        .buttonStyle(.bordered)
        .tint(active ? .accentColor : .secondary)
    }

    private func submitTopLevel() {
        do {
            _ = try store.addComment(placementID: placementID, text: topLevelText, parentID: nil)
            topLevelText = ""
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func submitReply(topCommentID: UUID) {
        do {
            _ = try store.addComment(
                placementID: placementID,
                text: replyText,
                parentID: topCommentID,
                replyToName: replyTarget?.replyToName
            )
            replyText = ""
            replyTarget = nil
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
