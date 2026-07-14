import ARKit
import Foundation
import UIKit

struct DiagnosticEvent: Identifiable {
    let id = UUID()
    let date: Date
    let scope: String
    let message: String
}

@MainActor
final class BridgeDiagnostics: ObservableObject {
    @Published private(set) var events: [DiagnosticEvent] = []

    private let maxEvents = 80

    func record(_ message: String, scope: String) {
        events.insert(
            DiagnosticEvent(date: Date(), scope: scope, message: message),
            at: 0
        )
        if events.count > maxEvents {
            events.removeLast(events.count - maxEvents)
        }
    }

    func clear() {
        events.removeAll()
    }

    func makeReport(store: LocalStore) -> String {
        let worldMaps = worldMapDiagnostics(store: store)
        let missingWorldMaps = worldMaps.filter { !$0.exists }
        let device = UIDevice.current
        let appVersion = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "unknown"
        let buildNumber = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "unknown"

        var lines: [String] = []
        lines.append("Bridge diagnostics")
        lines.append("Generated: \(Date().formatted(date: .numeric, time: .standard))")
        lines.append("")
        lines.append("App")
        lines.append("- Version: \(appVersion) (\(buildNumber))")
        lines.append("")
        lines.append("Device")
        lines.append("- Model: \(device.model)")
        lines.append("- System: \(device.systemName) \(device.systemVersion)")
        lines.append("- WorldTracking supported: \(ARWorldTrackingConfiguration.isSupported)")
        lines.append("- BodyTracking supported: \(ARBodyTrackingConfiguration.isSupported)")
        lines.append("")
        lines.append("Local data")
        lines.append("- Avatars: \(store.avatars.count)")
        lines.append("- Placements: \(store.placements.count)")
        lines.append("- Comments: \(store.comments.count)")
        lines.append("- WorldMap references: \(worldMaps.count)")
        lines.append("- Missing WorldMaps: \(missingWorldMaps.count)")
        if let summary = store.lastMaintenanceSummary {
            lines.append("- Last maintenance: \(summary)")
        }

        if !worldMaps.isEmpty {
            lines.append("")
            lines.append("WorldMaps")
            worldMaps.forEach { item in
                let size = item.sizeBytes.map { "\($0) bytes" } ?? "missing"
                let modified = item.modifiedAt?.formatted(date: .numeric, time: .standard) ?? "n/a"
                lines.append("- \(item.filename): \(size), modified \(modified)")
            }
        }

        if !events.isEmpty {
            lines.append("")
            lines.append("Recent events")
            events.forEach { event in
                lines.append("- \(event.date.formatted(date: .omitted, time: .standard)) [\(event.scope)] \(event.message)")
            }
        }

        return lines.joined(separator: "\n")
    }

    func worldMapDiagnostics(store: LocalStore) -> [WorldMapDiagnostic] {
        let filenames = Set(store.placements.map(\.anchor.worldMapFilename))
        return filenames.sorted().map { filename in
            let url = worldMapsDirectory.appendingPathComponent(filename)
            let values = try? url.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey])
            return WorldMapDiagnostic(
                filename: filename,
                exists: FileManager.default.fileExists(atPath: url.path),
                sizeBytes: values?.fileSize,
                modifiedAt: values?.contentModificationDate
            )
        }
    }

    private var worldMapsDirectory: URL {
        let base = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        return base.appendingPathComponent("WorldMaps", isDirectory: true)
    }
}

struct WorldMapDiagnostic: Identifiable {
    var id: String { filename }
    let filename: String
    let exists: Bool
    let sizeBytes: Int?
    let modifiedAt: Date?
}
