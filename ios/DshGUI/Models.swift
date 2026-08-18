import Foundation

/// A session as the engine reports it.
///
/// Decoded defensively: this comes off the network via a desktop we trust, but
/// through an engine whose shape changes between releases. A session with an
/// unexpected field should still appear in the list rather than take the whole
/// list down with it.
struct SessionSummary: Identifiable, Equatable, Hashable, Sendable {
    let id: String
    let title: String
    let updatedAt: Date?

    init?(_ raw: Any) {
        guard let dict = raw as? [String: Any] else { return nil }
        guard let id = (dict["sessionId"] as? String) ?? (dict["id"] as? String), !id.isEmpty else { return nil }
        self.id = id
        let title = (dict["title"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        self.title = (title?.isEmpty == false ? title! : "未命名会话")
        if let ms = dict["updatedAt"] as? Double {
            // Milliseconds or seconds, depending on where it came from. A
            // timestamp from 1970 on screen is how you find out you guessed.
            self.updatedAt = Date(timeIntervalSince1970: ms > 3_000_000_000 ? ms / 1000 : ms)
        } else {
            self.updatedAt = nil
        }
    }
}

/// One turn in a conversation, flattened to what a phone screen can show.
struct ChatMessage: Identifiable, Equatable, Sendable {
    enum Role: String, Sendable { case user, assistant, other }

    let id: String
    let role: Role
    let text: String

    init?(_ raw: Any, index: Int) {
        guard let dict = raw as? [String: Any] else { return nil }
        let roleText = (dict["role"] as? String) ?? (dict["type"] as? String) ?? ""
        role = Role(rawValue: roleText) ?? .other
        id = (dict["id"] as? String) ?? "m\(index)"

        // The engine represents content as a string, or as parts. Anything that
        // is not text (a tool call, an image) is skipped rather than rendered
        // as a placeholder — a phone showing "[object Object]" is worse than a
        // phone showing only what it can actually display.
        if let text = dict["content"] as? String {
            self.text = text
        } else if let parts = dict["content"] as? [[String: Any]] {
            self.text = parts.compactMap { $0["text"] as? String }.joined(separator: "\n")
        } else if let text = dict["text"] as? String {
            self.text = text
        } else {
            return nil
        }
        if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return nil }
    }

    init(id: String, role: Role, text: String) {
        self.id = id
        self.role = role
        self.text = text
    }
}

enum Decode {
    /// Sessions out of a `sessions.list` reply, tolerating either shape the
    /// engine has used: a bare array, or an object with a `sessions` key.
    static func sessions(from value: [String: Any]) -> [SessionSummary] {
        let raw = (value["sessions"] as? [Any]) ?? (value["items"] as? [Any]) ?? []
        return raw.compactMap(SessionSummary.init)
    }

    static func messages(from value: [String: Any]) -> [ChatMessage] {
        let raw = (value["messages"] as? [Any]) ?? (value["history"] as? [Any]) ?? (value["items"] as? [Any]) ?? []
        return raw.enumerated().compactMap { ChatMessage($0.element, index: $0.offset) }
    }
}
