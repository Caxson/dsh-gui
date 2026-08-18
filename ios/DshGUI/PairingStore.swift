import Foundation
import Security

/// Where the pairing lives on this device.
///
/// The Keychain, not UserDefaults: the secret grants access to someone's
/// sessions, and UserDefaults is a plist in the app container that ends up in
/// unencrypted backups. `ThisDeviceOnly` because a pairing restored onto a
/// different phone is a second device the owner never approved.
enum PairingStore {
    private static let service = "com.merefusion.dshgui.pairing"
    private static let account = "default"

    static func load() -> Pairing? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data,
              let text = String(data: data, encoding: .utf8)
        else { return nil }
        return try? Pairing.parse(text)
    }

    @discardableResult
    static func save(_ link: String) -> Bool {
        guard let data = link.data(using: .utf8) else { return false }
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        // Replace rather than add: re-pairing after the desktop rotated its
        // secret is the normal case, and an add would just fail as a duplicate.
        SecItemDelete(query as CFDictionary)
        var attributes = query
        attributes[kSecValueData as String] = data
        attributes[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        return SecItemAdd(attributes as CFDictionary, nil) == errSecSuccess
    }

    static func clear() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
    }
}
