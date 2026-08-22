import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?
    private var privacyCover: UIView?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = CAPBridgeViewController()
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }

    func sceneWillResignActive(_ scene: UIScene) {
        guard privacyCover == nil, let window else { return }

        let cover = UIView(frame: window.bounds)
        cover.backgroundColor = UIColor(red: 19.0 / 255.0, green: 77.0 / 255.0, blue: 140.0 / 255.0, alpha: 1)
        cover.autoresizingMask = [.flexibleWidth, .flexibleHeight]

        let label = UILabel(frame: cover.bounds)
        label.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        label.text = "Local 801 Engage"
        label.textAlignment = .center
        label.textColor = .white
        label.font = .preferredFont(forTextStyle: .headline)
        cover.addSubview(label)

        window.addSubview(cover)
        privacyCover = cover
    }

    func sceneDidBecomeActive(_ scene: UIScene) {
        privacyCover?.removeFromSuperview()
        privacyCover = nil
    }
}
