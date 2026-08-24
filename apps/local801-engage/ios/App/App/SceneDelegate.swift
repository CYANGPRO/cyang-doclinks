import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?
    private let privacyCoverTag = 80120

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = Local801BridgeViewController()
        window?.makeKeyAndVisible()

        for context in connectionOptions.urlContexts {
            open(context.url)
        }
        for userActivity in connectionOptions.userActivities {
            continueActivity(userActivity)
        }
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        for context in URLContexts {
            open(context.url)
        }
    }

    func sceneWillEnterForeground(_ scene: UIScene) {
        (window?.rootViewController as? Local801BridgeViewController)?.requireUnlock()
    }

    func sceneWillResignActive(_ scene: UIScene) {
        guard let window, window.viewWithTag(privacyCoverTag) == nil else { return }
        let cover = UIView(frame: window.bounds); cover.tag = privacyCoverTag; cover.backgroundColor = UIColor(red: 20 / 255, green: 45 / 255, blue: 76 / 255, alpha: 1)
        cover.autoresizingMask = [.flexibleWidth, .flexibleHeight]; window.addSubview(cover)
    }

    func sceneDidBecomeActive(_ scene: UIScene) {
        window?.viewWithTag(privacyCoverTag)?.removeFromSuperview()
        (window?.rootViewController as? Local801BridgeViewController)?.requireUnlock()
    }

    func windowScene(_ windowScene: UIWindowScene, performActionFor shortcutItem: UIApplicationShortcutItem, completionHandler: @escaping (Bool) -> Void) {
        let route = shortcutItem.type == "io.cyang.local801.work" ? "/notifications" : shortcutItem.type == "io.cyang.local801.documents" ? "/documents" : nil
        guard let route, let controller = window?.rootViewController as? Local801BridgeViewController,
              let url = URL(string: "https://cat.cyang.io" + route) else { completionHandler(false); return }
        controller.webView?.load(URLRequest(url: url)); completionHandler(true)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        continueActivity(userActivity)
    }

    private func open(_ url: URL) {
        if url.pathExtension.lowercased() == "pdf" {
            Local801BridgeViewController.receivePdf(url: url)
            return
        }
        _ = ApplicationDelegateProxy.shared.application(UIApplication.shared, open: url)
    }

    private func continueActivity(_ userActivity: NSUserActivity) {
        _ = ApplicationDelegateProxy.shared.application(
            UIApplication.shared,
            continue: userActivity,
            restorationHandler: { _ in }
        )
    }
}
