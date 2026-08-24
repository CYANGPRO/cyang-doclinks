package io.cyang.local801.engage;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ShortcutInfo;
import android.content.pm.ShortcutManager;
import android.graphics.drawable.Icon;
import android.net.Uri;
import android.widget.RemoteViews;
import java.util.Arrays;

public final class Local801WorkWidget extends AppWidgetProvider {
    private static final String PREFS = "local801-safe-summary";

    @Override public void onUpdate(Context context, AppWidgetManager manager, int[] ids) {
        int urgent = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getInt("urgent", 0);
        int total = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getInt("total", 0);
        for (int id : ids) manager.updateAppWidget(id, view(context, urgent, total));
    }

    static void updateAll(Context context, int urgent, int total) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putInt("urgent", urgent).putInt("total", total).apply();
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        int[] ids = manager.getAppWidgetIds(new ComponentName(context, Local801WorkWidget.class));
        for (int id : ids) manager.updateAppWidget(id, view(context, urgent, total));
    }

    private static RemoteViews view(Context context, int urgent, int total) {
        RemoteViews value = new RemoteViews(context.getPackageName(), R.layout.local801_work_widget);
        value.setTextViewText(R.id.widget_summary, urgent + " urgent · " + total + " total");
        Intent open = new Intent(context, MainActivity.class).setAction(Intent.ACTION_VIEW).setData(Uri.parse("https://cat.cyang.io/notifications"));
        value.setOnClickPendingIntent(R.id.widget_root, PendingIntent.getActivity(context, 801, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));
        return value;
    }

    static void updateShortcuts(Context context) {
        ShortcutManager manager = context.getSystemService(ShortcutManager.class); if (manager == null) return;
        ShortcutInfo inbox = shortcut(context, "work-inbox", "Work inbox", "/notifications");
        ShortcutInfo documents = shortcut(context, "document-intake", "Scan document", "/documents");
        manager.setDynamicShortcuts(Arrays.asList(inbox, documents));
    }

    private static ShortcutInfo shortcut(Context context, String id, String label, String route) {
        Intent intent = new Intent(context, MainActivity.class).setAction(Intent.ACTION_VIEW).setData(Uri.parse("https://cat.cyang.io" + route));
        return new ShortcutInfo.Builder(context, id).setShortLabel(label).setIcon(Icon.createWithResource(context, R.mipmap.ic_launcher)).setIntent(intent).build();
    }
}
