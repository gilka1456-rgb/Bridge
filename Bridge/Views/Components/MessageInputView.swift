import SwiftUI

struct MessageInputView: View {
    @Binding var text: String
    let placeholder: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("留言")
                .font(.caption)
                .foregroundStyle(.secondary)
            TextField(placeholder, text: $text, axis: .vertical)
                .lineLimit(2...4)
                .padding(12)
                .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 12))
            Text("\(text.count)/\(MessageModeration.maxLength)")
                .font(.caption2)
                .foregroundStyle(text.count > MessageModeration.maxLength ? .red : .secondary)
        }
    }
}
