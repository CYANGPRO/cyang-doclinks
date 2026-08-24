"use client";

import { LocalNotifications } from "@capacitor/local-notifications";
import { PushNotifications } from "@capacitor/push-notifications";
import { useEffect, useState } from "react";
import { AlertBanner, SectionCard } from "@/components/DesignSystem";
import { isNativeMobile, Local801Native, nativePlatform, type NativeCapabilities } from "@/lib/native-mobile";

async function postJson(path: string, body: Record<string, unknown>) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const value = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new Error(typeof value.message === "string" ? value.message : "The mobile request could not be completed.");
  return value;
}

export function MobileDeviceControl({ urgentCount, totalCount }: { urgentCount: number; totalCount: number }) {
  const [capabilities, setCapabilities] = useState<NativeCapabilities | null>(null);
  const [deviceHandle, setDeviceHandle] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!isNativeMobile()) return;
    void Local801Native.getCapabilities().then(setCapabilities).catch(() => setMessage("Native device controls are unavailable on this installation."));
  }, []);

  if (!capabilities) return null;

  async function run(label: string, action: () => Promise<string>) {
    setBusy(label); setMessage(null);
    try { setMessage(await action()); }
    catch (error) { setMessage(error instanceof Error ? error.message : "The mobile request could not be completed."); }
    finally { setBusy(null); }
  }

  async function verifyDevice() {
    const challenge = await postJson("/api/mobile/device/challenge", {});
    if (typeof challenge.challenge !== "string" || typeof challenge.challengeHandle !== "string"
      || typeof challenge.androidCloudProjectNumber !== "string") throw new Error("A device challenge could not be created.");
    const evidence = await Local801Native.attest({
      challenge: challenge.challenge,
      androidCloudProjectNumber: challenge.androidCloudProjectNumber,
    });
    const result = await postJson("/api/mobile/device/attest", {
      challengeHandle: challenge.challengeHandle,
      challenge: challenge.challenge,
      ...evidence,
    });
    if (typeof result.deviceHandle !== "string") throw new Error("The verified device handle was not returned.");
    setDeviceHandle(result.deviceHandle);
    return "This signed application and device were verified for the current session.";
  }

  async function enablePush() {
    if (!deviceHandle) throw new Error("Verify this installation before enabling notifications.");
    const permission = await PushNotifications.requestPermissions();
    if (permission.receive !== "granted") throw new Error("Notification permission was not granted.");
    const token = await new Promise<string>((resolve, reject) => {
      const registration = PushNotifications.addListener("registration", (value) => { void registration.then((handle) => handle.remove()); resolve(value.value); });
      const failure = PushNotifications.addListener("registrationError", () => { void failure.then((handle) => handle.remove()); reject(new Error("The device notification token could not be created.")); });
      void PushNotifications.register();
    });
    await postJson("/api/mobile/device/push", { deviceHandle, platform: nativePlatform(), token });
    return "Generic native work notifications are enabled. Notification text never contains member details.";
  }

  async function scheduleLocalReminder() {
    const permission = await LocalNotifications.requestPermissions();
    if (permission.display !== "granted") throw new Error("Notification permission was not granted.");
    await LocalNotifications.registerActionTypes({ types: [{ id: "LOCAL801_GENERIC_WORK", actions: [
      { id: "open", title: "Open work inbox" }, { id: "later", title: "Remind me later" },
    ] }] });
    await LocalNotifications.schedule({ notifications: [{
      id: Math.floor(Date.now() / 1000) % 2_147_483_647,
      title: "Local 801 work reminder",
      body: "Open the secure app to review your work.",
      actionTypeId: "LOCAL801_GENERIC_WORK",
      schedule: { at: new Date(Date.now() + 60_000), allowWhileIdle: false },
      extra: { route: "/notifications" },
    }] });
    return "A generic device reminder is scheduled for one minute from now.";
  }

  return <SectionCard
    title="Native device controls"
    description={deviceHandle
      ? "This signed device is verified for native notifications, biometric unlock, private reminders, and safe work-count widgets."
      : "Verify the signed iOS or Android app before enabling native notifications, biometric unlock, private reminders, or safe work-count widgets."}
  >
    <AlertBanner title="Protected records stay online">
      Biometric unlock protects the signed app. Widgets, calendars, and notification previews receive only generic counts and links—never member names, contact details, notes, or records.
    </AlertBanner>
    <div className="page-actions">
      <button className="button" type="button" disabled={Boolean(busy) || !capabilities?.attestation} onClick={() => void run("verify", verifyDevice)}>{busy === "verify" ? "Verifying…" : "Verify signed app & device"}</button>
      <button className="button secondary" type="button" disabled={Boolean(busy) || !capabilities?.biometric} onClick={() => void run("unlock", async () => { await Local801Native.authenticate({ reason: "Unlock Engaging Local 801" }); return "Biometric step-up succeeded."; })}>{busy === "unlock" ? "Checking…" : "Test biometric unlock"}</button>
      <button className="button secondary" type="button" disabled={Boolean(busy) || !deviceHandle} onClick={() => void run("push", enablePush)}>{busy === "push" ? "Registering…" : "Enable native notifications"}</button>
      <button className="button secondary" type="button" disabled={Boolean(busy)} onClick={() => void run("local", scheduleLocalReminder)}>Schedule private reminder</button>
      <button className="button secondary" type="button" disabled={Boolean(busy) || !capabilities?.calendar} onClick={() => void run("calendar", async () => { await Local801Native.addCalendarReminder({ title: "Review Local 801 work", startsAt: new Date(Date.now() + 3_600_000).toISOString(), route: "/notifications" }); return "The device calendar editor opened with a generic reminder."; })}>Add calendar reminder</button>
      <button className="button secondary" type="button" disabled={Boolean(busy) || !capabilities?.safeSummary} onClick={() => void run("summary", async () => { await Local801Native.updateSafeSummary({ urgentCount, totalCount }); return "The widget and app shortcuts were updated with generic work counts."; })}>Update safe widget</button>
    </div>
    {message ? <p className="form-message" role="status">{message}</p> : null}
  </SectionCard>;
}
