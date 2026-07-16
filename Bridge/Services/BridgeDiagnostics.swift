import ARKit
import Foundation
import UIKit

struct DiagnosticEvent: Codable, Identifiable {
    let id: UUID
    let date: Date
    let scope: String
    let message: String

    init(id: UUID = UUID(), date: Date, scope: String, message: String) {
        self.id = id
        self.date = date
        self.scope = scope
        self.message = message
    }
}

@MainActor
final class BridgeDiagnostics: ObservableObject {
    @Published private(set) var events: [DiagnosticEvent] = []
    @Published private(set) var lastPersistenceWarning: String?

    private static let maxPersistedEvents = 200
    private let eventsURL: URL

    init() {
        let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        eventsURL = documents.appendingPathComponent("bridge_diagnostics_events.json")
        events = Self.loadEvents(from: eventsURL)
    }

    func record(_ message: String, scope: String) {
        events.insert(
            DiagnosticEvent(date: Date(), scope: scope, message: message),
            at: 0
        )
        if events.count > Self.maxPersistedEvents {
            events.removeLast(events.count - Self.maxPersistedEvents)
        }
        persistEvents()
    }

    func clear() {
        events.removeAll()
        persistEvents()
    }

    func makeReport(store: LocalStore) -> String {
        let worldMaps = worldMapDiagnostics(store: store)
        let referencedWorldMaps = worldMaps.filter(\.isReferenced)
        let storedWorldMaps = worldMaps.filter(\.exists)
        let missingWorldMaps = worldMaps.filter { $0.validFilename && !$0.exists }
        let invalidWorldMaps = worldMaps.filter { !$0.validFilename }
        let unreferencedWorldMaps = worldMaps.filter { $0.exists && !$0.isReferenced }
        let worldMapsByFilename = Dictionary(uniqueKeysWithValues: worldMaps.map { ($0.filename, $0) })
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
        lines.append("- Comment integrity: \(store.commentIntegritySummary)")
        lines.append("- WorldMap references: \(referencedWorldMaps.count)")
        lines.append("- Stored WorldMap files: \(storedWorldMaps.count)")
        lines.append("- Missing WorldMaps: \(missingWorldMaps.count)")
        lines.append("- Invalid WorldMap filenames: \(invalidWorldMaps.count)")
        lines.append("- Unreferenced WorldMaps: \(unreferencedWorldMaps.count)")
        if let loadSummary = store.lastLoadSummary {
            lines.append("- Last load warning: \(loadSummary)")
        }
        if let saveSummary = store.lastSaveSummary {
            lines.append("- Last save warning: \(saveSummary)")
        }
        if let summary = store.lastMaintenanceSummary {
            lines.append("- Last maintenance: \(summary)")
        }
        if let warning = lastPersistenceWarning {
            lines.append("- Diagnostic persistence warning: \(warning)")
        }

        if !worldMaps.isEmpty {
            lines.append("")
            lines.append("WorldMaps")
            worldMaps.forEach { item in
                let size = item.sizeBytes.map { "\($0) bytes" } ?? "missing"
                let modified = item.modifiedAt?.formatted(date: .numeric, time: .standard) ?? "n/a"
                let anchorCount = item.anchorCount.map { "\($0) anchors" } ?? "anchors n/a"
                let anchorIDs = Self.anchorIdentifierSummary(item.anchorIdentifiers)
                let filenameState = item.validFilename ? "filename ok" : "filename invalid"
                let referenceState = item.isReferenced ? "referenced" : "unreferenced"
                let decodeState = item.decodeError.map { "decode failed: \($0)" } ?? "decode ok"
                lines.append("- \(item.filename): \(filenameState), \(referenceState), \(size), \(anchorCount), anchors \(anchorIDs), \(decodeState), modified \(modified)")
            }
        }

        if !store.avatars.isEmpty {
            lines.append("")
            lines.append("Avatars")
            store.avatars.forEach { avatar in
                let angles = avatar.views.map { $0.angle.displayName }.joined(separator: ", ")
                let maskCount = avatar.orientations?.count ?? 0
                let validMasks = avatar.orientations?.filter(\.hasValidMaskData).count ?? 0
                let invalidMasks = avatar.orientations?.filter { !$0.hasValidMaskData }.count ?? 0
                let hullState = validMasks >= 2 ? "visualHullCandidate" : "fallbackSkeleton"
                let maskStates = avatar.orientations?
                    .map { "\($0.azimuth):\($0.validationSummary)" }
                    .joined(separator: ", ") ?? "none"
                let invalidJointTransforms = avatar.joints.filter { !$0.hasValidTransform }.count
                lines.append("- \(avatar.id.uuidString)")
                lines.append("  label: \(avatar.label)")
                lines.append("  style: \(avatar.style.displayName)")
                lines.append("  views: \(avatar.views.count), masks: \(maskCount), validMasks: \(validMasks), invalidMasks: \(invalidMasks), hull: \(hullState), angles: \(angles.isEmpty ? "none" : angles)")
                lines.append("  maskStates: \(maskStates)")
                lines.append("  joints: \(avatar.joints.count), invalidTransforms: \(invalidJointTransforms)")
            }
        }

        if !store.placements.isEmpty {
            lines.append("")
            lines.append("Placements")
            store.placements.forEach { placement in
                let avatarState = store.avatar(for: placement.avatarPoseID) == nil ? "missing" : "ok"
                let worldMapState = Self.worldMapState(named: placement.anchor.worldMapFilename)
                let anchorInWorldMapState = Self.anchorInWorldMapState(
                    placement.anchor.anchorIdentifier,
                    worldMap: worldMapsByFilename[placement.anchor.worldMapFilename]
                )
                let latitude = placement.anchor.latitude.map { String(format: "%.6f", $0) } ?? "n/a"
                let longitude = placement.anchor.longitude.map { String(format: "%.6f", $0) } ?? "n/a"
                let heading = placement.anchor.headingDegrees.map { "\(Int($0)) deg" } ?? "n/a"
                let transformState = placement.anchor.hasValidTransform ? "ok" : "invalid(\(placement.anchor.transform.count))"
                lines.append("- \(placement.id.uuidString)")
                lines.append("  avatar: \(placement.avatarPoseID.uuidString) (\(avatarState))")
                lines.append("  worldMap: \(placement.anchor.worldMapFilename) (\(worldMapState))")
                lines.append("  anchorIdentifier: \(placement.anchor.anchorIdentifier.uuidString)")
                lines.append("  anchorInWorldMap: \(anchorInWorldMapState)")
                lines.append("  transform: \(transformState)")
                lines.append("  location: \(latitude), \(longitude), heading \(heading)")
                lines.append("  message: \(Self.preview(placement.message))")
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
        let referencedFilenames = Set(store.placements.map(\.anchor.worldMapFilename))
        let filenames = referencedFilenames.union(AnchorPersistence.storedWorldMapFilenames())
        return filenames.sorted().map { filename in
            let validFilename = AnchorPersistence.isValidWorldMapFilename(filename)
            let url = validFilename ? worldMapsDirectory.appendingPathComponent(filename) : nil
            let exists = validFilename && AnchorPersistence.worldMapExists(named: filename)
            let values: URLResourceValues?
            if let url {
                values = try? url.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey])
            } else {
                values = nil
            }
            let decodedWorldMap = exists ? Result { try AnchorPersistence.loadWorldMap(named: filename) } : nil
            return WorldMapDiagnostic(
                filename: filename,
                isReferenced: referencedFilenames.contains(filename),
                validFilename: validFilename,
                exists: exists,
                sizeBytes: values?.fileSize,
                modifiedAt: values?.contentModificationDate,
                anchorCount: decodedWorldMap?.anchorCount,
                anchorIdentifiers: decodedWorldMap?.anchorIdentifiers,
                decodeError: validFilename ? decodedWorldMap?.decodeError : AnchorPersistenceError.invalidWorldMapFilename.localizedDescription
            )
        }
    }

