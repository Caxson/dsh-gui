// Drive the shipping client code against the real relay and the real desktop
// link. Everything here is the app's own Pairing/RelayClient/Models — only the
// SwiftUI layer is absent, and that part was checked by looking at it.
//
// Coordinate-clicking a simulator proves something once; this proves it every
// time it is run.
import Foundation

let secret = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "e2e-secret-that-is-long-enough-ok"
let relay = CommandLine.arguments.count > 2 ? CommandLine.arguments[2] : "ws://127.0.0.1:8582/"

final class Tally: @unchecked Sendable { var failures: [String] = [] }
let tally = Tally()
var failures: [String] { tally.failures }
func check(_ ok: Bool, _ label: String) {
    if ok { print("  ok  \(label)") } else { tally.failures.append(label); print("  FAIL  \(label)") }
}

let link = "dsh-gui://pair?relay=\(relay.addingPercentEncoding(withAllowedCharacters: .alphanumerics)!)&secret=\(secret)"

// ── the link the desktop hands over is understood ──────────────────────────
let pairing = try Pairing.parse(link)
check(pairing.secret == secret, "the secret survives the round trip through the link")
check(pairing.relayURL.absoluteString == relay, "so does the relay address")
check(pairing.room.count == 32, "the room id is 32 hex characters")

// ── and links that are wrong are refused, not repaired ─────────────────────
for (bad, why) in [
    ("https://example.com/pair?relay=wss://x/&secret=aaaaaaaaaaaaaaaa", "a non-dsh-gui scheme"),
    ("dsh-gui://pair?secret=aaaaaaaaaaaaaaaa", "no relay"),
    ("dsh-gui://pair?relay=wss://x/", "no secret"),
    ("dsh-gui://pair?relay=http://x/&secret=aaaaaaaaaaaaaaaa", "an http relay"),
    ("dsh-gui://pair?relay=wss://x/&secret=short", "a truncated secret"),
] {
    var refused = false
    do { _ = try Pairing.parse(bad) } catch { refused = true }
    check(refused, "refuses a link with \(why)")
}

// ── the real conversation ──────────────────────────────────────────────────
let client = RelayClient(pairing: pairing)
try await client.connect()
check(await client.status == .ready, "the desktop accepts the secret and lets us in")

let sessions = try await client.listSessions()
check(sessions.count == 3, "three sessions come back (got \(sessions.count))")
check(sessions.first?.title == "relay 上限与心跳", "titles decode, including non-ASCII")
check(
    sessions.contains { $0.title == "未命名会话" },
    "a session with an empty title still appears, with a name a person can read"
)
check(sessions.allSatisfy { $0.updatedAt != nil }, "timestamps decode")
check(
    sessions.allSatisfy { ($0.updatedAt ?? .distantPast) > Date(timeIntervalSince1970: 1_600_000_000) },
    "and land in this decade — a seconds/milliseconds mix-up shows up as 1970"
)

guard let first = sessions.first else { fatalError("no sessions to read") }
let history = try await client.history(sessionId: first.id)
check(history.count == 4, "the history has four turns (got \(history.count))")
check(history.first?.role == .user, "roles decode")
check(history.contains { $0.text.contains("ping/pong") }, "message text arrives intact")

// A session with no history must come back empty rather than throw.
let empty = try await client.history(sessionId: "sess-empty")
check(empty.isEmpty, "an empty history is empty, not an error")

// ── sending, and reading our own message back ──────────────────────────────
let sent = "从手机发出的测试消息 \(Int(Date().timeIntervalSince1970))"
try await client.prompt(sessionId: first.id, text: sent)
let after = try await client.history(sessionId: first.id)
check(after.count == history.count + 2, "the turn and its reply are both in the history now")
check(after.contains { $0.text == sent }, "our own message reads back exactly as typed")
check(after.last?.role == .assistant, "and the reply is attributed to the assistant")

// The desktop's refusal of unlisted operations is covered where it belongs —
// scripts/verify-mobile-link.mjs, on the machine doing the refusing. Adding a
// back door here to ask again would weaken the client to test the desktop.

await client.disconnect(reason: "done")

if failures.isEmpty {
    print("\n✓ the phone client pairs, reads and sends against a real relay")
    exit(0)
}
print("\n✗ \(failures.count) check(s) failed")
exit(1)
