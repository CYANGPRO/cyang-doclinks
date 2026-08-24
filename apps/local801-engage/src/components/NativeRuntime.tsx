"use client";

import { useEffect } from "react";

const APPROVED_ORIGIN = "https://cat.cyang.io";

function nativeBridge() {
  return (window as Window & { Capacitor?: { getPlatform(): string; isNativePlatform(): boolean } }).Capacitor;
}

function approvedDeepLink(rawUrl: string) {
  try {
    const url = new URL(rawUrl);
    return url.origin === APPROVED_ORIGIN ? url : null;
  } catch {
    return null;
  }
}

export function NativeRuntime() {
  useEffect(() => {
    let active = true;
    let removeListeners: (() => Promise<void>) | undefined;

    void (async () => {
      const Capacitor = nativeBridge();
      if (!active || !Capacitor?.isNativePlatform()) return;
      const [{ App }, { SplashScreen }, { StatusBar, Style }] = await Promise.all([
        import("@capacitor/app"),
        import("@capacitor/splash-screen"),
        import("@capacitor/status-bar"),
      ]);
      if (!active) return;

      document.documentElement.dataset.nativeRuntime = Capacitor.getPlatform();
      void Promise.allSettled([
        StatusBar.setStyle({ style: Style.Light }),
        StatusBar.setBackgroundColor({ color: "#134D8C" }),
        SplashScreen.hide(),
      ]);

      const listeners = await Promise.all([
        App.addListener("appStateChange", ({ isActive }) => {
          document.documentElement.dataset.nativeAppState = isActive ? "active" : "background";
        }),
        App.addListener("appUrlOpen", ({ url }) => {
          const destination = approvedDeepLink(url);
          if (destination) window.location.assign(destination.toString());
        }),
      ]);
      removeListeners = async () => { await Promise.all(listeners.map((listener) => listener.remove())); };
      if (!active) await removeListeners();
    })();

    return () => {
      active = false;
      delete document.documentElement.dataset.nativeRuntime;
      delete document.documentElement.dataset.nativeAppState;
      void removeListeners?.();
    };
  }, []);

  return null;
}
