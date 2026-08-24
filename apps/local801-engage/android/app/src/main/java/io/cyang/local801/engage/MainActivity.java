package io.cyang.local801.engage;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.provider.OpenableColumns;
import android.view.View;
import android.view.WindowManager;
import android.webkit.WebSettings;
import androidx.annotation.Nullable;
import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;
import com.getcapacitor.BridgeActivity;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.util.Arrays;

public class MainActivity extends BridgeActivity {
    private static final int MAX_SHARED_BYTES = 8 * 1024 * 1024;
    private static volatile SharedPdf pendingShare;
    private long unlockedAt;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(Local801NativePlugin.class);
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        getBridge().getWebView().getSettings().setCacheMode(WebSettings.LOAD_NO_CACHE);
        getBridge().getWebView().clearCache(true);
        captureShare(getIntent());
        if (pendingShare != null) getBridge().getWebView().loadUrl("https://cat.cyang.io/documents");
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        captureShare(intent);
        if (pendingShare != null) getBridge().getWebView().loadUrl("https://cat.cyang.io/documents");
    }

    @Override
    public void onStart() {
        super.onStart();
        if (System.currentTimeMillis() - unlockedAt > 120_000L) lockApplication();
    }

    private void lockApplication() {
        if (BiometricManager.from(this).canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG | BiometricManager.Authenticators.DEVICE_CREDENTIAL)
            != BiometricManager.BIOMETRIC_SUCCESS) { finishAndRemoveTask(); return; }
        getBridge().getWebView().setVisibility(View.INVISIBLE);
        BiometricPrompt prompt = new BiometricPrompt(this, ContextCompat.getMainExecutor(this), new BiometricPrompt.AuthenticationCallback() {
            @Override public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) {
                unlockedAt = System.currentTimeMillis();
                getBridge().getWebView().setVisibility(View.VISIBLE);
            }
            @Override public void onAuthenticationError(int code, CharSequence message) {
                finishAndRemoveTask();
            }
        });
        prompt.authenticate(new BiometricPrompt.PromptInfo.Builder()
            .setTitle("Unlock Engaging Local 801")
            .setSubtitle("Authenticate to access the signed application")
            .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG | BiometricManager.Authenticators.DEVICE_CREDENTIAL)
            .build());
    }

    private void captureShare(@Nullable Intent intent) {
        if (intent == null || !Intent.ACTION_SEND.equals(intent.getAction()) || !"application/pdf".equals(intent.getType())) return;
        Uri uri = intent.getParcelableExtra(Intent.EXTRA_STREAM);
        if (uri == null) return;
        try (InputStream input = getContentResolver().openInputStream(uri); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            if (input == null) return;
            byte[] buffer = new byte[32 * 1024]; int read; int total = 0;
            while ((read = input.read(buffer)) >= 0) {
                total += read; if (total > MAX_SHARED_BYTES) { Arrays.fill(buffer, (byte) 0); return; }
                output.write(buffer, 0, read);
            }
            Arrays.fill(buffer, (byte) 0);
            SharedPdf prior = pendingShare; if (prior != null) Arrays.fill(prior.bytes, (byte) 0);
            pendingShare = new SharedPdf(sharedName(uri), output.toByteArray());
        } catch (Exception ignored) { pendingShare = null; }
    }

    private String sharedName(Uri uri) {
        try (android.database.Cursor cursor = getContentResolver().query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                String name = cursor.getString(0);
                if (name != null && name.toLowerCase().endsWith(".pdf")) return name.substring(0, Math.min(name.length(), 255));
            }
        } catch (Exception ignored) {}
        return "Shared document.pdf";
    }

    static synchronized SharedPdf consumePendingShare() {
        SharedPdf value = pendingShare; pendingShare = null; return value;
    }

    static final class SharedPdf {
        final String name; final byte[] bytes; final long receivedAt;
        SharedPdf(String name, byte[] bytes) { this.name = name; this.bytes = bytes; this.receivedAt = System.currentTimeMillis(); }
    }

    @Override
    public void onStop() {
        getBridge().getWebView().clearCache(true);
        super.onStop();
    }
}
