import ARKit
import CoreLocation
import Foundation

// MARK: - Protocol

protocol SpatialLocalizer: AnyObject {
    func isAvailable(at location: CLLocation?) async -> Bool
    func host(placement: Placement, session: ARSession) async throws -> PlacementAnchorRecord
    func resolve(placement: Placement, session: ARSession) async throws
}

// MARK: - World map (existing flow)

final class WorldMapLocalizer: SpatialLocalizer {
    func isAvailable(at location: CLLocation?) async -> Bool {
        _ = location
        return true
    }

    func host(placement: Placement, session: ARSession) async throws -> PlacementAnchorRecord {
        _ = placement
        let filename = try await AnchorPersistence.persistWorldMap(from: session)
        guard let frame = session.currentFrame else {
            throw AnchorPersistenceError.worldMapUnavailable(mappingStatus: "no-current-frame", anchorCount: 0)
        }
        let anchor = ARAnchor(transform: frame.camera.transform)
        session.add(anchor: anchor)
        return PlacementAnchorRecord(
            anchorIdentifier: anchor.identifier,
            transform: AnchorPersistence.serializeTransform(anchor.transform),
            worldMapFilename: filename
        )
    }

    func resolve(placement: Placement, session: ARSession) async throws {
        let worldMap = try AnchorPersistence.loadWorldMap(named: placement.anchor.worldMapFilename)
        let configuration = ARWorldTrackingConfiguration()
        configuration.initialWorldMap = worldMap
        session.run(configuration, options: [.resetTracking, .removeExistingAnchors])
    }
}

// MARK: - Apple geo tracking

final class AppleGeoLocalizer: SpatialLocalizer {
    func isAvailable(at location: CLLocation?) async -> Bool {
        guard let coordinate = location?.coordinate else { return false }
        return await withCheckedContinuation { continuation in
            ARGeoTrackingConfiguration.checkAvailability(at: coordinate) { available, _ in
                continuation.resume(returning: available)
            }
        }
    }

    func host(placement: Placement, session: ARSession) async throws -> PlacementAnchorRecord {
        // TODO: create ARGeoAnchor at placement geo + persist geo metadata on record.
        _ = placement
        _ = session
        throw AnchorPersistenceError.worldMapUnavailable(mappingStatus: "geo-host-not-implemented", anchorCount: 0)
    }

    func resolve(placement: Placement, session: ARSession) async throws {
        // TODO: run ARGeoTrackingConfiguration and attach stored ARGeoAnchor.
        guard
            let latitude = placement.anchor.geoAnchorLatitude ?? placement.anchor.latitude,
            let longitude = placement.anchor.geoAnchorLongitude ?? placement.anchor.longitude
        else {
            throw AnchorPersistenceError.worldMapUnavailable(mappingStatus: "geo-coordinate-missing", anchorCount: 0)
        }

        let coordinate = CLLocationCoordinate2D(latitude: latitude, longitude: longitude)
        guard await isAvailable(at: CLLocation(latitude: latitude, longitude: longitude)) else {
            throw AnchorPersistenceError.worldMapUnavailable(mappingStatus: "geo-unavailable", anchorCount: 0)
        }

        let configuration = ARGeoTrackingConfiguration()
        _ = coordinate
        session.run(configuration, options: [.resetTracking, .removeExistingAnchors])
    }
}

// MARK: - Third-party VPS stubs

final class EasyARLocalizer: SpatialLocalizer {
    func isAvailable(at location: CLLocation?) async -> Bool {
        // TODO: integrate EasyAR Mega session availability.
        _ = location
        return false
    }

    func host(placement: Placement, session: ARSession) async throws -> PlacementAnchorRecord {
        // TODO: host EasyAR cloud anchor and store vpsMapId/vpsAnchorId.
        _ = placement
        _ = session
        throw AnchorPersistenceError.worldMapUnavailable(mappingStatus: "easyar-host-not-implemented", anchorCount: 0)
    }

    func resolve(placement: Placement, session: ARSession) async throws {
        // TODO: resolve EasyAR cloud anchor from placement.anchor.vpsMapId/vpsAnchorId.
        _ = placement
        _ = session
        throw AnchorPersistenceError.worldMapUnavailable(mappingStatus: "easyar-resolve-not-implemented", anchorCount: 0)
    }
}

final class HuaweiCloudAnchorLocalizer: SpatialLocalizer {
    func isAvailable(at location: CLLocation?) async -> Bool {
        // TODO: integrate Huawei AR Engine cloud anchor availability.
        _ = location
        return false
    }

    func host(placement: Placement, session: ARSession) async throws -> PlacementAnchorRecord {
        // TODO: host Huawei cloud anchor and store vpsMapId/vpsAnchorId.
        _ = placement
        _ = session
        throw AnchorPersistenceError.worldMapUnavailable(mappingStatus: "huawei-host-not-implemented", anchorCount: 0)
    }

    func resolve(placement: Placement, session: ARSession) async throws {
        // TODO: resolve Huawei cloud anchor from placement.anchor.vpsMapId/vpsAnchorId.
        _ = placement
        _ = session
        throw AnchorPersistenceError.worldMapUnavailable(mappingStatus: "huawei-resolve-not-implemented", anchorCount: 0)
    }
}

// MARK: - GPS + compass fallback

final class GpsCompassLocalizer: SpatialLocalizer {
    func isAvailable(at location: CLLocation?) async -> Bool {
        location != nil
    }

    func host(placement: Placement, session: ARSession) async throws -> PlacementAnchorRecord {
        // TODO: coarse outdoor hint only — no sub-meter AR lock without VPS/world map.
        _ = placement
        guard let frame = session.currentFrame else {
            throw AnchorPersistenceError.worldMapUnavailable(mappingStatus: "no-current-frame", anchorCount: 0)
        }
        let anchor = ARAnchor(transform: frame.camera.transform)
        session.add(anchor: anchor)
        return PlacementAnchorRecord(
            anchorIdentifier: anchor.identifier,
            transform: AnchorPersistence.serializeTransform(anchor.transform),
            worldMapFilename: placement.anchor.worldMapFilename
        )
    }

    func resolve(placement: Placement, session: ARSession) async throws {
        // TODO: orient user using stored headingDegrees + GPS distance hints.
        _ = placement
        let configuration = ARWorldTrackingConfiguration()
        session.run(configuration, options: [.resetTracking, .removeExistingAnchors])
    }
}
