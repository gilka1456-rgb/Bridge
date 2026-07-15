import SwiftUI

struct PlacementDetailView: View {
    @EnvironmentObject private var store: LocalStore

    let placement: Placement

    var body: some View {
        Group {
            if let currentPlacement = store.placement(for: placement.id) {
                detailContent(for: currentPlacement)
            } else {
                ContentUnavailableView(
                    "放置已删除",
                    systemImage: "mappin.slash",
                    description: Text("这条放置已经从本机数据中移除，相关评论也已停止写入。")
                )
            }
        }
        .navigationTitle("放置详情")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func detailContent(for placement: Placement) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if let avatar = store.avatar(for: placement.avatarPoseID) {
                    Text(avatar.label)
                        .font(.headline)
                    Text(avatar.style.displayName)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Text(placement.createdAt.formatted(date: .abbreviated, time: .shortened))
                    .font(.caption2)
                    .foregroundStyle(.secondary)

                Text(placement.message)
                    .font(.body)
                    .padding()
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 12))

                CommentThreadView(placementID: placement.id)
            }
            .padding()
        }
    }
}
