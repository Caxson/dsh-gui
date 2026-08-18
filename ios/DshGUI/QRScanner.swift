import AVFoundation
import SwiftUI

/// Camera QR scanning, kept to the thinnest possible layer.
///
/// Everything that can be reasoned about — what a pairing link means, whether
/// one is valid — lives in `Pairing` and is tested there. This file only turns
/// camera frames into strings, because that part cannot be tested in a
/// simulator: there is no camera. Keeping it small keeps the untestable surface
/// small.
struct QRScannerView: UIViewControllerRepresentable {
    /// Called with each decoded string. Duplicates are already filtered out.
    let onScan: (String) -> Void
    /// Reported when the camera cannot be used at all, so the caller can offer
    /// the paste route instead of showing a black rectangle.
    let onUnavailable: (String) -> Void

    func makeUIViewController(context: Context) -> ScannerController {
        let controller = ScannerController()
        controller.onScan = onScan
        controller.onUnavailable = onUnavailable
        return controller
    }

    func updateUIViewController(_: ScannerController, context _: Context) {}

    /// `AVCaptureSession` is not Sendable, and `startRunning()` blocks — Apple's
    /// own guidance is to keep it off the main thread. This box carries it
    /// across that hop. Configuration happens on the main actor before start;
    /// the only calls made off it are start and stop, both serialised on this
    /// one queue. That discipline is what the `@unchecked` is asserting.
    private final class CameraBox: @unchecked Sendable {
        let session = AVCaptureSession()
        private let queue = DispatchQueue(label: "com.merefusion.dshgui.camera")

        func start() { queue.async { if !self.session.isRunning { self.session.startRunning() } } }
        func stop() { queue.async { if self.session.isRunning { self.session.stopRunning() } } }
    }

    final class ScannerController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
        var onScan: ((String) -> Void)?
        var onUnavailable: ((String) -> Void)?

        private let camera = CameraBox()
        private var session: AVCaptureSession { camera.session }
        private var preview: AVCaptureVideoPreviewLayer?
        private var lastScanned: String?

        override func viewDidLoad() {
            super.viewDidLoad()
            view.backgroundColor = .black
            configure()
        }

        private func configure() {
            guard let device = AVCaptureDevice.default(for: .video),
                  let input = try? AVCaptureDeviceInput(device: device),
                  session.canAddInput(input)
            else {
                onUnavailable?("这台设备上用不了相机——可以改用粘贴配对链接。")
                return
            }
            session.addInput(input)

            let output = AVCaptureMetadataOutput()
            guard session.canAddOutput(output) else {
                onUnavailable?("相机无法用于扫码——可以改用粘贴配对链接。")
                return
            }
            session.addOutput(output)
            output.setMetadataObjectsDelegate(self, queue: .main)
            output.metadataObjectTypes = [.qr]

            let layer = AVCaptureVideoPreviewLayer(session: session)
            layer.videoGravity = .resizeAspectFill
            layer.frame = view.bounds
            view.layer.addSublayer(layer)
            preview = layer

            camera.start()
        }

        override func viewDidLayoutSubviews() {
            super.viewDidLayoutSubviews()
            preview?.frame = view.bounds
        }

        override func viewDidDisappear(_ animated: Bool) {
            super.viewDidDisappear(animated)
            // The camera keeps running otherwise, with the indicator on and
            // nothing on screen to explain why.
            camera.stop()
        }

        // AVCaptureMetadataOutputObjectsDelegate predates strict concurrency, so
        // the conformance has to be nonisolated. The delegate queue is set to
        // `.main` above, which makes the assumption below true — and
        // assumeIsolated checks it at runtime rather than asking anyone to
        // trust that these two lines stay in agreement.
        nonisolated func metadataOutput(
            _: AVCaptureMetadataOutput,
            didOutput objects: [AVMetadataObject],
            from _: AVCaptureConnection
        ) {
            // Pull the string out here: the metadata objects are not Sendable
            // and must not be captured by the closure below. A String is.
            guard let object = objects.first as? AVMetadataMachineReadableCodeObject,
                  let value = object.stringValue
            else { return }
            MainActor.assumeIsolated {
                // A code stays in frame for many frames; without this the
                // handler fires dozens of times for one scan.
                guard value != lastScanned else { return }
                lastScanned = value
                onScan?(value)
            }
        }
    }
}
