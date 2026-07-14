import SwiftUI

@main
struct BridgeApp: App {
    @StateObject private var store = LocalStore()
    @StateObject private var diagnostics = BridgeDiagnostics()

    var body: some Scene {
        WindowGroup {
            MainTabView()
                .environmentObject(store)
                .environmentObject(diagnostics)
        }
    }
}
