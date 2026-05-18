// app/layout.tsx
import type { Metadata } from "next";
import { StructuredData } from "./components/StructuredData";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "cyang.io",
    template: "%s · cyang.io",
  },
  description:
    "Premium secure workflow software by cyang.io, with Doclinks as the flagship and trust built into the public operating shell.",
  metadataBase: new URL("https://cyang.io"),
  openGraph: {
    title: "cyang.io",
    description:
      "Premium secure workflow software, disciplined product systems, and trust-centered public architecture.",
    url: "https://cyang.io",
    siteName: "cyang.io",
    type: "website",
    images: [
      {
        url: "/opengraph-image",
        width: 1200,
        height: 630,
        alt: "cyang.io Doclinks",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "cyang.io",
    description:
      "Premium secure workflow software by cyang.io.",
    images: ["/twitter-image"],
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="antialiased">
        <StructuredData
          data={[
            {
              "@context": "https://schema.org",
              "@type": "Organization",
              name: "cyang.io",
              url: "https://cyang.io",
              logo: "https://cyang.io/branding/cyang_primary.svg",
              contactPoint: [
                { "@type": "ContactPoint", contactType: "support", email: "support@cyang.io" },
                { "@type": "ContactPoint", contactType: "security", email: "security@cyang.io" },
                { "@type": "ContactPoint", contactType: "legal", email: "legal@cyang.io" },
              ],
            },
            {
              "@context": "https://schema.org",
              "@type": "WebSite",
              name: "cyang.io",
              url: "https://cyang.io",
            },
          ]}
        />
        {children}
      </body>
    </html>
  );
}
