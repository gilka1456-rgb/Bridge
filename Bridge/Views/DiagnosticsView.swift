import ARKit
import SwiftUI
import UIKit

struct DiagnosticsView: View {
    @EnvironmentObject private var store: LocalStore
    @EnvironmentObject private var diagnostics: BridgeDiagnostics

    var body: some View {
        NavigationStack {
            List {
                Section("设备") {
                    diagnosticRow("系统", "\(UIDevice.current.systemName) \(UIDevice.current.systemVersion)")
                    diagnosticRow("World Tracking", ARWorldTrackingConfiguration.isSupported ? "支持" : "不支持")
                    diagnosticRow("Body Tracking", ARBodyTrackingConfiguration.isSupported ? "支持" : "不支持")
                }

                Section("本地数据") {
                    diagnosticRow("虚像", "\(store.avatars.count)")
                    diagnosticRow("放置", "\(store.placements.count)")
                    diagnosticRow("评论", "\(store.comments.count)")
                    diagnosticRow("WorldMap", "\(worldMapDiagnostics.count)")
                    diagnosticRow("缺失 WorldMap", "\(missingWorldMapCount)")
                }

                if !worldMapDiagnostics.isEmpty {
                    Section("WorldMap 文件") {
                        Text(worldMapSummary)
                            .font(.caption)
                            .textSelection(.enabled)
                    }
                }

                Section("最近事件") {
                    if diagnostics.events.isEmpty {
                        Text("还没有记录到 AR 事件。")
                            .foregroundStyle(.secondary)
                    } else {
                        Text(eventSummary)
                            .font(.caption)
                            .textSelection(.enabled)
                    }

                    Button("清空事件") {
                        diagnostics.clear()
                    }
                    .disabled(diagnostics.events.isEmpty)
                }

                Section {
                    ShareLink("导出诊断报告", item: diagnostics.makeReport(store: store))
                } footer: {
                    Text("真机测试失败时，先导出这份报告，再附上 Xcode 日志、截图或录屏。")
                }
            }
            .navigationTitle("诊断")
        }
    }

    private var worldMapDiagnostics: [WorldMapDiagnostic] {
        diagnostics.worldMapDiagnostics(store: store)
    }

    private var missingWorldMapCount: Int {
        worldMapDiagnostics.filter { !$0.exists }.count
    }

    private var worldMapSummary: String {
        worldMapDiagnostics
            .map { "\($0.filename)\n\(worldMapDescription($0))" }
            .joined(separator: "\n\n")
    }

    private var eventSummary: String {
        diagnostics.events
            .map { "\($0.date.formatted(date: .omitted, time: .standard)) [\($0.scope)] \($0.message)" }
            .joined(separator: "\n")
    }

    private func diagnosticRow(_ title: String, _ value: String) -> some View {
        HStack {
            Text(title)
            Spacer()
            Text(value)
                .foregroundStyle(.secondary)
        }
    }

    private func worldMapDescription(_ item: WorldMapDiagnostic) -> String {
        guard item.exists else { return "文件缺失，重定位一定会失败" }
        let size = item.sizeBytes.map { "\($0) bytes" } ?? "大小未知"
        let modified = item.modifiedAt?.formatted(date: .abbreviated, time: .shortened) ?? "时间未知"
        return "\(size)，\(modified)"
    }
}