    private var worldMapsDirectory: URL {
        let base = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        return base.appendingPathComponent("WorldMaps", isDirectory: true)
    }

    private static func loadEvents(from url: URL) -> [DiagnosticEvent] {
        guard FileManager.default.fileExists(atPath: url.path),
              let data = try? Data(contentsOf: url),
              let decoded = try? JSONDecoder().decode([DiagnosticEvent].self, from: data) else {
            return []
        }
        return Array(decoded.prefix(maxPersistedEvents))
    }

    private func persistEvents() {
        do {
            let data = try JSONEncoder().encode(events)
            try data.write(to: eventsURL, options: .atomic)
            lastPersistenceWarning = nil
        } catch {
            lastPersistenceWarning = "诊断日志写入失败：\(error.localizedDescription)"
        }
    }

    private static func preview(_ text: String) -> String {
        let singleLine = text
            .replacingOccurrences(of: "\n", with: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if singleLine.count <= 80 {
            return singleLine
        }
        return "\(singleLine.prefix(80))..."
    }

    private static func worldMapState(named filename: String) -> String {
        guard AnchorPersistence.isValidWorldMapFilename(filename) else { return "filename invalid" }
        return AnchorPersistence.worldMapExists(named: filename) ? "ok" : "missing"
    }

    private static func anchorIdentifierSummary(_ identifiers: [String]?) -> String {
        guard let identifiers else { return "n/a" }
        guard !identifiers.isEmpty else { return "none" }
        let sample = identifiers.prefix(3).map { String($0.prefix(8)) }.joined(separator: ",")
        if identifiers.count <= 3 {
            return sample
        }
        return "\(sample)+\(identifiers.count - 3)"
    }

    private static func anchorInWorldMapState(_ anchorIdentifier: UUID, worldMap: WorldMapDiagnostic?) -> String {
        guard let worldMap else { return "worldMap diagnostic missing" }
        guard worldMap.validFilename else { return "worldMap filename invalid" }
        guard worldMap.exists else { return "worldMap file missing" }
        guard worldMap.decodeError == nil else { return "worldMap decode failed" }
        guard let anchorIdentifiers = worldMap.anchorIdentifiers else { return "anchors unknown" }
        return anchorIdentifiers.contains(anchorIdentifier.uuidString) ? "yes" : "no"
    }
}

struct WorldMapDiagnostic: Identifiable {
    var id: String { filename }
    let filename: String
    let isReferenced: Bool
    let validFilename: Bool
    let exists: Bool
    let sizeBytes: Int?
    let modifiedAt: Date?
    let anchorCount: Int?
    let anchorIdentifiers: [String]?
    let decodeError: String?
}

private extension Result where Success == ARWorldMap, Failure == Error {
    var anchorCount: Int? {
        guard case .success(let worldMap) = self else { return nil }
        return worldMap.anchors.count
    }

    var anchorIdentifiers: [String]? {
        guard case .success(let worldMap) = self else { return nil }
        return worldMap.anchors.map { $0.identifier.uuidString }.sorted()
    }

    var decodeError: String? {
        guard case .failure(let error) = self else { return nil }
        return error.localizedDescription
    }
}
