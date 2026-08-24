"use client";

import { LocalNotifications } from "@capacitor/local-notifications";
import { PushNotifications } from "@capacitor/push-notifications";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { isNativeMobile } from "@/lib/native-mobile";

async function remindLater() {
  await LocalNotifications.schedule({ notifications: [{
    id: Math.floor(Date.now() / 1000) % 2_147_483_647,
    title: "Local 801 work reminder",
    body: "Open the secure app to review your work.",
    actionTypeId: "LOCAL801_GENERIC_WORK",
    schedule: { at: new Date(Date.now() + 15 * 60_000), allowWhileIdle: false },
    extra: { route: "/notifications" },
  }] });
}

export function NativeNotificationRouter() {
  const router = useRouter();

  useEffect(() => {
    if (!isNativeMobile()) return;
    let active = true;
    const handles: Array<{ remove(): Promise<void> }> = [];
    const capture = (promise: Promise<{ remove(): Promise<void> }>) => {
      void promise.then((handle) => { if (active) handles.push(handle); else void handle.remove(); });
    };
    const act = (actionId: string) => {
      if (actionId === "later") void remindLater();
      else router.push("/notifications");
    };
    capture(LocalNotifications.addListener("localNotificationActionPerformed", (event) => act(event.actionId)));
    capture(PushNotifications.addListener("pushNotificationActionPerformed", (event) => act(event.actionId)));
    return () => { active = false; for (const handle of handles) void handle.remove(); };
  }, [router]);

  return null;
}

export const __testing = { remindLater };
