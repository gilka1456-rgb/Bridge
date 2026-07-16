import SwiftUI

struct MyPlacementsView: View {
    @EnvironmentObject private var store: LocalStore
    @EnvironmentObject private var diagnostics: BridgeDiagnostics

    @State private var placementToDelete: Placement?
    @State private var showDeleteConfirm = false

    var body: some View {
        NavigationStack {
            Group {
                let mine = store.myPlacements()
                if mine.isEmpty {
                    ContentUnavailableView(
                        "还没有放置",
                        systemImage: "mappin.slash",
                        description: Text("去「放置」留下第一个虚像。")
                    )
                } else {
                    List(mine) { placement in
                        placementRow(placement)
                    }
                }
            }
            .navigationTitle("我的放置")
            .alert("删除放置", isPresented: $showDeleteConfirm) {
                Button("取消", role: .cancel) {
                    placementToDelete = nil
                }
                Button("删除", role: .destructive) {
                    if let placement = placementToDelete {
                        let engagement = store.placementEngagement(placementID: placement.id)
                        let persisted = store.deletePlacement(placement)
                        diagnostics.record(
                            "\(persisted ? "删除放置" : "删除放置警告：本地写入失败，本次删除已回滚")：\(placement.id.uuidString)，worldMap=\(placement.anchor.worldMapFilename)，comments=\(engagement.commentCount)，\(store.lastMaintenanceSummary ?? "WorldMap 无需清理")",
                            scope: "MyPlacements"
                        )
                    }
                    placementToDelete = nil
                }
            } message: {
                Text("确定删除这个放置吗？相关评论也会一并删除，且无法恢复。")
            }
        }
    }

    private func placementRow(_ placement: Placement) -> some View {
        let avatar = store.avatar(for: placement.avatarPoseID)
        let engagement = store.placementEngagement(placementID: placement.id)

        return VStack(alignment: .leading, spacing: 8) {
            Text(avatar?.label ?? "未知虚像")
                .font(.headline)

            Text(placement.createdAt.formatted(date: .abbreviated, time: .shortened))
                .font(.caption)
                .foregroundStyle(.secondary)

            Text(placement.message)
                .font(.subheadline)
                .lineLimit(3)

            Text(
                "💬 \(engagement.commentCount) · 有用 \(engagement.reactionCounts.useful) · 无用 \(engagement.reactionCounts.useless) · 欢乐 \(engagement.reactionCounts.joyful)"
            )
            .font(.caption)
            .foregroundStyle(.secondary)

            HStack(spacing: 12) {
                NavigationLink {
                    PlacementDetailView(placement: placement)
                } label: {
                    Text("查看/评论")
                }
                .buttonStyle(.bordered)

                Button("删除放置", role: .destructive) {
                    placementToDelete = placement
                    showDeleteConfirm = true
                }
                .buttonStyle(.bordered)
            }
        }
        .padding(.vertical, 4)
    }
}
