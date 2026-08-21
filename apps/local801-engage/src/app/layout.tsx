import type { Metadata, Viewport } from "next";
import "./globals.css";
import { AppShell } from "@/components/AppShell";

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
    icon: "/icons/local801-icon.svg",
    apple: "/icons/apple-touch-icon.svg",
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
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
