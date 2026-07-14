import Foundation

/// 单个朝向的全高人体分割二值 mask（视觉外壳重建输入）。
struct OrientationMask: Codable, Hashable, Identifiable {
    var id: Int { azimuth }

    /// 方位角：正 0 / 右 90 / 背 180 / 左 270
    let azimuth: Int
    let width: Int
    let height: Int
    /// base64(RLE) 编码的逐像素 0/1 人体掩码
    let mask: String
}

enum OrientationAzimuth {
    static let mapping: [ScanViewAngle: Int] = [
        .front: 0,
        .right: 90,
        .back: 180,
        .left: 270
    ]

    static func azimuth(for angle: ScanViewAngle) -> Int? {
        mapping[angle]
    }
}
