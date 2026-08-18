import SwiftUI

struct PairingView: View {
    @Environment(AppModel.self) private var model
    @State private var showScanner = false
    @State private var pastedLink = ""
    @State private var cameraProblem: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("在 Mac 上打开 Dsh GUI 菜单里的「手机连接」，开启后扫描那张二维码。")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }

                Section {
                    Button {
                        cameraProblem = nil
                        showScanner = true
                    } label: {
                        Label("扫描二维码", systemImage: "qrcode.viewfinder")
                    }
                }

                Section("或者粘贴配对链接") {
                    TextField("dsh-gui://pair?…", text: $pastedLink, axis: .vertical)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .font(.system(.footnote, design: .monospaced))
                    Button("连接") {
                        Task { await model.pair(withLink: pastedLink) }
                    }
                    .disabled(pastedLink.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }

                if let problem = cameraProblem {
                    Section { Text(problem).foregroundStyle(.orange).font(.footnote) }
                }
                if let error = model.errorText {
                    Section { Text(error).foregroundStyle(.red).font(.footnote) }
                }

                Section("手机上能做什么") {
                    Label("看会话列表", systemImage: "list.bullet")
                    Label("读一个会话的历史", systemImage: "text.bubble")
                    Label("向会话发消息", systemImage: "paperplane")
                    Label("不能跑命令、开终端或读文件", systemImage: "xmark.shield")
                        .foregroundStyle(.secondary)
                }
            }
            .navigationTitle("连接到 Mac")
            .overlay { if model.isBusy { ProgressView().controlSize(.large) } }
            .sheet(isPresented: $showScanner) {
                NavigationStack {
                    QRScannerView(
                        onScan: { value in
                            showScanner = false
                            Task { await model.pair(withLink: value) }
                        },
                        onUnavailable: { reason in
                            showScanner = false
                            cameraProblem = reason
                        }
                    )
                    .ignoresSafeArea()
                    .navigationTitle("对准 Mac 上的二维码")
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) {
                            Button("取消") { showScanner = false }
                        }
                    }
                }
            }
        }
    }
}
