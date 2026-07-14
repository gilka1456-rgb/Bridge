import SwiftUI

@main
struct BridgeApp: App {
    @StateObject private var store = LocalStore()

    var body: some Scene {
        WindowGroup {
            MainTabView()
                .environmentObject(store)
        }
    }
}
