import Foundation
import RealityKit

/// 从多朝向人体 mask 雕刻视觉外壳网格，算法与 web `visual-hull.ts` 对齐。
enum VisualHull {
    private static let gridX = 64
    private static let gridY = 128
    private static let gridZ = 64

    private static let boundsX: Float = 0.5
    private static let boundsY: Float = 1
    private static let boundsZ: Float = 0.5

    private struct DecodedView {
        let azimuth: Int
        let width: Int
        let height: Int
        let mask: [UInt8]
    }

    private struct MeshData {
        var positions: [Float]
        var normals: [Float]
        var indices: [Int]
    }

    static func buildMesh(from orientations: [OrientationMask]) -> MeshResource? {
        guard orientations.count >= 2 else { return nil }

        let views = orientations.compactMap { orientation -> DecodedView? in
            guard orientation.hasValidMaskData else { return nil }
            let pixelCount = orientation.width * orientation.height
            guard pixelCount > 0 else { return nil }
            let mask = PersonMaskRLE.decode(orientation.mask, length: pixelCount)
            guard mask.count == pixelCount else { return nil }
            return DecodedView(
                azimuth: orientation.azimuth,
                width: orientation.width,
                height: orientation.height,
                mask: mask
            )
        }
        guard views.count >= 2 else { return nil }

        let field = carveVoxels(views: views)
        guard hasOccupiedVoxels(field) else { return nil }

        var mesh = marchingCubes(field: field)
        guard mesh.indices.count >= 3 else { return nil }

        laplacianSmooth(positions: &mesh.positions, indices: mesh.indices)

        return makeMeshResource(from: mesh)
    }

    // MARK: - Voxel carving

    private static func voxelCenterToWorld(ix: Int, iy: Int, iz: Int) -> SIMD3<Float> {
        let x = ((Float(ix) + 0.5) / Float(gridX)) * 2 * boundsX - boundsX
        let y = ((Float(iy) + 0.5) / Float(gridY)) * 2 * boundsY - boundsY
        let z = ((Float(iz) + 0.5) / Float(gridZ)) * 2 * boundsZ - boundsZ
        return SIMD3(x, y, z)
    }

    private static func gridCornerToWorld(gx: Int, gy: Int, gz: Int) -> SIMD3<Float> {
        let x = (Float(gx) / Float(gridX)) * 2 * boundsX - boundsX
        let y = (Float(gy) / Float(gridY)) * 2 * boundsY - boundsY
        let z = (Float(gz) / Float(gridZ)) * 2 * boundsZ - boundsZ
        return SIMD3(x, y, z)
    }

    private static func projectToMaskUV(x: Float, y: Float, z: Float, azimuth: Int) -> (Float, Float) {
        let angle = ((Int(round(Float(azimuth) / 90)) * 90) % 360 + 360) % 360
        let u: Float
        switch angle {
        case 0: u = x + boundsX
        case 90: u = z + boundsZ
        case 180: u = boundsX - x
        case 270: u = boundsZ - z
        default: u = x + boundsX
        }
        let v = (boundsY - y) / (2 * boundsY)
        return (u, v)
    }

    private static func sampleMask(view: DecodedView, u: Float, v: Float) -> Bool {
        guard u >= 0, u <= 1, v >= 0, v <= 1 else { return false }
        let px = min(view.width - 1, max(0, Int(floor(u * Float(view.width)))))
        let py = min(view.height - 1, max(0, Int(floor(v * Float(view.height)))))
        return view.mask[py * view.width + px] == 1
    }

    private static func carveVoxels(views: [DecodedView]) -> [UInt8] {
        let total = gridX * gridY * gridZ
        var field = [UInt8](repeating: 1, count: total)

        for iz in 0..<gridZ {
            for iy in 0..<gridY {
                for ix in 0..<gridX {
                    let index = ix + iy * gridX + iz * gridX * gridY
                    let center = voxelCenterToWorld(ix: ix, iy: iy, iz: iz)
                    for view in views {
                        let (u, v) = projectToMaskUV(x: center.x, y: center.y, z: center.z, azimuth: view.azimuth)
                        if !sampleMask(view: view, u: u, v: v) {
                            field[index] = 0
                            break
                        }
                    }
                }
            }
        }
        return field
    }

