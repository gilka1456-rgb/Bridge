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
                    if let loadSummary = store.lastLoadSummary {
                        Text(loadSummary)
                            .font(.caption)
                            .foregroundStyle(.red)
                            .textSelection(.enabled)
                    }
                    if let summary = store.lastMaintenanceSummary {
                        Text(summary)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                    }
                }

                if !worldMapDiagnostics.isEmpty {
                    Section("WorldMap 文件") {
                        Text(worldMapSummary)
                            .font(.caption)
                            .textSelection(.enabled)
                    }
                }

                if !store.avatars.isEmpty {
                    Section("虚像数据") {
                        Text(avatarSummary)
                            .font(.caption)
                            .textSelection(.enabled)
                    }
                }

                if !store.placements.isEmpty {
                    Section("放置引用") {
                        Text(placementSummary)
                            .font(.caption)
                            .textSelection(.enabled)
                    }
                }

                Section {
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
                } header: {
                    Text("最近事件")
                } footer: {
                    Text("最多保留最近 200 条事件，完整真机流程结束后先导出报告再清空。")
                }

                Section {
                    Button("清理无效放置") {
                        let summary = store.purgeInvalidPlacements()
                        diagnostics.record(summary, scope: "Diagnostics")
                    }
                    .disabled(invalidPlacementCount == 0)
                } header: {
                    Text("维护")
                } footer: {
                    Text("只会删除缺失虚像或缺失 WorldMap 的放置，并清理相关评论。正常可重定位的放置不会被改动。")
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

    private var placementSummary: String {
        store.placements
            .map { placement in
                let avatarState = store.avatar(for: placement.avatarPoseID) == nil ? "虚像缺失" : "虚像存在"
                let worldMapState = AnchorPersistence.worldMapExists(named: placement.anchor.worldMapFilename) ? "WorldMap 存在" : "WorldMap 缺失"
                let heading = placement.anchor.headingDegrees.map { "\(Int($0))°" } ?? "朝向未知"
                let latitude = placement.anchor.latitude.map { String(format: "%.6f", $0) } ?? "纬度未知"
                let longitude = placement.anchor.longitude.map { String(format: "%.6f", $0) } ?? "经度未知"
                return "\(placement.id.uuidString)\n\(avatarState)，\(worldMapState)，\(heading)\n\(latitude), \(longitude)\n\(placement.anchor.worldMapFilename)\nanchor \(placement.anchor.anchorIdentifier.uuidString)\n\(Self.preview(placement.message))"
            }
            .joined(separator: "\n\n")
    }

    private var avatarSummary: String {
        store.avatars
            .map { avatar in
                let angles = avatar.views.map { $0.angle.displayName }.joined(separator: "、")
                let maskCount = avatar.orientations?.count ?? 0
                return "\(avatar.id.uuidString)\n\(avatar.label)，\(avatar.style.displayName)\n方位 \(avatar.views.count)，mask \(maskCount)，关节 \(avatar.joints.count)\n\(angles.isEmpty ? "方位未知" : angles)"
            }
            .joined(separator: "\n\n")
    }

    private var invalidPlacementCount: Int {
        store.placements.filter { placement in
            store.avatar(for: placement.avatarPoseID) == nil
                || !AnchorPersistence.worldMapExists(named: placement.anchor.worldMapFilename)
        }.count
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
        let anchorCount = item.anchorCount.map { "\($0) anchors" } ?? "anchor 数未知"
        let decodeState = item.decodeError.map { "解码失败：\($0)" } ?? "解码正常"
        let modified = item.modifiedAt?.formatted(date: .abbreviated, time: .shortened) ?? "时间未知"
        return "\(size)，\(anchorCount)，\(decodeState)，\(modified)"
    }

    private static func preview(_ text: String) -> String {
        let singleLine = text
            .replacingOccurrences(of: "\n", with: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if singleLine.count <= 50 {
            return singleLine
        }
        return "\(singleLine.prefix(50))..."
    }
}
