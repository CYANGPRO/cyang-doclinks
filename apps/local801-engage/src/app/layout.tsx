import type { Metadata, Viewport } from "next";
import "./globals.css";
import "./stage16.css";
import "./stage16-components.css";
import "./stage17.css";
import "./stage17-redesign.css";
import "./stage18.css";
import { AppShell } from "@/components/AppShell";
import { GlobalErrorExperience } from "@/components/GlobalErrorExperience";
import { NativeRuntime } from "@/components/NativeRuntime";

export const metadata: Metadata = {
  title: "Engaging Local 801",
  description:
    "Private workspace for Local 801 membership, member engagement, campaigns, documents, reporting, and CAT work.",
  applicationName: "Engaging Local 801",
  appleWebApp: {
    capable: true,
    title: "Engaging 801",
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
        <GlobalErrorExperience />
      </body>
    </html>
  );
}
