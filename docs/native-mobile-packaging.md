# Native Mobile Packaging

Local 801 Engage now includes Capacitor 8 Android and iOS projects under `apps/local801-engage/android` and `apps/local801-engage/ios`. Both use the provisional immutable identifier `io.cyang.local801engage`, the Local 801 artwork, an HTTPS-only connection to `https://cat.cyang.io`, OS-verified links, and native lifecycle privacy handling. Android applies `FLAG_SECURE` to block screenshots, screen recording, and recent-app thumbnails. iOS covers the scene before it becomes inactive so the app switcher does not retain member data.

The server-rendered Next.js application cannot be copied into a static Capacitor bundle. The native projects therefore use the approved production origin as a remote WebView. Capacitor documents remote server URLs as a live-reload feature rather than a production default, and Apple requires an app to provide lasting, app-like value beyond a repackaged website. This architecture must receive an explicit mobile security/store review before release; the release gate records that approval rather than treating account ownership as technical acceptance.

## Commands

Run from `apps/local801-engage`:

- `npm run mobile:assets` regenerates PWA, iOS, and Android artwork.
- `npm run mobile:sync` copies the native fallback shell and plugin configuration into both projects.
- `npm run mobile:open:android` opens Android Studio after the Android toolchain is installed.
- `npm run mobile:open:ios` opens Xcode on macOS.
- `npm run mobile:release:gate` checks every coded and operational release interlock.
- `npm run mobile:build:android` produces an Android App Bundle only after the release gate passes.
- `npm run mobile:build:ios` performs the gated iOS build on macOS.

Capacitor 8 requires Node.js 22 or newer. Android builds additionally require Android Studio/JDK. iOS builds require macOS, Xcode 26 or newer, and the Xcode command-line tools.

## Domain Associations

The app serves fail-closed association documents at `/.well-known/apple-app-site-association` and `/.well-known/assetlinks.json`. They remain empty until `LOCAL801_APPLE_APP_ID_PREFIX` and `LOCAL801_ANDROID_APP_LINK_SHA256` contain valid public signing identifiers. Apple’s App ID prefix is recorded separately from `LOCAL801_APPLE_TEAM_ID` because older accounts can have different values. The Android manifest and iOS entitlements both claim only `cat.cyang.io`.

## Release Gates

Store release stays locked until all existing production gates pass and the following mobile-specific work is accepted:

- remote-WebView architecture and App Store minimum-functionality review;
- OIDC authorization-code flow with PKCE;
- Apple Universal Links and Android App Links on signed real-device builds;
- background privacy cover and sensitive-cache inspection on real devices;
- App Store privacy answers, Google Play Data safety answers, privacy policy, support URL, screenshots, descriptions, and age/content rating;
- a synthetic `example.test` reviewer account or approved fully featured demo mode;
- Apple signing/team configuration and Android upload/app-signing key configuration.

Set these deployment/build values only after the corresponding evidence exists:

```dotenv
LOCAL801_MOBILE_APP_URL=https://cat.cyang.io
LOCAL801_MOBILE_APP_STORE_RELEASE_ENABLED=0
LOCAL801_APPLE_TEAM_ID=
LOCAL801_APPLE_APP_ID_PREFIX=
LOCAL801_ANDROID_APP_LINK_SHA256=
LOCAL801_MOBILE_REMOTE_WEBVIEW_REVIEW_APPROVED=0
LOCAL801_MOBILE_OIDC_PKCE_VERIFIED=0
LOCAL801_MOBILE_UNIVERSAL_LINKS_VERIFIED=0
LOCAL801_MOBILE_REAL_DEVICE_VERIFIED=0
LOCAL801_MOBILE_PRIVACY_DISCLOSURES_APPROVED=0
LOCAL801_MOBILE_STORE_REVIEW_ACCOUNT_READY=0
```

Do not add passwords, signing keys, provisioning profiles, keystores, OIDC secrets, member data, or screenshots containing real records to the repository. Push, biometric unlock, passkeys, and device-secure token storage remain separate reviewed phases.
