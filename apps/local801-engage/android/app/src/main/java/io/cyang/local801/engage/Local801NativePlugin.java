package io.cyang.local801.engage;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.provider.CalendarContract;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import androidx.activity.result.ActivityResult;
import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;
import androidx.work.BackoffPolicy;
import androidx.work.Constraints;
import androidx.work.Data;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.WorkManager;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.play.core.integrity.IntegrityManagerFactory;
import com.google.android.play.core.integrity.IntegrityTokenRequest;
import com.google.mlkit.vision.barcode.common.Barcode;
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions;
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning;
import java.io.File;
import java.io.FileOutputStream;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.text.SimpleDateFormat;
import java.util.Arrays;
import java.util.Date;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

@CapacitorPlugin(name = "Local801Native")
public final class Local801NativePlugin extends Plugin {
    private static final int MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
    private static final String UPLOAD_KEY = "local801-transient-upload-v1";
    private static final String DEVICE_KEY = "local801-device-attestation-v1";

    @PluginMethod
    public void getCapabilities(PluginCall call) {
        JSObject result = new JSObject();
        result.put("platform", "android"); result.put("biometric", true); result.put("attestation", true);
        result.put("documentScanner", true); result.put("codeScanner", true); result.put("backgroundUpload", true);
        result.put("calendar", true); result.put("safeSummary", true); call.resolve(result);
    }

