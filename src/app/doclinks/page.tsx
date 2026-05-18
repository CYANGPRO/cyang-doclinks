import type { Metadata } from "next";
import { StructuredData } from "../components/StructuredData";
import { DoclinksPageView } from "../components/DoclinksPageView";
import { SiteShell } from "../components/SiteShell";
import { getPublicRuntimeConfig } from "@/lib/publicRuntimeConfig";

export const revalidate = 900;

export const metadata: Metadata = {
  title: "Doclinks - cyang.io",
  description:
    "Doclinks helps teams securely share sensitive documents with protected links, access controls, lifecycle limits, and visibility after send.",
  alternates: {
    canonical: "/doclinks",
  },
};

export default function DoclinksPage() {
  const publicConfig = getPublicRuntimeConfig();

  return (
    <SiteShell maxWidth="full" publicConfig={publicConfig}>
      <StructuredData
        data={{
          "@context": "https://schema.org",
          "@type": "SoftwareApplication",
          name: "Doclinks",
          applicationCategory: "BusinessApplication",
          operatingSystem: "Web",
          url: "https://cyang.io/doclinks",
          description:
            "Secure document sharing with protected links, sender controls, and trust-centered public review surfaces.",
          brand: {
            "@type": "Brand",
            name: "cyang.io",
          },
        }}
      />
      <DoclinksPageView publicConfig={publicConfig} />
    </SiteShell>
  );
}
