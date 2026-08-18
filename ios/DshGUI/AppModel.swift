import Foundation
import Observation

/// The app's state, and the only place that talks to the relay client.
@MainActor
@Observable
final class AppModel {
    enum Screen: Equatable {
        case pairing
        case sessions
    }

    var screen: Screen = .pairing
    var status: RelayClient.Status = .idle
    var sessions: [SessionSummary] = []
    var messages: [ChatMessage] = []
    var openSession: SessionSummary?
    var errorText: String?
    var isBusy = false
    var isSending = false

    private var client: RelayClient?
    private var pairing: Pairing?

    /// Injectable so tests can drive the whole model against a local relay.
    var makeClient: (Pairing) -> RelayClient = { RelayClient(pairing: $0) }

    func restore() async {
        guard let saved = PairingStore.load() else { return }
        await adopt(saved)
    }

    func pair(withLink link: String) async {
        errorText = nil
        do {
            let pairing = try Pairing.parse(link)
            PairingStore.save(link)
            await adopt(pairing)
        } catch {
            errorText = Self.describe(error)
        }
    }

    func unpair() async {
        await client?.disconnect(reason: "unpaired")
        PairingStore.clear()
        client = nil
        pairing = nil
        sessions = []
        messages = []
        openSession = nil
        status = .idle
        screen = .pairing
    }

    private func adopt(_ pairing: Pairing) async {
        self.pairing = pairing
        let client = makeClient(pairing)
        self.client = client
        await client.onStatus { [weak self] status in
            Task { @MainActor in self?.status = status }
        }
        await connectAndLoad()
    }

    func connectAndLoad() async {
        guard let client else { return }
        isBusy = true
        defer { isBusy = false }
        do {
            try await client.connect()
            screen = .sessions
            await refresh()
        } catch {
            errorText = Self.describe(error)
        }
    }

    func refresh() async {
        guard let client else { return }
        isBusy = true
        defer { isBusy = false }
        do {
            sessions = try await client.listSessions()
            errorText = nil
        } catch {
            errorText = Self.describe(error)
        }
    }

    func open(_ session: SessionSummary) async {
        guard let client else { return }
        openSession = session
        messages = []
        isBusy = true
        defer { isBusy = false }
        do {
            messages = try await client.history(sessionId: session.id)
            errorText = nil
        } catch {
            errorText = Self.describe(error)
        }
    }

    func send(_ text: String) async {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let client, let session = openSession, !trimmed.isEmpty else { return }
        // Show it immediately. The reply comes back through the history reload,
        // and a message that vanishes for two seconds reads as a failure.
        messages.append(ChatMessage(id: "local-\(UUID().uuidString)", role: .user, text: trimmed))
        isSending = true
        defer { isSending = false }
        do {
            try await client.prompt(sessionId: session.id, text: trimmed)
            let reloaded = try await client.history(sessionId: session.id)
            // Only replace if the reload actually contains our turn; otherwise
            // the optimistic message would disappear with nothing to replace it.
            if reloaded.count >= messages.count - 1 { messages = reloaded }
            errorText = nil
        } catch {
            errorText = Self.describe(error)
        }
    }

    static func describe(_ error: Error) -> String {
        switch error {
        case PairingError.notAPairingLink: return "这不是一个配对链接。在 Mac 上打开「手机连接」，扫码或复制链接。"
        case PairingError.missingRelay: return "配对链接里没有中转地址。"
        case PairingError.missingSecret: return "配对链接里没有密钥。"
        case PairingError.secretTooShort: return "配对链接里的密钥不完整，可能被截断了。"
        case let PairingError.relayNotWebSocket(text): return "中转地址必须是 ws:// 或 wss://，收到的是 \(text)"
        default: return error.localizedDescription
        }
    }
}
