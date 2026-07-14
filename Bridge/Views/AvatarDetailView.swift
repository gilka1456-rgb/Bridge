import SwiftUI

struct AvatarDetailView: View {
    let avatar: AvatarPose

    @EnvironmentObject private var store: LocalStore
    @EnvironmentObject private var diagnostics: BridgeDiagnostics
    @Environment(\.dismiss) private var dismiss

    @State private var rotationY: Double = 0
    @State private var dragStartRotation: Double = 0
    @State private var showDeleteConfirm = false

    private var preview: (pose: AvatarPose, fineRotation: Float, angle: ScanViewAngle) {
        let result = avatar.previewPose(rotationY: Float(rotationY))
        let normalized = ((Float(rotationY).truncatingRemainder(dividingBy: 360)) + 360).truncatingRemainder(dividingBy: 360)
        let angle: ScanViewAngle
        switch normalized {
        case 45..<135: angle = .right
        case 135..<225: angle = .back
        case 225..<315: angle = .left
        default: angle = .front
        }
        return (result.pose, result.fineRotation, angle)
    }

    var body: some View {
        VStack(spacing: 0) {
            GhostPreviewView(avatar: preview.pose, rotationY: preview.fineRotation)
                .frame(maxWidth: .infinity)
                .frame(height: 360)
                .clipShape(RoundedRectangle(cornerRadius: 16))
                .gesture(
                    DragGesture()
                        .onChanged { value in
                            var next = dragStartRotation + Double(value.translation.width) * 0.4
                            next = next.truncatingRemainder(dividingBy: 360)
                            if next < 0 { next += 360 }
                            rotationY = next
                        }
                        .onEnded { _ in
                            dragStartRotation = rotationY
                        }
                )

            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text("旋转预览")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Spacer()
                    Text("\(Int(rotationY))°")
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.secondary)
                }

                Slider(value: $rotationY, in: 0...359, step: 1)

                Text("默认正面，可拖动滑块或在画面上拖拽旋转 360°。当前方位：\(preview.angle.displayName)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .padding()
        }
        .navigationTitle(avatar.label)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("删除", role: .destructive) {
                    showDeleteConfirm = true
                }
            }
        }
        .confirmAvatarDeletion(
            isPresented: $showDeleteConfirm,
            avatar: avatar,
            linkedPlacementCount: store.placements.filter { $0.avatarPoseID == avatar.id }.count
        ) {
            let linkedPlacements = store.placements.filter { $0.avatarPoseID == avatar.id }
            let linkedComments = linkedPlacements
                .map { store.placementEngagement(placementID: $0.id).commentCount }
                .reduce(0, +)
            store.deleteAvatar(avatar)
            diagnostics.record(
                "删除虚像：\(avatar.id.uuidString)，linkedPlacements=\(linkedPlacements.count)，comments=\(linkedComments)，\(store.lastMaintenanceSummary ?? "WorldMap 无需清理")",
                scope: "Avatars"
            )
            dismiss()
        }
    }
}