    private static func voxelIndex(ix: Int, iy: Int, iz: Int) -> Int {
        ix + iy * gridX + iz * gridX * gridY
    }

    private static func sampleField(_ field: [UInt8], ix: Int, iy: Int, iz: Int) -> Int {
        guard ix >= 0, iy >= 0, iz >= 0, ix < gridX, iy < gridY, iz < gridZ else { return 0 }
        return Int(field[voxelIndex(ix: ix, iy: iy, iz: iz)])
    }

    private static func hasOccupiedVoxels(_ field: [UInt8]) -> Bool {
        field.contains { $0 > 0 }
    }

    // MARK: - Marching cubes

    private static func marchingCubes(field: [UInt8]) -> MeshData {
        var positions = [Float]()
        var normals = [Float]()
        var indices = [Int]()
        var edgeVertexCache: [String: Int] = [:]
        let iso: Float = 0.5

        func cornerPos(ix: Int, iy: Int, iz: Int, corner: Int) -> SIMD3<Float> {
            let offset = MarchingCubesTables.cornerOffsets[corner]
            return gridCornerToWorld(gx: ix + offset.0, gy: iy + offset.1, gz: iz + offset.2)
        }

        func getEdgeVertex(ix: Int, iy: Int, iz: Int, edge: Int) -> Int {
            let key = "\(ix),\(iy),\(iz),\(edge)"
            if let cached = edgeVertexCache[key] {
                return cached
            }

            let endpoints = MarchingCubesTables.edgeEndpoints[edge]
            let c0 = endpoints.0
            let c1 = endpoints.1
            let offset0 = MarchingCubesTables.cornerOffsets[c0]
            let offset1 = MarchingCubesTables.cornerOffsets[c1]
            let v0 = sampleField(field, ix: ix + offset0.0, iy: iy + offset0.1, iz: iz + offset0.2)
            let v1 = sampleField(field, ix: ix + offset1.0, iy: iy + offset1.1, iz: iz + offset1.2)
            let p0 = cornerPos(ix: ix, iy: iy, iz: iz, corner: c0)
            let p1 = cornerPos(ix: ix, iy: iy, iz: iz, corner: c1)
            let vertex = interpolateVertex(p1: p0, p2: p1, v1: Float(v0), v2: Float(v1), iso: iso)

            let index = positions.count / 3
            positions.append(contentsOf: [vertex.x, vertex.y, vertex.z])
            normals.append(contentsOf: [0, 0, 0])
            edgeVertexCache[key] = index
            return index
        }

        for iz in 0..<(gridZ - 1) {
            for iy in 0..<(gridY - 1) {
                for ix in 0..<(gridX - 1) {
                    var cubeIndex = 0
                    for corner in 0..<8 {
                        let offset = MarchingCubesTables.cornerOffsets[corner]
                        if sampleField(field, ix: ix + offset.0, iy: iy + offset.1, iz: iz + offset.2) > 0 {
                            cubeIndex |= 1 << corner
                        }
                    }
                    if cubeIndex == 0 || cubeIndex == 255 { continue }

                    let edgeFlags = MarchingCubesTables.edgeTable[cubeIndex]
                    var edgeVerts = [Int](repeating: -1, count: 12)
                    for edge in 0..<12 where edgeFlags & (1 << edge) != 0 {
                        edgeVerts[edge] = getEdgeVertex(ix: ix, iy: iy, iz: iz, edge: edge)
                    }

                    let triangles = MarchingCubesTables.triTable[cubeIndex]
                    var triangleIndex = 0
                    while triangleIndex + 2 < triangles.count {
                        let a = edgeVerts[triangles[triangleIndex]]
                        let b = edgeVerts[triangles[triangleIndex + 1]]
                        let c = edgeVerts[triangles[triangleIndex + 2]]
                        triangleIndex += 3

                        guard a >= 0, b >= 0, c >= 0 else { continue }
                        indices.append(contentsOf: [a, b, c])

                        let ax = positions[a * 3], ay = positions[a * 3 + 1], az = positions[a * 3 + 2]
                        let bx = positions[b * 3], by = positions[b * 3 + 1], bz = positions[b * 3 + 2]
                        let cx = positions[c * 3], cy = positions[c * 3 + 1], cz = positions[c * 3 + 2]

                        let e1x = bx - ax, e1y = by - ay, e1z = bz - az
                        let e2x = cx - ax, e2y = cy - ay, e2z = cz - az
                        let nx = e1y * e2z - e1z * e2y
                        let ny = e1z * e2x - e1x * e2z
                        let nz = e1x * e2y - e1y * e2x
                        let length = max(sqrt(nx * nx + ny * ny + nz * nz), 1e-6)
                        let fnx = nx / length, fny = ny / length, fnz = nz / length

                        for vertex in [a, b, c] {
                            normals[vertex * 3] += fnx
                            normals[vertex * 3 + 1] += fny
                            normals[vertex * 3 + 2] += fnz
                        }
                    }
                }
            }
        }

        for index in stride(from: 0, to: normals.count, by: 3) {
            let length = max(
                sqrt(
                    normals[index] * normals[index]
                        + normals[index + 1] * normals[index + 1]
                        + normals[index + 2] * normals[index + 2]
                ),
                1e-6
            )
            normals[index] /= length
            normals[index + 1] /= length
            normals[index + 2] /= length
        }

        return MeshData(positions: positions, normals: normals, indices: indices)
    }

