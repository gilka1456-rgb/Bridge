import Foundation

/// 行程编码(RLE) + base64，与 web `encodePersonMaskRLE` 格式一致；runs 以 0 值段起始。
enum PersonMaskRLE {
    static func encode(_ mask: [UInt8]) -> String {
        var runs: [UInt32] = []
        var current: UInt8 = 0
        var count: UInt32 = 0

        for value in mask {
            let bit: UInt8 = value > 0 ? 1 : 0
            if bit == current {
                count += 1
            } else {
                runs.append(count)
                current = bit
                count = 1
            }
        }
        runs.append(count)

        var data = Data()
        data.reserveCapacity(runs.count * 4)
        for run in runs {
            var littleEndian = run.littleEndian
            withUnsafeBytes(of: &littleEndian) { data.append(contentsOf: $0) }
        }
        return data.base64EncodedString()
    }

    static func decode(_ encoded: String, length: Int) -> [UInt8] {
        guard let data = Data(base64Encoded: encoded), !data.isEmpty else { return [] }

        let runs = decodeRuns(from: data)
        guard !runs.isEmpty else { return [] }

        var mask = [UInt8](repeating: 0, count: length)
        var writeIndex = 0
        var value: UInt8 = 0
        for run in runs {
            if value == 1 {
                let end = min(writeIndex + Int(run), length)
                for index in writeIndex..<end {
                    mask[index] = 1
                }
            }
            writeIndex += Int(run)
            value ^= 1
        }
        return mask
    }

    static func decodedRunTotal(_ encoded: String) -> Int? {
        guard let data = Data(base64Encoded: encoded), !data.isEmpty else { return nil }
        let runs = decodeRuns(from: data)
        guard !runs.isEmpty else { return nil }
        return runs.reduce(0) { partial, run in
            partial + Int(run)
        }
    }

    private static func decodeRuns(from data: Data) -> [UInt32] {
        guard data.count % 4 == 0 else { return [] }
        let runCount = data.count / 4
        var runs = [UInt32]()
        runs.reserveCapacity(runCount)
        data.withUnsafeBytes { raw in
            for index in 0..<runCount {
                let offset = index * 4
                runs.append(raw.load(fromByteOffset: offset, as: UInt32.self).littleEndian)
            }
        }
        return runs
    }
}
