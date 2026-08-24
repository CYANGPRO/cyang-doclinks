"use client";

import { Capacitor, registerPlugin } from "@capacitor/core";

export type NativePlatform = "ios" | "android";
export type NativeCapabilities = Readonly<{
  platform: NativePlatform;
  biometric: boolean;
  attestation: boolean;
  documentScanner: boolean;
  codeScanner: boolean;
  backgroundUpload: boolean;
  calendar: boolean;
  safeSummary: boolean;
}>;

export type NativeDocument = Readonly<{
  name: string;
  mediaType: "application/pdf";
  base64Data: string;
}>;

export type PendingShare = NativeDocument & Readonly<{ source: "share" }>;

interface Local801NativePlugin {
  getCapabilities(): Promise<NativeCapabilities>;
  authenticate(options: { reason: string }): Promise<{ authenticated: true }>;
  attest(options: { challenge: string; androidCloudProjectNumber: string }): Promise<{
    platform: NativePlatform;
    evidence: string;
    keyId: string;
    evidenceKind: "app_attest" | "app_assertion" | "play_integrity";
  }>;
  scanDocument(): Promise<NativeDocument>;
  scanCode(): Promise<{ value: string }>;
  getPendingShare(): Promise<PendingShare | { source: "none" }>;
  queueBackgroundUpload(options: {
    base64Data: string;
    name: string;
    mediaType: string;
    title: string;
    category: string;
    visibility: string;
  }): Promise<{ queued: true }>;
  addCalendarReminder(options: { title: string; startsAt: string; route: string }): Promise<{ opened: true }>;
  updateSafeSummary(options: { urgentCount: number; totalCount: number }): Promise<{ updated: true }>;
}

const Local801Native = registerPlugin<Local801NativePlugin>("Local801Native");

export function isNativeMobile() {
  return Capacitor.isNativePlatform() && (Capacitor.getPlatform() === "ios" || Capacitor.getPlatform() === "android");
}

export function nativePlatform(): NativePlatform | null {
  const platform = Capacitor.getPlatform();
  return platform === "ios" || platform === "android" ? platform : null;
}

export { Local801Native };
