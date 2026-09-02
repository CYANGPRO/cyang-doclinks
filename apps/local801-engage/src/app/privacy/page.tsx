import { redirect } from "next/navigation";
import { AlertBanner, PageHeader, SectionCard } from "@/components/DesignSystem";
import { getPolicyAcknowledgementUser, getPreviewUser } from "@/lib/authz.server";
import { CURRENT_ACCESS_POLICY, MAPE_DATA_PRIVACY_POLICY } from "@/lib/policy-contract";
import { safePolicyReturnPath } from "@/lib/policy-return-path";
import { acknowledgePrivacyAndAcceptableUse } from "./actions";

const errorMessages = {
  required: "You must separately confirm both the CAT privacy and acceptable-use policy and MAPE's Data Privacy Agreement before continuing.",
  unavailable: "The acknowledgment could not be recorded. No access was granted. Please try again or contact an administrator.",
} as const;

export default async function PrivacyAcknowledgementPage({
  searchParams,
}: {
  searchParams?: Promise<{ next?: string; error?: string }>;
}) {
  const input = await searchParams;
  const nextPath = safePolicyReturnPath(input?.next);
  const pendingUser = await getPolicyAcknowledgementUser();
  if (!pendingUser) {
    if (await getPreviewUser()) redirect(nextPath);
    redirect(`/sign-in?next=${encodeURIComponent(nextPath)}`);
  }
  const error = input?.error === "required" || input?.error === "unavailable" ? input.error : null;

  return <div className="content sign-in-content policy-acknowledgement-page">
    <PageHeader
      eyebrow="Required before access"
      title={CURRENT_ACCESS_POLICY.title}
      description="Review and acknowledge these requirements before opening the Local 801 workspace."
    />
    {error ? <AlertBanner title="Acknowledgment required" tone="warning">{errorMessages[error]}</AlertBanner> : null}
    <SectionCard
      title="How this workspace must be used"
      description={`Acknowledge policy version ${CURRENT_ACCESS_POLICY.version} to continue into the workspace.`}
    >
      <ul className="policy-list">
        <li>Use member information only for authorized Local 801 membership, representation, organizing, and CAT work.</li>
        <li>Access is role-based and activity is logged for security, accountability, and incident review.</li>
        <li>Do not share protected records with unauthorized people or move them into personal email, chat, cloud drives, screenshots, or unapproved files.</li>
        <li>Use downloads and exports only when your role authorizes them and store them only in approved protected locations.</li>
        <li>Report suspected loss, disclosure, incorrect access, or account compromise immediately.</li>
        <li>Do not store or synchronize protected member records for offline use. Only generic static app content may be available offline.</li>
      </ul>
      <form action={acknowledgePrivacyAndAcceptableUse} className="policy-form">
        <input name="next" type="hidden" value={nextPath} />
        <label className="policy-confirmation">
          <input name="acceptedCatPolicy" required type="checkbox" value="yes" />
          <span>I understand and agree to follow this privacy and acceptable-use policy.</span>
        </label>
        <div className="policy-external-agreement">
          <p><strong>You must follow MAPE&apos;s Data Privacy Agreement to safeguard member and employee data.</strong></p>
          <p>
            Review and complete the{" "}
            <a href={MAPE_DATA_PRIVACY_POLICY.url} rel="noopener noreferrer" target="_blank">
              MAPE Data Privacy Agreement Form
            </a>.
          </p>
          <label className="policy-confirmation">
            <input name="acceptedMapePolicy" required type="checkbox" value="yes" />
            <span>I separately acknowledge that I must follow MAPE&apos;s Data Privacy Agreement to safeguard member and employee data.</span>
          </label>
        </div>
        <button className="button" type="submit">Acknowledge and continue</button>
      </form>
    </SectionCard>
  </div>;
}
