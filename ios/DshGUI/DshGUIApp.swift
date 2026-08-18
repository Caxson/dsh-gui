import SwiftUI

@main
struct DshGUIApp: App {
    @State private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .task { await model.restore() }
                // A pairing link is openable, not only scannable: it can arrive
                // in a message, and it is how the pairing path can be driven on
                // a simulator, which has no camera to point at anything.
                .onOpenURL { url in
                    Task { await model.pair(withLink: url.absoluteString) }
                }
        }
    }
}

struct RootView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        switch model.screen {
        case .pairing:
            PairingView()
        case .sessions:
            SessionListView()
        }
    }
}
