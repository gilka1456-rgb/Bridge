import SwiftUI

struct AvatarsListView: View {
    @EnvironmentObject private var store: LocalStore
    @EnvironmentObject private var diagnostics: BridgeDiagnostics

    @State private var avatarToDelete: AvatarPose?
    @State private var showDeleteConfirm = false

    var body: some View {
        NavigationStack {
            Group {
                if store.avatars.isEmpty {
                    ContentUnavailableView(
                        "还没有虚像",
                        systemImage: "figure.stand.line.dotted.figure.stand",
                        description: Text("在「扫描」中捕获你的第一个姿势。")
                    )
                } else {
                    List {
                        ForEach(store.avatars) { avatar in
                            NavigationLink {
                                AvatarDetailView(avatar: avatar)
                            } label: {
                                VStack(alignment: .leading, spacing: 6) {
                                    HStack {
                                        Text(avatar.label)
                                            .font(.headline)
                                        Spacer()
                                        Text(avatar.style.displayName)
                                            .font(.caption)
                                            .padding(.horizontal, 8)
                                            .padding(.vertical, 4)
                                            .background(.ultraThinMaterial, in: Capsule())
                                    }
                                    Text("\(avatar.views.count) 方位 · \(avatar.createdAt.formatted(date: .abbreviated, time: .shortened))")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                                .padding(.vertical, 4)
                            }
                            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                                Button("删除", role: .destructive) {
                                    avatarToDelete = avatar
                                    showDeleteConfirm = true
                                }
                            }
                        }
                    }
                }
            }
            .navigationTitle("我的虚像")
            .confirmAvatarDeletion(
                isPresented: $showDeleteConfirm,
                avatar: avatarToDelete,
                linkedPlacementCount: avatarToDelete.map { avatar in
                    store.placements.filter { $0.avatarPoseID == avatar.id }.count
                } ?? 0,
                onCancel: { avatarToDelete = nil }
            ) {
                if let avatar = avatarToDelete {
                    let linkedPlacements = store.placements.filter { $0.avatarPoseID == avatar.id }
                    let linkedComments = linkedPlacements
                        .map { store.placementEngagement(placementID: $0.id).commentCount }
                        .reduce(0, +)
                    store.deleteAvatar(avatar)
                    diagnostics.record(
                        "删除虚像：\(avatar.id.uuidString)，linkedPlacements=\(linkedPlacements.count)，comments=\(linkedComments)，\(store.lastMaintenanceSummary ?? "WorldMap 无需清理")",
                        scope: "Avatars"
                    )
                }
                avatarToDelete = nil
            }
        }
    }
}
