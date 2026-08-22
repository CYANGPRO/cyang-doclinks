import type { Metadata, Viewport } from "next";
import "./globals.css";
import { AppShell } from "@/components/AppShell";
import { NativeRuntime } from "@/components/NativeRuntime";

export const metadata: Metadata = {
  title: "Local 801 Engage",
  description:
    "Private Local 801 membership, CAT engagement, campaign, document, reporting, and PWA application.",
  applicationName: "Local 801 Engage",
  appleWebApp: {
    capable: true,
    title: "801 Engage",
    statusBarStyle: "default",
  },
  icons: {
    icon: [
      { url: "/icons/local801-icon.svg", type: "image/svg+xml" },
      { url: "/icons/local801-192.png", type: "image/png", sizes: "192x192" },
    ],
    apple: [{ url: "/icons/apple-touch-icon.png", type: "image/png", sizes: "180x180" }],
  },
  robots: {
    index: false,
    follow: false,
    nocache: true,
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#134D8C",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <NativeRuntime />
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
