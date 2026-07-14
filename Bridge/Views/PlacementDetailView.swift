import SwiftUI

struct PlacementDetailView: View {
    @EnvironmentObject private var store: LocalStore

    let placement: Placement

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if let avatar = store.avatar(for: placement.avatarPoseID) {
                    Text(avatar.label)
                        .font(.headline)
                    Text(avatar.style.displayName)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Text(placement.createdAt.formatted(date: .abbreviated, time: .shortened))
                    .font(.caption2)
                    .foregroundStyle(.secondary)

                Text(placement.message)
                    .font(.body)
                    .padding()
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 12))

                CommentThreadView(placementID: placement.id)
            }
            .padding()
        }
        .navigationTitle("放置详情")
        .navigationBarTitleDisplayMode(.inline)
    }
}
