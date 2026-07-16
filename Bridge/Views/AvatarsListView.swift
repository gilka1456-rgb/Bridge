import SwiftUI

struct AvatarsListView: View {
    @EnvironmentObject private var store: LocalStore
    @EnvironmentObject private var diagnostics: BridgeDiagnostics

    @Binding var scanHasUnsaved: Bool
    @Binding var discardGeneration: Int
    @Binding var openScanOnAppear: Bool

    @State private var avatarToDelete: AvatarPose?
    @State private var showDeleteConfirm = false
    @State private var showScan = false
    @State private var showLeaveScanConfirm = false

    init(
        scanHasUnsaved: Binding<Bool> = .constant(false),
        discardGeneration: Binding<Int> = .constant(0),
        openScanOnAppear: Binding<Bool> = .constant(false)
    ) {
        _scanHasUnsaved = scanHasUnsaved
        _discardGeneration = discardGeneration
        _openScanOnAppear = openScanOnAppear
    }

    var body: some View {
        NavigationStack {
            Group {
                if store.avatars.isEmpty {
                    emptyState
                } else {
                    List {
                        Section {
                            Button {
                                showScan = true
                            } label: {
                                Label("扫描新虚像", systemImage: "figure.stand")
                            }
                        }

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
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        showScan = true
                    } label: {
                        Label("扫描", systemImage: "plus")
                    }
                }
            }
            .navigationDestination(isPresented: scanPresentation) {
                ScanARView(
                    hasUnsavedScan: $scanHasUnsaved,
                    discardGeneration: discardGeneration
                )
            }
            .onAppear {
                if openScanOnAppear {
                    openScanOnAppear = false
                    showScan = true
                }
            }
            .onChange(of: discardGeneration) { _, _ in
                showScan = false
            }
            .alert("扫描尚未保存", isPresented: $showLeaveScanConfirm) {
                Button("留下", role: .cancel) {}
                Button("离开", role: .destructive) {
                    scanHasUnsaved = false
                    discardGeneration += 1
                    showScan = false
                }
            } message: {
                Text("离开将丢失本次已记录的方位。确定要离开扫描吗？")
            }
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
                    let persisted = store.deleteAvatar(avatar)
                    diagnostics.record(
                        "\(persisted ? "删除虚像" : "删除虚像警告：本地写入失败，本次删除已回滚")：\(avatar.id.uuidString)，linkedPlacements=\(linkedPlacements.count)，comments=\(linkedComments)，\(store.lastMaintenanceSummary ?? "WorldMap 无需清理")",
                        scope: "Avatars"
                    )
                }
                avatarToDelete = nil
            }
        }
    }

    private var scanPresentation: Binding<Bool> {
        Binding(
            get: { showScan },
            set: { nextValue in
                if !nextValue, scanHasUnsaved {
                    showLeaveScanConfirm = true
                } else {
                    showScan = nextValue
                }
            }
        )
    }

    private var emptyState: some View {
        VStack(spacing: 16) {
            ContentUnavailableView(
                "还没有虚像",
                systemImage: "figure.stand.line.dotted.figure.stand",
                description: Text("先扫描人体姿势，生成第一个可放置的虚像。")
            )

            Button {
                showScan = true
            } label: {
                Label("扫描虚像", systemImage: "figure.stand")
            }
            .buttonStyle(.borderedProminent)
        }
        .padding()
    }
}
