import Foundation

enum MessageModerationError: LocalizedError {
    case empty
    case tooLong(max: Int)
    case blocked

    var errorDescription: String? {
        switch self {
        case .empty:
            return "留言不能为空。"
        case .tooLong(let max):
            return "留言不能超过 \(max) 字。"
        case .blocked:
            return "留言未通过审核，请修改后重试。"
        }
    }
}

struct MessageModeration {
    static let maxLength = 80

    private static let blockedTerms: [String] = [
        "操", "傻逼", "去死", "杀人", "色情", "赌博", "毒品"
    ]

    static func validate(_ text: String) throws -> String {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw MessageModerationError.empty }
        guard trimmed.count <= maxLength else { throw MessageModerationError.tooLong(max: maxLength) }

        let lowered = trimmed.lowercased()
        if blockedTerms.contains(where: { lowered.contains($0) }) {
            throw MessageModerationError.blocked
        }

        return trimmed
    }
}
