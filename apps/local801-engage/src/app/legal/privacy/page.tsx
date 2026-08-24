import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader, SectionCard } from "@/components/DesignSystem";

export const metadata: Metadata = {
  title: "Privacy Notice | Engaging Local 801",
  description: "Public privacy notice for the Engaging Local 801 website and mobile applications.",
};

export default function PublicPrivacyPage() {
  return <div className="content sign-in-content">
    <PageHeader
      eyebrow="Privacy notice"
      title="How Engaging Local 801 handles information"
      description="This notice applies to the Engaging Local 801 website and its iOS and Android applications. Last updated August 20, 2026."
    />
    <SectionCard title="Private, approval-only service" description="Engaging Local 801 is not a public registration service.">
      <p>Local 801 administrators approve accounts and assign roles. Microsoft Entra ID verifies identity and multi-factor authentication. CAT then enforces the active account, role, current session, and acceptance of the privacy and acceptable-use agreement.</p>
    </SectionCard>
    <SectionCard title="Information processed" description="The service uses only information needed for authorized Local 801 work.">
      <ul className="policy-list">
        <li>Account identity, verified email address, directory identifier, assigned role, sign-in status, and policy acceptance.</li>
        <li>Authorized membership and contact records, work assignments, outreach history, campaigns, reports, and audit events.</li>
        <li>Documents, document metadata, and camera scans a user deliberately selects for protected upload.</li>
        <li>Device attestation identifiers and push-notification tokens when native mobile features are enabled.</li>
        <li>Limited server-side diagnostics needed to keep the service reliable and investigate security events.</li>
      </ul>
    </SectionCard>
    <SectionCard title="Use, storage, and sharing" description="Information is used for Local 801 operations, security, and support—not advertising.">
      <ul className="policy-list">
        <li>Access is restricted by role and recorded in tamper-evident audit events.</li>
        <li>Protected data is encrypted in transit and at rest using owner-controlled application and storage controls.</li>
        <li>Service providers support identity, hosting, database, object storage, malware scanning, notifications, and restricted error monitoring under the organization’s configuration.</li>
        <li>The service does not sell personal information, run behavioral advertising, or permit cross-app tracking.</li>
        <li>Retention and deletion follow Local 801 operational, legal, security, and records requirements.</li>
      </ul>
    </SectionCard>
    <SectionCard title="Mobile privacy" description="Protected member records are not available for offline browsing.">
      <p>The mobile applications may use the camera for a user-requested document or QR scan, biometrics for local device confirmation, the calendar for a generic reminder, and notifications for generic work alerts. Temporary upload files are protected and removed after completion or failure. The application does not create a persistent offline store of protected member records.</p>
    </SectionCard>
    <SectionCard title="Choices and questions" description="Administrators can review account access and respond to privacy requests.">
      <p>Users may request correction of authorized records, notification preferences, account deactivation, or information about applicable retention by contacting Local 801 application support. Some records must be retained for legal, security, audit, or organizational requirements.</p>
      <div className="page-actions">
        <Link className="button" href="/support">Contact support</Link>
        <Link className="button secondary" href="/sign-in">Go to sign in</Link>
      </div>
    </SectionCard>
  </div>;
}
