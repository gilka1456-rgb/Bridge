import ARKit
import Foundation

enum AnchorPersistenceError: LocalizedError {
    case worldMapUnavailable
    case writeFailed

    var errorDescription: String? {
        switch self {
        case .worldMapUnavailable:
            return "当前环境尚未完成 AR 定位，请缓慢移动手机扫描周围空间。"
        case .writeFailed:
            return "无法保存 AR 锚点数据。"
        }
    }
}

enum WorldMapDeleteResult: Hashable {
    case deleted(String)
    case missing(String)
    case failed(String, String)
}

struct AnchorPersistence {
    private static var worldMapsDirectory: URL {
        let base = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let dir = base.appendingPathComponent("WorldMaps", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    static func persistWorldMap(from session: ARSession) async throws -> String {
        guard let frame = session.currentFrame else {
            throw AnchorPersistenceError.worldMapUnavailable
        }

        let worldMap = try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<ARWorldMap, Error>) in
            session.getCurrentWorldMap { worldMap, error in
                if let error {
                    continuation.resume(throwing: error)
                } else if let worldMap {
                    continuation.resume(returning: worldMap)
                } else {
                    continuation.resume(throwing: AnchorPersistenceError.worldMapUnavailable)
                }
            }
        }

        guard isPersistableMappingStatus(frame.worldMappingStatus), !worldMap.anchors.isEmpty else {
            throw AnchorPersistenceError.worldMapUnavailable
        }

        let filename = "\(UUID().uuidString).worldmap"
        let url = worldMapsDirectory.appendingPathComponent(filename)
        let data = try NSKeyedArchiver.archivedData(withRootObject: worldMap, requiringSecureCoding: true)
        try data.write(to: url, options: .atomic)
        return filename
    }

    static func loadWorldMap(named filename: String) throws -> ARWorldMap {
        let url = worldMapsDirectory.appendingPathComponent(filename)
        let data = try Data(contentsOf: url)
        guard let worldMap = try NSKeyedUnarchiver.unarchivedObject(ofClass: ARWorldMap.self, from: data) else {
            throw AnchorPersistenceError.writeFailed
        }
        return worldMap
    }

    static func worldMapExists(named filename: String) -> Bool {
        let url = worldMapsDirectory.appendingPathComponent(filename)
        return FileManager.default.fileExists(atPath: url.path)
    }

    static func deleteWorldMap(named filename: String) -> WorldMapDeleteResult {
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
}
