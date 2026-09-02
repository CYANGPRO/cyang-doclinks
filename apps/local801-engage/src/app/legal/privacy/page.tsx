import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader, SectionCard } from "@/components/DesignSystem";
import { MAPE_DATA_PRIVACY_POLICY } from "@/lib/policy-contract";

export const metadata: Metadata = {
  title: "Privacy Notice | Engaging Local 801",
  description: "Public privacy notice for the Engaging Local 801 website and mobile applications.",
};

export default function PublicPrivacyPage() {
  return <div className="content sign-in-content">
    <PageHeader
      eyebrow="Privacy notice"
      title="How Engaging Local 801 handles information"
      description="This notice applies to the Engaging Local 801 website and its iOS and Android applications. Last updated September 2, 2026."
    />
    <SectionCard title="A private service for approved users" description="Engaging Local 801 does not offer public sign-up.">
      <p>Local 801 administrators approve accounts and assign roles. Microsoft Entra ID verifies identity and MFA. CAT then checks that the account is active, has one role, has a current session, and has separately acknowledged both the CAT privacy and acceptable-use policy and MAPE&apos;s Data Privacy Agreement.</p>
    </SectionCard>
    <SectionCard title="MAPE Data Privacy Agreement" description="This is a separate required acknowledgement before accessing CAT.">
      <p><strong>You must follow MAPE&apos;s Data Privacy Agreement to safeguard member and employee data.</strong></p>
      <p>
        Review and complete the{" "}
        <a href={MAPE_DATA_PRIVACY_POLICY.url} rel="noopener noreferrer" target="_blank">
          MAPE Data Privacy Agreement Form
        </a>.
      </p>
    </SectionCard>
    <SectionCard title="Information CAT uses" description="CAT uses information needed for approved Local 801 work, security, and support.">
      <ul className="policy-list">
        <li>Account identity, verified email address, directory identifier, assigned role, sign-in status, and policy acceptance.</li>
        <li>Authorized membership and contact records, work assignments, outreach history, campaigns, reports, and audit events.</li>
        <li>Documents, details about those documents, and camera scans a user chooses to upload.</li>
        <li>Device-verification identifiers and push-notification tokens when mobile features are turned on.</li>
        <li>Limited technical diagnostics used to keep CAT reliable and investigate security events.</li>
      </ul>
    </SectionCard>
    <SectionCard title="Use, storage, and sharing" description="Information is used for Local 801 operations, security, and support—not advertising.">
      <ul className="policy-list">
        <li>Access is limited by role, and important activity is recorded in security audit records.</li>
        <li>Protected data is encrypted while it moves and while it is stored.</li>
        <li>Approved providers support identity, hosting, database and file storage, malware scanning, notifications, and limited error monitoring.</li>
        <li>The service does not sell personal information, run behavioral advertising, or permit cross-app tracking.</li>
        <li>Retention and deletion follow Local 801 operational, legal, security, and records requirements.</li>
      </ul>
    </SectionCard>
    <SectionCard title="Mobile privacy" description="Protected member records are not available for offline browsing.">
      <p>The mobile apps may use the camera when a user chooses to scan a document or QR code, biometrics to confirm the local device, the calendar for a generic reminder, and notifications for generic work alerts. Temporary upload files are protected and removed after the upload finishes or fails. The app does not keep a permanent offline copy of protected member records.</p>
    </SectionCard>
    <SectionCard title="Choices and questions" description="Administrators can review account access and respond to privacy requests.">
      <p>Users may ask to correct records they are allowed to see, change notification preferences, deactivate an account, or learn how long applicable information is kept. Contact Local 801 application support. Some records must be retained for legal, security, audit, or organizational requirements.</p>
      <div className="page-actions">
        <Link className="button" href="/support">Contact support</Link>
        <Link className="button secondary" href="/sign-in">Go to sign in</Link>
      </div>
    </SectionCard>
  </div>;
}
