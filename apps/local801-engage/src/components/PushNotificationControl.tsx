"use client";

import { useEffect, useState } from "react";

function applicationServerKey(value: string) {
  const padding = "=".repeat((4 - value.length % 4) % 4);
  const binary = window.atob((value + padding).replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function request(url: string, method: "PUT" | "DELETE" | "POST", body?: Record<string, unknown>) {
  const response = await fetch(url, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
  const payload = await response.json().catch(() => ({})) as { message?: string; delivered?: number };
  if (!response.ok) throw new Error(payload.message || "Browser notifications could not be updated.");
  return payload;
}

export function PushNotificationControl({ enabled, publicKey }: { enabled: boolean; publicKey: string }) {
  const [supported, setSupported] = useState<boolean | null>(null);
  const [subscribed, setSubscribed] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    const capable = enabled && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
    if (!capable) {
      const unsupported = window.setTimeout(() => setSupported(false), 0);
      return () => window.clearTimeout(unsupported);
    }
    void navigator.serviceWorker.ready
      .then((registration) => registration.pushManager.getSubscription())
      .then((subscription) => { setSupported(true); setSubscribed(Boolean(subscription)); })
      .catch(() => setSupported(false));
  }, [enabled]);

  async function subscribe() {
    setPending(true); setMessage("");
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") throw new Error("Notification permission was not granted in this browser.");
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: applicationServerKey(publicKey) });
      await request("/api/work-preferences/push", "PUT", { subscription: subscription.toJSON() });
      setSubscribed(true); setMessage("Browser notifications are enabled on this device.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Browser notifications could not be enabled."); }
    finally { setPending(false); }
  }
  async function unsubscribe() {
    setPending(true); setMessage("");
    try {
      const registration = await navigator.serviceWorker.ready; const subscription = await registration.pushManager.getSubscription();
      if (subscription) { await request("/api/work-preferences/push", "DELETE", { subscription: subscription.toJSON() }); await subscription.unsubscribe(); }
      setSubscribed(false); setMessage("Browser notifications are disabled on this device.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Browser notifications could not be disabled."); }
    finally { setPending(false); }
  }
  async function test() {
    setPending(true); setMessage("");
    try { const result = await request("/api/work-preferences/push/test", "POST"); setMessage(result.delivered ? "A generic test notification was sent." : "No active device subscription accepted the test notification."); }
    catch (error) { setMessage(error instanceof Error ? error.message : "The test notification could not be sent."); }
    finally { setPending(false); }
  }

  if (!enabled) return <p className="muted">Browser push is installed but remains deployment-locked until owner-controlled VAPID keys are configured.</p>;
  if (supported === false) return <p className="muted">This browser or device does not support secure web push.</p>;
  if (supported === null) return <p className="muted">Checking browser notification support…</p>;
  return <div className="grid"><p className="muted">Push messages are deliberately generic. Protected names, contact details, member records, task titles, and document metadata are never included.</p><div className="page-actions">{subscribed ? <><button className="button" disabled={pending} onClick={() => void test()} type="button">Send test</button><button className="button secondary" disabled={pending} onClick={() => void unsubscribe()} type="button">Disable on this device</button></> : <button className="button" disabled={pending} onClick={() => void subscribe()} type="button">Enable on this device</button>}</div>{message ? <p className="form-message" role="status">{message}</p> : null}</div>;
}
