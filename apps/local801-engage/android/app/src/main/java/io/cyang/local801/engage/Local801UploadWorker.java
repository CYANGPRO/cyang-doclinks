package io.cyang.local801.engage;

import android.content.Context;
import android.webkit.CookieManager;
import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;
import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import javax.crypto.Cipher;
import javax.crypto.CipherInputStream;
import javax.crypto.spec.GCMParameterSpec;

public final class Local801UploadWorker extends Worker {
    public Local801UploadWorker(@NonNull Context context, @NonNull WorkerParameters parameters) { super(context, parameters); }

    @NonNull @Override public Result doWork() {
        File encrypted = new File(value("path"));
        if (!encrypted.getAbsolutePath().startsWith(getApplicationContext().getNoBackupFilesDir().getAbsolutePath() + File.separator) || !encrypted.isFile()) return Result.failure();
        String cookie = CookieManager.getInstance().getCookie("https://cat.cyang.io");
        if (cookie == null || cookie.trim().isEmpty()) { encrypted.delete(); return Result.failure(); }
        String boundary = "Local801-" + java.util.UUID.randomUUID(); HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL("https://cat.cyang.io/api/documents/upload").openConnection();
            connection.setRequestMethod("POST"); connection.setDoOutput(true); connection.setConnectTimeout(15_000); connection.setReadTimeout(60_000);
            connection.setChunkedStreamingMode(32 * 1024); connection.setRequestProperty("Origin", "https://cat.cyang.io");
            connection.setRequestProperty("Cookie", cookie); connection.setRequestProperty("Content-Type", "multipart/form-data; boundary=" + boundary);
            try (OutputStream output = new BufferedOutputStream(connection.getOutputStream())) {
                field(output, boundary, "title", value("title")); field(output, boundary, "category", value("category")); field(output, boundary, "visibility", value("visibility"));
                write(output, "--" + boundary + "\r\nContent-Disposition: form-data; name=\"file\"; filename=\"" + value("name") + "\"\r\nContent-Type: application/pdf\r\n\r\n");
                try (FileInputStream source = new FileInputStream(encrypted)) {
                    int ivLength = source.read(); if (ivLength != 12) throw new IllegalStateException();
                    byte[] iv = new byte[ivLength]; int ivOffset = 0; int ivRead;
                    while (ivOffset < ivLength && (ivRead = source.read(iv, ivOffset, ivLength - ivOffset)) >= 0) ivOffset += ivRead;
                    if (ivOffset != ivLength) throw new IllegalStateException();
                    Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.DECRYPT_MODE, Local801NativePlugin.uploadKey(), new GCMParameterSpec(128, iv));
                    try (CipherInputStream clear = new CipherInputStream(source, cipher)) {
                        byte[] buffer = new byte[32 * 1024]; int read;
                        while ((read = clear.read(buffer)) >= 0) output.write(buffer, 0, read);
                        java.util.Arrays.fill(buffer, (byte) 0);
                    }
                }
                write(output, "\r\n--" + boundary + "--\r\n");
            }
            int status = connection.getResponseCode();
            if (status >= 200 && status < 300) { encrypted.delete(); return Result.success(); }
            if (status >= 400 && status < 500) { encrypted.delete(); return Result.failure(); }
        } catch (Exception ignored) {
            if (getRunAttemptCount() >= 4) { encrypted.delete(); return Result.failure(); }
        } finally { if (connection != null) connection.disconnect(); }
        return Result.retry();
    }

    private String value(String key) { String value = getInputData().getString(key); return value == null ? "" : value; }
    private static void write(OutputStream output, String value) throws Exception { output.write(value.getBytes(StandardCharsets.UTF_8)); }
    private static void field(OutputStream output, String boundary, String name, String value) throws Exception {
        write(output, "--" + boundary + "\r\nContent-Disposition: form-data; name=\"" + name + "\"\r\n\r\n" + value + "\r\n");
    }
}
