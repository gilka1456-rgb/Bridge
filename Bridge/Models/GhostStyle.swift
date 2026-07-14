import UIKit

enum GhostStyle: String, Codable, CaseIterable, Identifiable {
    case wraith
    case phantom
    case cyber
    case quantum

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .wraith: return "灵体"
        case .phantom: return "幽灵"
        case .cyber: return "赛博"
        case .quantum: return "量子"
        }
    }

    var tint: UIColor {
        switch self {
        case .wraith: return UIColor(red: 0.72, green: 0.82, blue: 1.0, alpha: 1)
        case .phantom: return UIColor(red: 0.85, green: 0.88, blue: 0.95, alpha: 1)
        case .cyber: return UIColor(red: 0.2, green: 0.95, blue: 0.85, alpha: 1)
        case .quantum: return UIColor(red: 0.61, green: 0.43, blue: 1.0, alpha: 1)
        }
    }

    var glowIntensity: Float {
        switch self {
        case .wraith: return 0.65
        case .phantom: return 0.4
        case .cyber: return 0.85
        case .quantum: return 0.95
        }
    }

    var opacity: Float {
        switch self {
        case .wraith: return 0.38
        case .phantom: return 0.22
        case .cyber: return 0.5
        case .quantum: return 0.42
        }
    }

    var rimGlow: Float {
        switch self {
        case .wraith: return 0.55
        case .phantom: return 0.35
        case .cyber: return 0.7
        case .quantum: return 0.85
        }
    }

    var usesWireframe: Bool {
        switch self {
        case .cyber, .quantum: return true
        default: return false
        }
    }

    var isHolographic: Bool {
        switch self {
        case .cyber, .quantum: return true
        default: return false
        }
    }
}
