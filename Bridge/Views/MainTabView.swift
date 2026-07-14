import SwiftUI

enum AppTab: Hashable {
    case discover
    case scan
    case place
    case mine
    case avatars
}

struct MainTabView: View {
    @State private var selectedTab: AppTab = .discover
    @State private var pendingTab: AppTab?
    @State private var showLeaveScanConfirm = false
    @State private var scanHasUnsaved = false
    @State private var scanDiscardGeneration = 0

    var body: some View {
        TabView(selection: $selectedTab) {
            DiscoverARView()
                .tabItem {
                    Label("看见", systemImage: "viewfinder")
                }
                .tag(AppTab.discover)

            ScanARView(
                hasUnsavedScan: $scanHasUnsaved,
                discardGeneration: scanDiscardGeneration
            )
            .tabItem {
                Label("扫描", systemImage: "figure.stand")
            }
            .tag(AppTab.scan)

            PlaceARView()
                .tabItem {
                    Label("放置", systemImage: "mappin.and.ellipse")
                }
                .tag(AppTab.place)

            MyPlacementsView()
                .tabItem {
                    Label("我的放置", systemImage: "tray.full")
                }
                .tag(AppTab.mine)

            AvatarsListView()
                .tabItem {
                    Label("虚像", systemImage: "person.crop.square")
                }
                .tag(AppTab.avatars)
        }
        .tint(Color(red: 0.72, green: 0.82, blue: 1.0))
        .onChange(of: selectedTab) { oldValue, newValue in
            guard oldValue == .scan, scanHasUnsaved, newValue != .scan else { return }
            pendingTab = newValue
            selectedTab = .scan
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
}
