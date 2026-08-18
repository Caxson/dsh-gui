import CryptoKit
import Foundation

/// What the Mac handed over: where to meet, and the secret that proves who we are.
///
/// The secret is the credential. It is what the desktop checks — being in the
/// right room proves nothing, because the relay knows every room id it carries.
struct Pairing: Equatable, Sendable {
    let relayURL: URL
    let secret: String

    /// The room both ends meet in. Must match the desktop's derivation exactly
    /// or pairing fails silently: two sockets in different rooms simply never
    /// see each other, with no error anywhere to explain it.
    ///
    /// Node: `createHmac('sha256', 'dsh-gui-mobile-room').update(secret)
    ///        .digest('hex').slice(0, 32)`
    var room: String {
        let key = SymmetricKey(data: Data(Pairing.roomKey.utf8))
        let mac = HMAC<SHA256>.authenticationCode(for: Data(secret.utf8), using: key)
        // 32 hex characters is the first 16 bytes — slicing the hex string and
        // slicing the digest are the same thing only if we stop at a byte
        // boundary, which 32 does.
        return mac.prefix(16).map { String(format: "%02x", $0) }.joined()
    }

    static let roomKey = "dsh-gui-mobile-room"

    /// The socket URL for this device's side of the pairing.
    var clientURL: URL? {
        var components = URLComponents(url: relayURL, resolvingAgainstBaseURL: false)
        components?.queryItems = [
            URLQueryItem(name: "room", value: room),
            URLQueryItem(name: "role", value: "client"),
        ]
        return components?.url
    }
}

enum PairingError: Error, Equatable {
    case notAPairingLink
    case missingRelay
    case missingSecret
    case relayNotWebSocket(String)
    case secretTooShort
}

extension Pairing {
    /// Parse the `dsh-gui://pair?relay=…&secret=…` link the desktop produces.
    ///
    /// Everything here is refused rather than repaired. A pairing link that is
    /// almost right — an http relay, a truncated secret — would fail later as a
    /// connection that never authenticates, and a person cannot debug that.
    static func parse(_ text: String) throws -> Pairing {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let components = URLComponents(string: trimmed),
              components.scheme == "dsh-gui",
              components.host == "pair" || components.path == "pair"
        else { throw PairingError.notAPairingLink }

        let items = components.queryItems ?? []
        func value(_ name: String) -> String? {
            items.first { $0.name == name }?.value.flatMap { $0.isEmpty ? nil : $0 }
        }

        guard let relayText = value("relay") else { throw PairingError.missingRelay }
        guard let relay = URL(string: relayText), let scheme = relay.scheme?.lowercased(),
              scheme == "wss" || scheme == "ws"
        else { throw PairingError.relayNotWebSocket(relayText) }

        guard let secret = value("secret") else { throw PairingError.missingSecret }
        // Matches the desktop's own floor. A short secret is not a secret, and
        // accepting one here would mean pairing "works" against nothing.
        guard secret.count >= 16 else { throw PairingError.secretTooShort }

        return Pairing(relayURL: relay, secret: secret)
    }
}
