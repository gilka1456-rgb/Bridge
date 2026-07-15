import ARKit
import Foundation

enum AnchorPersistenceError: LocalizedError {
    case worldMapUnavailable(mappingStatus: String, anchorCount: Int)
    case anchorMissingFromWorldMap(anchorIdentifier: UUID, anchorCount: Int)
    case invalidWorldMapFilename
    case writeFailed

    var errorDescription: String? {
        switch self {
        case .worldMapUnavailable(let mappingStatus, let anchorCount):
            return "当前环境尚未完成 AR 定位，请缓慢移动手机扫描周围空间。mapping=\(mappingStatus)，anchors=\(anchorCount)"
        case .anchorMissingFromWorldMap(let anchorIdentifier, let anchorCount):
            return "当前锚点还没有写入空间地图，请继续缓慢环视后再保存。anchor=\(anchorIdentifier.uuidString)，anchors=\(anchorCount)"
        case .invalidWorldMapFilename:
            return "AR 空间地图文件名无效。"
        case .writeFailed:
            return "无法保存 AR 锚点数据。"
        }
    }
}

enum WorldMapDeleteResult: Hashable {
    case deleted(String)
    case missing(String)
    case failed(String, String)

    var diagnosticDescription: String {
        switch self {
        case .deleted(let filename):
            return "deleted=\(filename)"
        case .missing(let filename):
            return "missing=\(filename)"
        case .failed(let filename, let message):
            return "failed=\(filename):\(message)"
        }
    }
}

struct PersistedWorldMapInfo: Hashable {
    let filename: String
    let anchorCount: Int
    let fileSizeBytes: Int
}

struct AnchorPersistence {
    private static var worldMapsDirectory: URL {
        let base = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let dir = base.appendingPathComponent("WorldMaps", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    static func persistWorldMap(from session: ARSession, requiringAnchor anchorIdentifier: UUID? = nil) async throws -> String {
        try await persistWorldMapInfo(from: session, requiringAnchor: anchorIdentifier).filename
    }

    static func persistWorldMapInfo(from session: ARSession, requiringAnchor anchorIdentifier: UUID? = nil) async throws -> PersistedWorldMapInfo {
        guard let frame = session.currentFrame else {
            throw AnchorPersistenceError.worldMapUnavailable(mappingStatus: "no-current-frame", anchorCount: 0)
        }
        let mappingStatusName = mappingStatusDescription(frame.worldMappingStatus)

        let worldMap = try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<ARWorldMap, Error>) in
            session.getCurrentWorldMap { worldMap, error in
                if let error {
                    continuation.resume(throwing: error)
                } else if let worldMap {
                    continuation.resume(returning: worldMap)
                } else {
                    continuation.resume(
                        throwing: AnchorPersistenceError.worldMapUnavailable(
                            mappingStatus: mappingStatusName,
                            anchorCount: 0
                        )
                    )
                }
            }
        }

        guard isPersistableMappingStatus(frame.worldMappingStatus), !worldMap.anchors.isEmpty else {
            throw AnchorPersistenceError.worldMapUnavailable(
                mappingStatus: mappingStatusName,
                anchorCount: worldMap.anchors.count
            )
        }

        if let anchorIdentifier, !worldMap.anchors.contains(where: { $0.identifier == anchorIdentifier }) {
            throw AnchorPersistenceError.anchorMissingFromWorldMap(
                anchorIdentifier: anchorIdentifier,
                anchorCount: worldMap.anchors.count
            )
        }

        let filename = "\(UUID().uuidString).worldmap"
        let url = worldMapsDirectory.appendingPathComponent(filename)
        let data = try NSKeyedArchiver.archivedData(withRootObject: worldMap, requiringSecureCoding: true)
        try data.write(to: url, options: .atomic)
        return PersistedWorldMapInfo(
            filename: filename,
            anchorCount: worldMap.anchors.count,
            fileSizeBytes: data.count
        )
    }

    static func loadWorldMap(named filename: String) throws -> ARWorldMap {
        guard isValidWorldMapFilename(filename) else {
            throw AnchorPersistenceError.invalidWorldMapFilename
        }
        let url = worldMapsDirectory.appendingPathComponent(filename)
        let data = try Data(contentsOf: url)
        guard let worldMap = try NSKeyedUnarchiver.unarchivedObject(ofClass: ARWorldMap.self, from: data) else {
            throw AnchorPersistenceError.writeFailed
        }
        return worldMap
    }

    static func worldMapExists(named filename: String) -> Bool {
        guard isValidWorldMapFilename(filename) else { return false }
        let url = worldMapsDirectory.appendingPathComponent(filename)
        return FileManager.default.fileExists(atPath: url.path)
    }

    static func storedWorldMapFilenames() -> [String] {
        guard let urls = try? FileManager.default.contentsOfDirectory(
            at: worldMapsDirectory,
            includingPropertiesForKeys: nil,
            options: [.skipsHiddenFiles]
        ) else {
            return []
        }
        return urls
            .map(\.lastPathComponent)
            .filter { $0.hasSuffix(".worldmap") }
            .sorted()
    }

    static func deleteWorldMap(named filename: String) -> WorldMapDeleteResult {
        guard isValidWorldMapFilename(filename) else {
            return .failed(filename, AnchorPersistenceError.invalidWorldMapFilename.localizedDescription)
        }
        let url = worldMapsDirectory.appendingPathComponent(filename)
        guard FileManager.default.fileExists(atPath: url.path) else {
            return .missing(filename)
        }
        do {
            try FileManager.default.removeItem(at: url)
            return .deleted(filename)
        } catch {
            return .failed(filename, error.localizedDescription)
        }
    }

    static func isValidWorldMapFilename(_ filename: String) -> Bool {
        guard filename.hasSuffix(".worldmap") else { return false }
        guard !filename.isEmpty, filename == URL(fileURLWithPath: filename).lastPathComponent else { return false }
        return UUID(uuidString: String(filename.dropLast(".worldmap".count))) != nil
    }

    static func serializeTransform(_ transform: simd_float4x4) -> [Float] {
        [
            transform.columns.0.x, transform.columns.0.y, transform.columns.0.z, transform.columns.0.w,
            transform.columns.1.x, transform.columns.1.y, transform.columns.1.z, transform.columns.1.w,
            transform.columns.2.x, transform.columns.2.y, transform.columns.2.z, transform.columns.2.w,
            transform.columns.3.x, transform.columns.3.y, transform.columns.3.z, transform.columns.3.w
        ]
    }

    static func deserializeTransform(_ values: [Float]) -> simd_float4x4 {
        guard values.count == 16 else {
            return matrix_identity_float4x4
        }

        return simd_float4x4(
            SIMD4(values[0], values[1], values[2], values[3]),
            SIMD4(values[4], values[5], values[6], values[7]),
            SIMD4(values[8], values[9], values[10], values[11]),
            SIMD4(values[12], values[13], values[14], values[15])
        )
    }

    static func isPersistableMappingStatus(_ status: ARFrame.WorldMappingStatus) -> Bool {
        switch status {
        case .mapped, .extending:
            return true
        case .notAvailable, .limited:
            return false
        @unknown default:
            return false
        }
    }

    static func mappingStatusDescription(_ status: ARFrame.WorldMappingStatus) -> String {
        switch status {
        case .notAvailable:
            return "notAvailable"
        case .limited:
            return "limited"
        case .extending:
            return "extending"
        case .mapped:
            return "mapped"
        @unknown default:
            return "unknown"
        }
    }
}
