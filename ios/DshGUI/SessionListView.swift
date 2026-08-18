import SwiftUI

struct SessionListView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        NavigationStack {
            List {
                if let error = model.errorText {
                    Section { Text(error).foregroundStyle(.red).font(.footnote) }
                }
                Section {
                    ForEach(model.sessions) { session in
                        // `NavigationLink(value:)` with a `navigationDestination`,
                        // not an inline destination: inside a List the inline
                        // form builds every destination up front, so opening the
                        // list fired one history request per session — and each
                        // one overwrote the last one's messages.
                        NavigationLink(value: session) {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(session.title).lineLimit(1)
                                if let updated = session.updatedAt {
                                    Text(updated, style: .relative)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                } header: {
                    StatusLine(status: model.status)
                } footer: {
                    if model.sessions.isEmpty && !model.isBusy {
                        Text("这台 Mac 上还没有会话。在桌面端开一个，然后下拉刷新。")
                    }
                }
            }
            .navigationDestination(for: SessionSummary.self) { session in
                ChatView(session: session)
            }
            .refreshable { await model.refresh() }
            .navigationTitle("会话")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button("重新连接") { Task { await model.connectAndLoad() } }
                        Button("解除配对", role: .destructive) { Task { await model.unpair() } }
                    } label: {
                        Image(systemName: "ellipsis.circle")
                    }
                }
            }
            .overlay { if model.isBusy && model.sessions.isEmpty { ProgressView().controlSize(.large) } }
        }
    }
}

/// One line that says what is actually true right now — including the states
/// that are easy to mistake for the app being broken.
struct StatusLine: View {
    let status: RelayClient.Status

    var body: some View {
        let (text, colour) = describe
        Label {
            Text(text).textCase(nil)
        } icon: {
            Circle().fill(colour).frame(width: 8, height: 8)
        }
        .font(.footnote)
    }

    private var describe: (String, Color) {
        switch status {
        case .idle: return ("未连接", .secondary)
        case .connecting: return ("正在连接中转…", .orange)
        case .authenticating: return ("正在验证配对…", .orange)
        case .ready: return ("已连上 Mac", .green)
        case .desktopOffline: return ("Mac 不在线——桌面端没开，或者没开启手机连接", .orange)
        case let .failed(message): return (message, .red)
        }
    }
}
