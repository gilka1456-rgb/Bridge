import SwiftUI

enum AvatarDeleteConfirmation {
    static func message(label: String, linkedPlacementCount: Int) -> String {
        if linkedPlacementCount > 0 {
            return "确定删除虚像「\(label)」吗？该虚像有 \(linkedPlacementCount) 个放置，删除后这些放置及其评论也会一并删除。"
        }
        return "确定删除虚像「\(label)」吗？此操作无法恢复。"
    }
}

extension View {
    func confirmAvatarDeletion(
        isPresented: Binding<Bool>,
        avatar: AvatarPose?,
        linkedPlacementCount: Int,
        onCancel: (() -> Void)? = nil,
        onDelete: @escaping () -> Void
    ) -> some View {
        alert("删除虚像", isPresented: isPresented) {
            Button("取消", role: .cancel) {
                onCancel?()
            }
            Button("删除", role: .destructive, action: onDelete)
        } message: {
            if let avatar {
                Text(AvatarDeleteConfirmation.message(
                    label: avatar.label,
                    linkedPlacementCount: linkedPlacementCount
                ))
            }
        }
    }
}
