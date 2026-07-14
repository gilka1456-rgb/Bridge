import Foundation

struct SilhouettePoint: Codable, Hashable {
    var x: Float
    var y: Float
}

struct BodyProfileSlice: Codable, Hashable {
    var y: Float
    var halfWidth: Float
}

struct SegmentationCapture: Hashable {
    let contour: [SilhouettePoint]
    let bodyProfile: [BodyProfileSlice]
    /// 逐像素 0/1 人体掩码，行优先
    let binaryMask: [UInt8]
    let maskWidth: Int
    let maskHeight: Int
}
