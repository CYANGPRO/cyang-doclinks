import Link from "next/link";
import { PageHeader, SectionCard, UnavailableState } from "@/components/DesignSystem";

export default function NotFoundPage() {
  return (
    <div className="content">
      <PageHeader eyebrow="Page not found" title="We couldn’t find that page" description="The address may be old, incomplete, or no longer part of the workspace. A missing page does not expose protected information." />
      <SectionCard>
        <UnavailableState
          title="There’s nothing to show at this address"
          description="Return home and use the navigation shown for your assigned role. If a coworker sent this link, confirm that it is complete and intended for your role."
          action={<Link className="button" href="/">Go home</Link>}
        />
      </SectionCard>
      <SectionCard title="Why this can happen" description="The workspace uses safe, role-based routes">
        <ul className="sign-in-help-list">
          <li>The link was copied incompletely or points to an item that no longer exists.</li>
          <li>The workflow moved to a different page after an update.</li>
          <li>Your assigned role uses a different workspace area.</li>
        </ul>
      </SectionCard>
    </div>
  );
}
