package io.cyang.local801.engage;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.IntentSenderRequest;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.annotation.Nullable;
import androidx.appcompat.app.AppCompatActivity;
import com.google.mlkit.vision.documentscanner.GmsDocumentScannerOptions;
import com.google.mlkit.vision.documentscanner.GmsDocumentScanning;
import com.google.mlkit.vision.documentscanner.GmsDocumentScanningResult;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.util.Arrays;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

public final class Local801DocumentScannerActivity extends AppCompatActivity {
    static final String RESULT_TOKEN = "resultToken";
    private static final int MAX_BYTES = 8 * 1024 * 1024;
    private static final Map<String, byte[]> RESULTS = new ConcurrentHashMap<>();
    private ActivityResultLauncher<IntentSenderRequest> launcher;

    @Override protected void onCreate(@Nullable Bundle state) {
        super.onCreate(state);
        launcher = registerForActivityResult(new ActivityResultContracts.StartIntentSenderForResult(), result -> {
            if (result.getResultCode() != Activity.RESULT_OK) { setResult(Activity.RESULT_CANCELED); finish(); return; }
            GmsDocumentScanningResult scan = GmsDocumentScanningResult.fromActivityResultIntent(result.getData());
            if (scan == null || scan.getPdf() == null) { fail(); return; }
            try (InputStream input = getContentResolver().openInputStream(scan.getPdf().getUri()); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
                if (input == null) { fail(); return; }
                byte[] buffer = new byte[32 * 1024]; int read; int total = 0;
                while ((read = input.read(buffer)) >= 0) {
                    total += read; if (total > MAX_BYTES) { Arrays.fill(buffer, (byte) 0); fail(); return; }
                    output.write(buffer, 0, read);
                }
                Arrays.fill(buffer, (byte) 0);
                String token = UUID.randomUUID().toString(); RESULTS.put(token, output.toByteArray());
                new Handler(Looper.getMainLooper()).postDelayed(() -> { byte[] abandoned = RESULTS.remove(token); if (abandoned != null) Arrays.fill(abandoned, (byte) 0); }, 60_000L);
                setResult(Activity.RESULT_OK, new Intent().putExtra(RESULT_TOKEN, token)); finish();
            } catch (Exception ignored) { fail(); }
        });
        GmsDocumentScannerOptions options = new GmsDocumentScannerOptions.Builder()
            .setGalleryImportAllowed(false).setPageLimit(20)
            .setResultFormats(GmsDocumentScannerOptions.RESULT_FORMAT_PDF)
            .setScannerMode(GmsDocumentScannerOptions.SCANNER_MODE_FULL).build();
        GmsDocumentScanning.getClient(options).getStartScanIntent(this)
            .addOnSuccessListener(sender -> launcher.launch(new IntentSenderRequest.Builder(sender).build()))
            .addOnFailureListener(error -> fail());
    }

    private void fail() { setResult(Activity.RESULT_FIRST_USER); finish(); }
    static byte[] consume(String token) { return token == null ? null : RESULTS.remove(token); }
}
