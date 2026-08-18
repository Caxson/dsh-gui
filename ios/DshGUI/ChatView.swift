import SwiftUI

struct ChatView: View {
    @Environment(AppModel.self) private var model
    let session: SessionSummary

    @State private var draft = ""

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    ForEach(model.messages) { message in
                        MessageBubble(message: message).id(message.id)
                    }
                }
                .padding()
            }
            .onChange(of: model.messages.count) {
                guard let last = model.messages.last else { return }
                withAnimation { proxy.scrollTo(last.id, anchor: .bottom) }
            }
        }
        .safeAreaInset(edge: .bottom) { composer }
        .navigationTitle(session.title)
        .navigationBarTitleDisplayMode(.inline)
        .task { await model.open(session) }
        .overlay { if model.isBusy && model.messages.isEmpty { ProgressView() } }
    }

    private var composer: some View {
        VStack(spacing: 6) {
            if let error = model.errorText {
                Text(error).font(.caption).foregroundStyle(.red)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            HStack(alignment: .bottom, spacing: 8) {
                TextField("发消息…", text: $draft, axis: .vertical)
                    .textFieldStyle(.roundedBorder)
                    .lineLimit(1 ... 5)
                Button {
                    let text = draft
                    draft = ""
                    Task { await model.send(text) }
                } label: {
                    Image(systemName: "arrow.up.circle.fill").font(.title2)
                }
                .disabled(model.isSending || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(.horizontal)
        .padding(.vertical, 8)
        .background(.bar)
    }
}

struct MessageBubble: View {
    let message: ChatMessage

    var body: some View {
        HStack {
            if message.role == .user { Spacer(minLength: 40) }
            Text(message.text)
                .textSelection(.enabled)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(background, in: RoundedRectangle(cornerRadius: 14))
                .foregroundStyle(message.role == .user ? .white : .primary)
            if message.role != .user { Spacer(minLength: 40) }
        }
    }

    private var background: Color {
        switch message.role {
        case .user: return .accentColor
        case .assistant: return Color(.secondarySystemBackground)
        case .other: return Color(.tertiarySystemBackground)
        }
    }
}
