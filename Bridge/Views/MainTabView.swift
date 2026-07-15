import SwiftUI

enum AppTab: Hashable {
    case discover
    case avatars
    case place
    case records
    case mine
}

struct MainTabView: View {
    @EnvironmentObject private var store: LocalStore
    @EnvironmentObject private var diagnostics: BridgeDiagnostics

    @State private var selectedTab: AppTab = .discover
    @State private var pendingTab: AppTab?
    @State private var showLeaveScanConfirm = false
    @State private var scanHasUnsaved = false
    @State private var scanDiscardGeneration = 0
    @State private var routedInitialEmptyState = false
    @State private var openScanOnAvatarsAppear = false

    var body: some View {
        TabView(selection: $selectedTab) {
            DiscoverARView()
                .tabItem {
                    Label("看见", systemImage: "viewfinder")
                }
                .tag(AppTab.discover)

            AvatarsListView(
                scanHasUnsaved: $scanHasUnsaved,
                discardGeneration: $scanDiscardGeneration,
                openScanOnAppear: $openScanOnAvatarsAppear
            )
                .tabItem {
                    Label("虚像", systemImage: "person.crop.square")
                }
                .tag(AppTab.avatars)

            PlaceARView()
                .tabItem {
                    Label("放置", systemImage: "mappin.and.ellipse")
                }
                .tag(AppTab.place)

            RecordsView()
                .tabItem {
                    Label("记录", systemImage: "photo.on.rectangle")
                }
                .tag(AppTab.records)

            MineView()
                .tabItem {
                    Label("我的", systemImage: "person.crop.circle")
                }
                .tag(AppTab.mine)
        }
        .tint(Color(red: 0.72, green: 0.82, blue: 1.0))
        .onAppear {
            routeInitialEmptyStateIfNeeded()
        }
        .onChange(of: selectedTab) { oldValue, newValue in
            guard oldValue == .avatars, scanHasUnsaved, newValue != .avatars else { return }
            pendingTab = newValue
            selectedTab = .avatars
            showLeaveScanConfirm = true
        }
        .alert("扫描尚未保存", isPresented: $showLeaveScanConfirm) {
            Button("留下", role: .cancel) {
                pendingTab = nil
            }
            Button("离开", role: .destructive) {
                scanHasUnsaved = false
                scanDiscardGeneration += 1
                if let pendingTab {
                    selectedTab = pendingTab
                }
                self.pendingTab = nil
            }
        } message: {
            Text("离开将丢失本次已记录的方位。确定要离开扫描吗？")
        }
    }

    private func routeInitialEmptyStateIfNeeded() {
        guard !routedInitialEmptyState else { return }
        routedInitialEmptyState = true
        guard store.avatars.isEmpty, store.placements.isEmpty else { return }
        selectedTab = .avatars
        openScanOnAvatarsAppear = true
        diagnostics.record("首次启动且无虚像/放置，已引导到虚像内扫描页", scope: "App")
    }
}

private struct RecordsView: View {
    var body: some View {
        NavigationStack {
            ContentUnavailableView(
                "还没有记录",
                systemImage: "photo.on.rectangle",
                description: Text("真机验证通过后，用「看见」拍摄的 AR 照片会出现在这里。")
            )
            .navigationTitle("记录")
        }
    }
}

private struct MineView: View {
    @EnvironmentObject private var store: LocalStore

    var body: some View {
        NavigationStack {
            List {
                Section {
                    NavigationLink {
                        MyPlacementsView()
                    } label: {
                        Label("我的放置", systemImage: "tray.full")
                    }

                    NavigationLink {
                        DiagnosticsView()
                    } label: {
                        Label("诊断", systemImage: "stethoscope")
                    }
                }

                Section("本机数据") {
                    LabeledContent("虚像", value: "\(store.avatars.count)")
                    LabeledContent("放置", value: "\(store.placements.count)")
                    LabeledContent("评论", value: "\(store.comments.count)")
                }
            }
            .navigationTitle("我的")
        }
    }
}
