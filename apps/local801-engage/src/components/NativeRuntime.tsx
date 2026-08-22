"use client";

import { useEffect } from "react";
import { App } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import { SplashScreen } from "@capacitor/splash-screen";
import { StatusBar, Style } from "@capacitor/status-bar";

const APPROVED_ORIGIN = "https://cat.cyang.io";

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
    if (!Capacitor.isNativePlatform()) return;

    document.documentElement.dataset.nativeRuntime = Capacitor.getPlatform();

    void Promise.allSettled([
      StatusBar.setStyle({ style: Style.Light }),
      StatusBar.setBackgroundColor({ color: "#134D8C" }),
      SplashScreen.hide(),
    ]);

    const listeners = [
      App.addListener("appStateChange", ({ isActive }) => {
        document.documentElement.dataset.nativeAppState = isActive ? "active" : "background";
      }),
      App.addListener("appUrlOpen", ({ url }) => {
        const destination = approvedDeepLink(url);
        if (destination) window.location.assign(destination.toString());
      }),
    ];

    return () => {
      delete document.documentElement.dataset.nativeRuntime;
      delete document.documentElement.dataset.nativeAppState;
      void Promise.all(listeners.map(async (listener) => (await listener).remove()));
    };
  }, []);

  return null;
}
