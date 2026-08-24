# Native iOS and Android applications

The `ios/` and `android/` projects are signed Capacitor applications for the canonical Engaging Local 801 HTTPS service. They intentionally share the server authorization model and do not introduce a native member-record database, file download cache, SQLite store, key-value mirror, or offline synchronization layer. Mobile product scope is feature-locked; only verified defect, security, accessibility, dependency, signing, store-review and release work may change it without a new owner-approved scope unlock.

## Included mobile package

- Apple App Attest and Google Play Integrity evidence is verified by the owner-controlled attestation gateway before a tenant/user device registration is created. One-time challenges expire after five minutes and only their SHA-256 digests are stored.
- Biometric/device-credential app lock hides the web view until unlock; an explicit biometric step-up is available for sensitive operator actions.
- iOS VisionKit and Android ML Kit capture PDFs in memory for review. QR intake opens only canonical `https://cat.cyang.io` destinations.
- Android PDF share intake and iOS registered PDF “Open in” intake hold a bounded file in process memory until the operator confirms or discards it.
- Confirmed uploads use Android Keystore AES-GCM plus WorkManager or iOS complete file protection plus a background URL session. Temporary files are excluded from backup and removed on success or terminal rejection. Every upload still passes the same-origin session, role, malware-scan, encrypted-storage and audit path as a web upload.
- APNs/FCM tokens are encrypted server-side. Native and local notification content is generic and routes back to the authenticated To Do page. No member detail is placed in the notification payload.
- Calendar entries, Android widgets, and iOS/Android shortcuts contain only generic task text, aggregate counts, and canonical application routes.

## Security contract

- `LOCAL801_NATIVE_SERVER_URL` must be a canonical HTTPS origin. Release builds default to `https://cat.cyang.io`.
- Mixed content and Android WebView debugging are disabled.
- Protected routes retain `private, no-store` response controls and require a live server session.
- The bundled `native-shell/index.html` contains only generic offline text. It contains no member, campaign, task, import, document, or user data.
- The service worker cache allowlist remains limited to icons and the generic offline page.
- Native filesystem, SQLite, secure-storage, preferences, and offline-sync JavaScript plugins are not installed. Custom native code may use only bounded transient capture/upload files and generic aggregate settings under the rules above.
- The initial Production release is responsive web/PWA only. App links/universal links, store signing, Apple/Google attestation enrollment, device push credentials, owner-controlled attestation/push gateways, and App Store/Play review are deferred post-launch operator work and do not block the web release.

## Required production configuration

Keep `LOCAL801_NATIVE_MOBILE_ENABLED=0` for the web/PWA release. If native distribution is enabled later, `LOCAL801_NATIVE_MOBILE_ENABLED=1` is accepted only when the attestation gateway is exactly `https://attest.cyang.io`, the push gateway is exactly `https://push.cyang.io`, both 32-byte HMAC secrets are configured as 64 lowercase hexadecimal characters, the Apple Team ID is valid, and the Android Cloud project number is valid. An enabled but incomplete native bundle fails closed.

The attestation gateway must validate the challenge-bound Apple App Attest attestation/assertion or Play Integrity token, the expected Apple application identifier or Android package/project, freshness, signing identity, app-recognition verdict, and device-integrity verdict. It returns only a stable device key and the accepted integrity level. The push gateway must map the generic `LOCAL801_GENERIC_WORK` category to APNs/FCM without adding protected content.

## Build

For the separately approved post-launch native release, run `npm run native:sync`, then `npm run native:open:android` on a configured Android workstation or `npm run native:open:ios` on macOS with Xcode. Android requires JDK 21 plus the Android 36 SDK; iOS requires macOS/Xcode and owner-controlled signing/capabilities. Use the production origin only. A native compile, physical-device attestation/push/share/scan/background-upload exercise, and store review will be required for that native release; they do not block the web/PWA launch or reopen feature scope.
