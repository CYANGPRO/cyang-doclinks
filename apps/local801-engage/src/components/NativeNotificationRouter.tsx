"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

async function remindLater() {
  const { LocalNotifications } = await import("@capacitor/local-notifications");
  await LocalNotifications.schedule({ notifications: [{
    id: Math.floor(Date.now() / 1000) % 2_147_483_647,
    title: "Local 801 work reminder",
    body: "Open the secure app to review your work.",
    actionTypeId: "LOCAL801_GENERIC_WORK",
    schedule: { at: new Date(Date.now() + 15 * 60_000), allowWhileIdle: false },
    extra: { route: "/notifications" },
  }] });
}

function nativeBridge() {
  return (window as Window & { Capacitor?: { getPlatform(): string; isNativePlatform(): boolean } }).Capacitor;
}

export function NativeNotificationRouter() {
  const router = useRouter();

  useEffect(() => {
    let active = true;
    const handles: Array<{ remove(): Promise<void> }> = [];
    const capture = (promise: Promise<{ remove(): Promise<void> }>) => {
      void promise.then((handle) => { if (active) handles.push(handle); else void handle.remove(); });
    };
    const act = (actionId: string) => {
      if (actionId === "later") void remindLater();
      else router.push("/notifications");
    };
    void (async () => {
      const Capacitor = nativeBridge();
      if (!active || !Capacitor?.isNativePlatform()) return;
      const [{ LocalNotifications }, { PushNotifications }] = await Promise.all([
        import("@capacitor/local-notifications"),
        import("@capacitor/push-notifications"),
      ]);
      if (!active) return;
      const platform = Capacitor.getPlatform();
      if (platform !== "ios" && platform !== "android") return;
      capture(LocalNotifications.addListener("localNotificationActionPerformed", (event) => act(event.actionId)));
      capture(PushNotifications.addListener("pushNotificationActionPerformed", (event) => act(event.actionId)));
    })();
    return () => { active = false; for (const handle of handles) void handle.remove(); };
  }, [router]);

  return null;
}

export const __testing = { remindLater };
