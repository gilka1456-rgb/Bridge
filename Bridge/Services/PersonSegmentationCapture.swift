import CoreVideo
import Vision

enum PersonSegmentationCapture {
    struct CaptureResult {
        let capture: SegmentationCapture?
        let failureReason: String?
    }

    static func capture(from pixelBuffer: CVPixelBuffer) -> SegmentationCapture? {
        captureResult(from: pixelBuffer).capture
    }

    static func captureResult(from pixelBuffer: CVPixelBuffer) -> CaptureResult {
        let request = VNGeneratePersonSegmentationRequest()
        request.qualityLevel = .balanced
        request.outputPixelFormat = kCVPixelFormatType_OneComponent8

        let handler = VNImageRequestHandler(cvPixelBuffer: pixelBuffer, options: [:])
        do {
            try handler.perform([request])
        } catch {
            return CaptureResult(capture: nil, failureReason: "vision-error(\(error.localizedDescription))")
        }

        guard let observation = request.results?.first as? VNPixelBufferObservation else {
            return CaptureResult(capture: nil, failureReason: "vision-empty-result")
        }

        return extractCaptureResult(from: observation.pixelBuffer)
    }

    private static func extractCaptureResult(from pixelBuffer: CVPixelBuffer) -> CaptureResult {
        CVPixelBufferLockBaseAddress(pixelBuffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, .readOnly) }

        guard let baseAddress = CVPixelBufferGetBaseAddress(pixelBuffer) else {
            return CaptureResult(capture: nil, failureReason: "pixel-buffer-missing-base-address")
        }

        let width = CVPixelBufferGetWidth(pixelBuffer)
        let height = CVPixelBufferGetHeight(pixelBuffer)
        let bytesPerRow = CVPixelBufferGetBytesPerRow(pixelBuffer)
        guard width > 2, height > 2, bytesPerRow >= width else {
            return CaptureResult(capture: nil, failureReason: "invalid-mask-buffer(\(width)x\(height),row=\(bytesPerRow))")
        }
        let pointer = baseAddress.assumingMemoryBound(to: UInt8.self)

        func isPerson(_ x: Int, _ y: Int) -> Bool {
            pointer[y * bytesPerRow + x] > 128
        }

        var contour: [SilhouettePoint] = []
        outer: for y in 1..<(height - 1) {
            for x in 1..<(width - 1) where isPerson(x, y) && !isPerson(x, y - 1) {
                contour = traceContour(
                    pointer: pointer,
                    width: width,
                    height: height,
                    bytesPerRow: bytesPerRow,
                    startX: x,
                    startY: y,
                    isPerson: isPerson
                )
                break outer
            }
        }

        guard contour.count >= 12 else {
            return CaptureResult(capture: nil, failureReason: "contour-too-small(\(contour.count))")
        }

        let simplified = downsample(contour, stride: max(1, contour.count / 64))
        let bodyProfile = computeBodyProfile(
            pointer: pointer,
            width: width,
            height: height,
            bytesPerRow: bytesPerRow,
            isPerson: isPerson
        )

        var binaryMask = [UInt8]()
        binaryMask.reserveCapacity(width * height)
        for y in 0..<height {
            for x in 0..<width {
                binaryMask.append(isPerson(x, y) ? 1 : 0)
            }
        }

        return CaptureResult(
            capture: SegmentationCapture(
                contour: simplified,
                bodyProfile: bodyProfile,
                binaryMask: binaryMask,
                maskWidth: width,
                maskHeight: height
            ),
            failureReason: nil
        )
    }

    private static func traceContour(
        pointer: UnsafePointer<UInt8>,
        width: Int,
        height: Int,
        bytesPerRow: Int,
        startX: Int,
        startY: Int,
        isPerson: (Int, Int) -> Bool
    ) -> [SilhouettePoint] {
        let directions = [(1, 0), (1, 1), (0, 1), (-1, 1), (-1, 0), (-1, -1), (0, -1), (1, -1)]
        var points: [SilhouettePoint] = []
        var x = startX
        var y = startY
        var dir = 0
        let maxSteps = width * height * 2
        var steps = 0

        repeat {
            points.append(SilhouettePoint(x: Float(x) / Float(width), y: Float(y) / Float(height)))
            var found = false
            for offset in 0..<8 {
                let checkDir = (dir + offset + 5) % 8
                let nx = x + directions[checkDir].0
                let ny = y + directions[checkDir].1
                if nx >= 0, nx < width, ny >= 0, ny < height, isPerson(nx, ny) {
                    x = nx
                    y = ny
                    dir = checkDir
                    found = true
                    break
                }
            }
            if !found { break }
            steps += 1
        } while (x != startX || y != startY || points.count < 3) && steps < maxSteps

        return points
    }

    private static func downsample(_ points: [SilhouettePoint], stride: Int) -> [SilhouettePoint] {
        guard stride > 1 else { return points }
        return points.enumerated().compactMap { index, point in
            index % stride == 0 ? point : nil
        }
    }

    private static func computeBodyProfile(
        pointer: UnsafePointer<UInt8>,
        width: Int,
        height: Int,
        bytesPerRow: Int,
        isPerson: (Int, Int) -> Bool
    ) -> [BodyProfileSlice] {
        let rows = 24
        var slices: [BodyProfileSlice] = []
        for row in 0..<rows {
            let y = Int((Float(row) / Float(rows - 1)) * Float(height - 1))
            var minX = width
            var maxX = -1
            for x in 0..<width where isPerson(x, y) {
                minX = min(minX, x)
                maxX = max(maxX, x)
            }
            if maxX >= minX {
                slices.append(
                    BodyProfileSlice(
                        y: Float(y) / Float(height),
                        halfWidth: Float(maxX - minX) / 2 / Float(width)
                    )
                )
            }
        }
        return slices
    }
}
