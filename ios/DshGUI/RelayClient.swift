import Foundation

/// The phone's end of the link.
///
/// Connects to the relay, proves who it is with the pairing secret, and then
/// exchanges request/reply frames with the Mac. It knows only the three
/// operations the desktop gateway will answer — asking for anything else is
/// refused there, not here, and that is the right place for it: the boundary
/// belongs on the machine being protected, not on the client asking.
actor RelayClient {
    enum Status: Equatable, Sendable {
        case idle
        case connecting
        /// Socket open, secret sent, waiting to be let in.
        case authenticating
        case ready
        /// The desktop is not attached to the room, so nothing can be answered.
        case desktopOffline
        case failed(String)
    }

    struct RequestFailure: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }

    private let pairing: Pairing
    private let session: URLSession
    private var task: URLSessionWebSocketTask?
    private var pending: [String: CheckedContinuation<[String: Any], Error>] = [:]
    private var authGate: CheckedContinuation<Void, Error>?
    private var nextID = 0
    private var statusHandler: (@Sendable (Status) -> Void)?

    private(set) var status: Status = .idle {
        didSet { if status != oldValue { statusHandler?(status) } }
    }

    init(pairing: Pairing, session: URLSession = .shared) {
        self.pairing = pairing
        self.session = session
    }

    func onStatus(_ handler: @escaping @Sendable (Status) -> Void) {
        statusHandler = handler
        handler(status)
    }

    // MARK: - Connection

    func connect() async throws {
        guard let url = pairing.clientURL else {
            status = .failed("配对信息里的中转地址不可用")
            throw RequestFailure(message: "配对信息里的中转地址不可用")
        }
        disconnect(reason: nil)
        status = .connecting

        let socket = session.webSocketTask(with: url)
        task = socket
        socket.resume()
        receiveLoop(on: socket)

        // Identify ourselves before anything else. Until the desktop verifies
        // this, it refuses every other frame — so there is no point sending one.
        try await send(["type": "hello", "auth": pairing.secret])
        status = .authenticating
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            authGate = cont
        }
    }

    func disconnect(reason: String?) {
        task?.cancel(with: .goingAway, reason: reason?.data(using: .utf8))
        task = nil
        failAllPending(with: RequestFailure(message: reason ?? "连接已断开"))
        if case .failed = status {} else { status = .idle }
    }

    private func failAllPending(with error: Error) {
        let waiting = pending
        pending.removeAll()
        for (_, cont) in waiting { cont.resume(throwing: error) }
        authGate?.resume(throwing: error)
        authGate = nil
    }

    // MARK: - Requests

    // The wire format stops here. A JSON dictionary is not Sendable and has no
    // business crossing an actor boundary, so decoding happens inside and only
    // value types leave — which is also the only place that knows the shape.

    func listSessions() async throws -> [SessionSummary] {
        Decode.sessions(from: try await request("sessions.list"))
    }

    func history(sessionId: String) async throws -> [ChatMessage] {
        Decode.messages(from: try await request("sessions.history", payload: ["sessionId": sessionId]))
    }

    func prompt(sessionId: String, text: String) async throws {
        _ = try await request("sessions.prompt", payload: ["sessionId": sessionId, "text": text])
    }

    /// Ask the Mac for something. Resolves when the reply with the same id
    /// arrives, or throws with whatever the desktop said was wrong.
    private func request(_ op: String, payload: [String: Any] = [:]) async throws -> [String: Any] {
        nextID += 1
        let id = "m\(nextID)"
        return try await withCheckedThrowingContinuation { cont in
            pending[id] = cont
            Task {
                do {
                    try await send(["id": id, "op": op, "payload": payload])
                } catch {
                    // Nothing will ever answer this id, so settle it here rather
                    // than leaving the caller waiting on a frame that never went.
                    if let waiting = pending.removeValue(forKey: id) {
                        waiting.resume(throwing: error)
                    }
                }
            }
        }
    }

    private func send(_ object: [String: Any]) async throws {
        guard let task else { throw RequestFailure(message: "还没有连接") }
        let data = try JSONSerialization.data(withJSONObject: object)
        try await task.send(.string(String(decoding: data, as: UTF8.self)))
    }

    // MARK: - Receiving

    private nonisolated func receiveLoop(on socket: URLSessionWebSocketTask) {
        Task { [weak self] in
            while true {
                do {
                    let message = try await socket.receive()
                    guard let self else { return }
                    await self.handle(message)
                } catch {
                    guard let self else { return }
                    await self.socketClosed(error, on: socket)
                    return
                }
            }
        }
    }

    private func socketClosed(_ error: Error, on socket: URLSessionWebSocketTask) {
        // A reconnect leaves the old socket's receive loop to unwind; its
        // failure must not tear down the connection that replaced it.
        guard task === socket else { return }
        let message = (error as NSError).localizedDescription
        status = .failed(message)
        failAllPending(with: RequestFailure(message: message))
        task = nil
    }

    private func handle(_ message: URLSessionWebSocketTask.Message) {
        guard case let .string(text) = message,
              let data = text.data(using: .utf8),
              let frame = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        else { return }

        switch frame["type"] as? String {
        case "welcome":
            status = .ready
            authGate?.resume()
            authGate = nil
            return
        case "unauthorized":
            // The desktop did not accept the secret. Retrying will not help and
            // a stale pairing should be replaced, not hammered.
            let message = "这台 Mac 不接受这个配对，可能密钥已更换。请重新扫码。"
            status = .failed(message)
            authGate?.resume(throwing: RequestFailure(message: message))
            authGate = nil
            failAllPending(with: RequestFailure(message: message))
            return
        case "peer":
            // Relay housekeeping: is the Mac attached to the room at all?
            let macPresent = frame["agent"] as? Bool ?? false
            if !macPresent {
                status = .desktopOffline
            } else if status == .desktopOffline {
                status = .ready
            }
            return
        default:
            break
        }

        guard let id = frame["id"] as? String, let cont = pending.removeValue(forKey: id) else { return }
        if frame["ok"] as? Bool == true {
            cont.resume(returning: (frame["value"] as? [String: Any]) ?? [:])
        } else {
            cont.resume(throwing: RequestFailure(message: (frame["error"] as? String) ?? "请求失败"))
        }
    }
}
