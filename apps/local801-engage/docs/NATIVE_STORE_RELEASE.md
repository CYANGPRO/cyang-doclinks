# Native store release runbook

## Release identity

- Product: Engaging Local 801
- Apple bundle ID: `io.cyang.local801.engage`
- Apple Team ID: `2U38UX2XKN`
- Android package: `io.cyang.local801.engage`
- Initial public version: `1.0` (`versionCode` / build `1`)
- Public privacy URL: `https://cat.cyang.io/legal/privacy`
- Public support URL: `https://cat.cyang.io/support`
- Apple distribution: request Unlisted App distribution after App Review approval
- Google distribution: standard Play listing protected by CAT + Entra access; use Managed Google Play only if Local 801 later adopts an EMM

Package names are permanent store identities. Do not create either store record under a different identifier.

## Security boundary

The native applications load only `https://cat.cyang.io` and the exact Microsoft Entra sign-in host. HTTPS is mandatory. Native-specific functions remain fail-closed until the owner-controlled attestation and push gateways are configured. The native shells must never persist protected member records for offline browsing.

Store screenshots, review accounts, fixtures, and test documents must use synthetic data. Never upload a real roster or member screenshot to App Store Connect, Play Console, CI artifacts, or this repository.

## Apple — first release

1. In Certificates, Identifiers & Profiles, register the explicit App ID `io.cyang.local801.engage`.
2. Enable Associated Domains, App Attest, and Push Notifications for the identifier.
3. Record the 10-character Apple Team ID in Production as `LOCAL801_APPLE_TEAM_ID`, redeploy, and verify `https://cat.cyang.io/.well-known/apple-app-site-association` returns the exact Team ID + bundle ID.
4. In App Store Connect, create the iOS app with name **Engaging Local 801**, primary language English (U.S.), bundle ID above, and an owner-controlled SKU such as `local801-engage-ios`.
5. On a trusted Mac with current Xcode, open `ios/App/App.xcodeproj`, select the **App** target, choose the Local 801 team, and leave automatic signing enabled.
6. Confirm Release entitlements show Production App Attest, Production APS, and `applinks:cat.cyang.io`.
7. Run `npm ci`, `npm run native:sync`, then select **Any iOS Device (arm64)** and use **Product → Archive**.
8. In Organizer, run **Validate App**, then **Distribute App → App Store Connect → Upload**. Do not use Development or Ad Hoc distribution for the store build.
9. In App Store Connect, use the repository text in `store/ios/en-US`, category **Business**, privacy URL above, support URL above, and synthetic iPhone/iPad screenshots.
10. Complete App Privacy consistently with `PrivacyInfo.xcprivacy`: app functionality collects linked identity/contact/member-sensitive/user-content/device/interaction data; limited diagnostics are not linked; no tracking; no advertising.
11. Provide a temporary reviewer account and a workable MFA method in the private App Review notes. Revoke it after review.
12. Submit for App Review and state that unlisted distribution is intended. After approval, submit Apple's Unlisted App request and retain the private download link as controlled operational information.

Apple signing certificates, API keys, reviewer credentials, and MFA recovery methods belong in the approved credential vault—not Git, Vercel logs, or issue trackers.

## Google Play — first release

1. In Play Console, create **Engaging Local 801** as an app, English (United States), app, free, and accept the required declarations. Use package `io.cyang.local801.engage`.
2. Enroll in Play App Signing and let Google generate/hold the app-signing key. Create a separate upload key on a trusted release workstation with JDK 21 or newer:

   ```bash
   keytool -genkeypair -v -keystore local801-engage-upload.jks -alias local801-upload -keyalg RSA -keysize 4096 -validity 10000
   ```

3. Escrow the keystore and passwords. Set all four `LOCAL801_ANDROID_UPLOAD_*` variables only in the trusted release shell or CI vault.
4. Add a Firebase Android app for `io.cyang.local801.engage`, enable FCM, and place the downloaded `google-services.json` in `android/app/` only through the approved secret/release process. Do not commit a production service-account key.
5. From Play Console **App integrity**, copy the SHA-256 fingerprint of the **App signing key certificate** into Production as `LOCAL801_ANDROID_APP_LINK_SHA256_CERT_FINGERPRINTS`, redeploy, and verify `https://cat.cyang.io/.well-known/assetlinks.json`.
6. With Android SDK 36 and JDK 21 installed, run `npm ci`, `npm run native:sync`, then `cd android && ./gradlew clean bundleRelease` (Git Bash) or `gradlew.bat clean bundleRelease` (PowerShell).
7. Upload `android/app/build/outputs/bundle/release/app-release.aab` to Internal testing first. Confirm Play App Signing recognizes the upload certificate.
8. Use the repository text in `store/android/en-US`, category **Business**, privacy URL above, support URL above, and synthetic phone/tablet screenshots.
9. Complete Data safety consistently with the public privacy notice and Apple declarations: encrypted in transit; no sale; no advertising/tracking; account identity/contact/sensitive membership/user content/device and app interactions used for app functionality; account access/deactivation handled by Local 801 administrators.
10. Complete target audience (organizational adults), content rating, ads (none), app access, and the reviewer instructions. Provide a temporary approved Entra/CAT reviewer account and revoke it after review.
11. Publish to Internal testing, then the required Closed testing or Production track based on the Play account's eligibility. The package targets API 36.

## Release gates

Before either submission:

- The web release gate and native GitHub validation workflow pass.
- The public Privacy, Support, AASA, and Asset Links URLs return expected Production responses.
- Microsoft Entra sign-in completes inside the native shell and returns to an active CAT session.
- No protected record is readable offline or embedded in notifications, widgets, shortcuts, calendar entries, crash reports, or store media.
- Camera, biometrics, calendar, notifications, upload cleanup, deep links, role restrictions, sign-out reset, and account revocation are tested on real devices.
- Attestation and push gateways are live, monitored, rate-limited, and tested before `LOCAL801_NATIVE_MOBILE_ENABLED=1`.
- Signed artifacts and store submissions are traceable to the accepted Git commit and version/build number.
