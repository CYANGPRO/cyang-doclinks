import type { Metadata } from "next";
import Link from "next/link";
import { AlertBanner, PageHeader, SectionCard } from "@/components/DesignSystem";

export const metadata: Metadata = {
  title: "Support | Engaging Local 801",
  description: "Account, access, privacy, and mobile application support for Engaging Local 801.",
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function SupportPage() {
  const configuredEmail = process.env.LOCAL801_ACCESS_SUPPORT_EMAIL?.trim() || "";
  const supportEmail = EMAIL.test(configuredEmail) && !configuredEmail.endsWith("@example.test")
    ? configuredEmail
    : null;

  return <div className="content sign-in-content">
    <PageHeader
      eyebrow="Engaging Local 801"
      title="Application support"
      description="Get help with an approved account, Microsoft Entra sign-in, MFA, an assigned role, or the iOS and Android applications."
    />
    <AlertBanner title="Never send credentials or member records" tone="warning">
      Support will never ask for your password, MFA code, recovery code, client secret, encryption key, or a screenshot containing protected member information.
    </AlertBanner>
    <SectionCard title="Before contacting support" description="These steps resolve most access problems without sharing protected information.">
      <ol className="step-list">
        <li>Use the exact Microsoft account named in your Local 801 invitation.</li>
        <li>On the sign-in page, choose <strong>Sign out and reset sign-in</strong>, then complete Microsoft MFA in the same window.</li>
        <li>Confirm with a Local 801 administrator that your CAT account is active and has one assigned role.</li>
        <li>Record only the non-sensitive support reference displayed by the application.</li>
      </ol>
    </SectionCard>
    <SectionCard title="Contact" description="Include the device type, operating-system version, time of the problem, and any non-sensitive support reference.">
      {supportEmail
        ? <p><a className="button" href={`mailto:${supportEmail}?subject=Engaging%20Local%20801%20support`}>Email application support</a></p>
        : <p>Contact the Local 801 administrator named in your invitation.</p>}
      <p className="muted">Do not attach a member roster, protected document, member contact information, password, MFA code, or recovery code.</p>
    </SectionCard>
    <div className="page-actions">
      <Link className="button" href="/sign-in">Go to sign in</Link>
      <Link className="button secondary" href="/legal/privacy">Read the privacy notice</Link>
    </div>
  </div>;
}