    private static func interpolateVertex(
        p1: SIMD3<Float>,
        p2: SIMD3<Float>,
        v1: Float,
        v2: Float,
        iso: Float
    ) -> SIMD3<Float> {
        if abs(iso - v1) < 1e-6 { return p1 }
        if abs(iso - v2) < 1e-6 { return p2 }
        if abs(v1 - v2) < 1e-6 { return p1 }
        let t = (iso - v1) / (v2 - v1)
        return p1 + (p2 - p1) * t
    }

    private static func laplacianSmooth(positions: inout [Float], indices: [Int], lambda: Float = 0.45) {
        let vertexCount = positions.count / 3
        var neighbors = Array(repeating: [Int](), count: vertexCount)

        var triangleIndex = 0
        while triangleIndex + 2 < indices.count {
            let a = indices[triangleIndex]
            let b = indices[triangleIndex + 1]
            let c = indices[triangleIndex + 2]
            triangleIndex += 3
            neighbors[a].append(contentsOf: [b, c])
            neighbors[b].append(contentsOf: [a, c])
            neighbors[c].append(contentsOf: [a, b])
        }

        var next = positions
        for vertex in 0..<vertexCount {
            let unique = Array(Set(neighbors[vertex]))
            guard !unique.isEmpty else { continue }

            var average = SIMD3<Float>(repeating: 0)
            for neighbor in unique {
                average.x += positions[neighbor * 3]
                average.y += positions[neighbor * 3 + 1]
                average.z += positions[neighbor * 3 + 2]
            }
            average /= Float(unique.count)

            next[vertex * 3] = positions[vertex * 3] * (1 - lambda) + average.x * lambda
            next[vertex * 3 + 1] = positions[vertex * 3 + 1] * (1 - lambda) + average.y * lambda
            next[vertex * 3 + 2] = positions[vertex * 3 + 2] * (1 - lambda) + average.z * lambda
        }
        positions = next
    }

    private static func makeMeshResource(from mesh: MeshData) -> MeshResource? {
        let positionVectors = stride(from: 0, to: mesh.positions.count, by: 3).map { index in
            SIMD3(
                mesh.positions[index],
                mesh.positions[index + 1],
                mesh.positions[index + 2]
            )
        }
        let normalVectors = stride(from: 0, to: mesh.normals.count, by: 3).map { index in
            SIMD3(
                mesh.normals[index],
                mesh.normals[index + 1],
                mesh.normals[index + 2]
            )
        }
        let triangleIndices = mesh.indices.map(UInt32.init)

        var descriptor = MeshDescriptor(name: "visual-hull")
        descriptor.positions = MeshBuffers.Positions(positionVectors)
        descriptor.normals = MeshBuffers.Normals(normalVectors)
        descriptor.primitives = .triangles(triangleIndices)
        return try? MeshResource.generate(from: [descriptor])
    }
}