    @PluginMethod
    public void authenticate(PluginCall call) {
        int authenticators = BiometricManager.Authenticators.BIOMETRIC_STRONG | BiometricManager.Authenticators.DEVICE_CREDENTIAL;
        if (BiometricManager.from(getContext()).canAuthenticate(authenticators) != BiometricManager.BIOMETRIC_SUCCESS) {
            call.reject("Biometric or device-credential authentication is unavailable."); return;
        }
        getActivity().runOnUiThread(() -> new BiometricPrompt(getActivity(), ContextCompat.getMainExecutor(getContext()), new BiometricPrompt.AuthenticationCallback() {
            @Override public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult value) {
                JSObject result = new JSObject(); result.put("authenticated", true); call.resolve(result);
            }
            @Override public void onAuthenticationError(int code, CharSequence message) { call.reject("Authentication did not complete."); }
        }).authenticate(new BiometricPrompt.PromptInfo.Builder()
            .setTitle("Confirm sensitive action").setSubtitle(call.getString("reason", "Authenticate to continue"))
            .setAllowedAuthenticators(authenticators).build()));
    }

    @PluginMethod
    public void attest(PluginCall call) {
        String challenge = call.getString("challenge", "");
        String project = call.getString("androidCloudProjectNumber", "");
        if (!challenge.matches("[A-Za-z0-9_-]{43}") || !project.matches("[0-9]{6,20}")) { call.reject("The device challenge is invalid."); return; }
        try {
            long cloudProject = Long.parseLong(project);
            String keyId = devicePublicKey();
            IntegrityManagerFactory.create(getContext()).requestIntegrityToken(
                IntegrityTokenRequest.builder().setNonce(challenge).setCloudProjectNumber(cloudProject).build()
            ).addOnSuccessListener(response -> {
                JSObject value = new JSObject(); value.put("platform", "android"); value.put("evidence", response.token()); value.put("evidenceKind", "play_integrity"); value.put("keyId", keyId); call.resolve(value);
            }).addOnFailureListener(error -> call.reject("Google Play Integrity could not verify this installation."));
        } catch (Exception ignored) { call.reject("Device attestation is unavailable."); }
    }

    private String devicePublicKey() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
        if (!store.containsAlias(DEVICE_KEY)) {
            KeyPairGenerator generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore");
            generator.initialize(new KeyGenParameterSpec.Builder(DEVICE_KEY, KeyProperties.PURPOSE_SIGN)
                .setDigests(KeyProperties.DIGEST_SHA256).setUserAuthenticationRequired(false).build());
            generator.generateKeyPair();
        }
        return Base64.encodeToString(store.getCertificate(DEVICE_KEY).getPublicKey().getEncoded(), Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
    }

    @PluginMethod public void scanDocument(PluginCall call) {
        startActivityForResult(call, new Intent(getContext(), Local801DocumentScannerActivity.class), "documentScanned");
    }

    @ActivityCallback private void documentScanned(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) { call.reject("Document scanning was cancelled or unavailable."); return; }
        byte[] bytes = Local801DocumentScannerActivity.consume(result.getData().getStringExtra(Local801DocumentScannerActivity.RESULT_TOKEN));
        if (bytes == null || bytes.length == 0 || bytes.length > MAX_UPLOAD_BYTES) { call.reject("The scanned PDF is unavailable or exceeds the secure upload limit."); return; }
        JSObject value = new JSObject(); value.put("name", "Scanned document.pdf"); value.put("mediaType", "application/pdf");
        value.put("base64Data", Base64.encodeToString(bytes, Base64.NO_WRAP)); Arrays.fill(bytes, (byte) 0); call.resolve(value);
    }

    @PluginMethod public void scanCode(PluginCall call) {
        GmsBarcodeScannerOptions options = new GmsBarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).enableAutoZoom().build();
        GmsBarcodeScanning.getClient(getContext(), options).startScan().addOnSuccessListener(barcode -> {
            String raw = barcode.getRawValue();
            if (raw == null || raw.length() > 2048) { call.reject("The QR code is invalid."); return; }
            JSObject value = new JSObject(); value.put("value", raw); call.resolve(value);
        }).addOnCanceledListener(() -> call.reject("QR scanning was cancelled."))
          .addOnFailureListener(error -> call.reject("QR scanning is unavailable."));
    }

    @PluginMethod public void getPendingShare(PluginCall call) {
        MainActivity.SharedPdf shared = MainActivity.consumePendingShare(); JSObject value = new JSObject();
        if (shared == null) { value.put("source", "none"); call.resolve(value); return; }
        if (System.currentTimeMillis() - shared.receivedAt > 300_000L) { Arrays.fill(shared.bytes, (byte) 0); value.put("source", "none"); call.resolve(value); return; }
        value.put("source", "share"); value.put("name", shared.name); value.put("mediaType", "application/pdf");
        value.put("base64Data", Base64.encodeToString(shared.bytes, Base64.NO_WRAP)); Arrays.fill(shared.bytes, (byte) 0); call.resolve(value);
    }

    @PluginMethod public void queueBackgroundUpload(PluginCall call) {
        String encoded = call.getString("base64Data", "");
        String name = safeText(call.getString("name", ""), 255);
        String title = safeText(call.getString("title", ""), 255);
        String category = safeText(call.getString("category", ""), 100);
        String visibility = safeText(call.getString("visibility", ""), 64);
        if (name == null || !name.matches("[A-Za-z0-9][A-Za-z0-9 ._()\\-]{0,250}\\.pdf") || title == null || category == null || visibility == null) { call.reject("The upload details are invalid."); return; }
        byte[] content;
        try { content = Base64.decode(encoded, Base64.DEFAULT); } catch (Exception ignored) { call.reject("The temporary PDF is invalid."); return; }
        if (content.length < 1 || content.length > MAX_UPLOAD_BYTES) { Arrays.fill(content, (byte) 0); call.reject("The PDF exceeds the secure upload limit."); return; }
        try {
            File directory = new File(getContext().getNoBackupFilesDir(), "pending-uploads");
            if (!directory.exists() && !directory.mkdirs()) throw new IllegalStateException();
            File encrypted = new File(directory, UUID.randomUUID() + ".bin");
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, uploadKey());
            try (FileOutputStream output = new FileOutputStream(encrypted)) {
                byte[] iv = cipher.getIV(); output.write(iv.length); output.write(iv); output.write(cipher.doFinal(content));
            } finally { Arrays.fill(content, (byte) 0); }
            Data input = new Data.Builder().putString("path", encrypted.getAbsolutePath()).putString("name", name)
                .putString("title", title).putString("category", category).putString("visibility", visibility).build();
            OneTimeWorkRequest request = new OneTimeWorkRequest.Builder(Local801UploadWorker.class)
                .setInputData(input).setConstraints(new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS).addTag("local801-secure-upload").build();
            WorkManager.getInstance(getContext()).enqueue(request);
            JSObject value = new JSObject(); value.put("queued", true); call.resolve(value);
        } catch (Exception ignored) { Arrays.fill(content, (byte) 0); call.reject("The secure background upload could not be queued."); }
    }

    static SecretKey uploadKey() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
        if (!store.containsAlias(UPLOAD_KEY)) {
            KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            generator.init(new KeyGenParameterSpec.Builder(UPLOAD_KEY, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setRandomizedEncryptionRequired(true).build());
            generator.generateKey();
        }
        return ((KeyStore.SecretKeyEntry) store.getEntry(UPLOAD_KEY, null)).getSecretKey();
    }

    private String safeText(String value, int max) {
        if (value == null) return null; String trimmed = value.trim();
        return trimmed.isEmpty() || trimmed.length() > max || trimmed.matches(".*[\\r\\n\\u0000].*") ? null : trimmed;
    }

    @PluginMethod public void addCalendarReminder(PluginCall call) {
        String title = safeText(call.getString("title", ""), 100); String route = call.getString("route", ""); String startsAt = call.getString("startsAt", "");
        if (title == null || !route.matches("/[A-Za-z0-9?&=_/-]{1,200}")) { call.reject("The calendar reminder is invalid."); return; }
        try {
            SimpleDateFormat parser = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSSX", Locale.US); parser.setLenient(false);
            Date parsed = parser.parse(startsAt); if (parsed == null) throw new IllegalArgumentException(); long start = parsed.getTime();
            Intent intent = new Intent(Intent.ACTION_INSERT).setData(CalendarContract.Events.CONTENT_URI)
                .putExtra(CalendarContract.Events.TITLE, title).putExtra(CalendarContract.Events.DESCRIPTION, "Open https://cat.cyang.io" + route)
                .putExtra(CalendarContract.EXTRA_EVENT_BEGIN_TIME, start).putExtra(CalendarContract.EXTRA_EVENT_END_TIME, start + 30 * 60_000L);
            getActivity().startActivity(intent); JSObject value = new JSObject(); value.put("opened", true); call.resolve(value);
        } catch (Exception ignored) { call.reject("The device calendar could not be opened."); }
    }

    @PluginMethod public void updateSafeSummary(PluginCall call) {
        int urgent = Math.max(0, Math.min(999, call.getInt("urgentCount", 0))); int total = Math.max(0, Math.min(999, call.getInt("totalCount", 0)));
        Local801WorkWidget.updateAll(getContext(), urgent, total); Local801WorkWidget.updateShortcuts(getContext());
        JSObject value = new JSObject(); value.put("updated", true); call.resolve(value);
    }
}
