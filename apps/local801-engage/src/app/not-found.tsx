import Link from "next/link";
import { PageHeader, SectionCard, UnavailableState } from "@/components/DesignSystem";

export default function NotFoundPage() {
  return (
    <div className="content">
      <PageHeader eyebrow="Page not found" title="We couldn’t find that page" description="The link may be incomplete, out of date, or for a page that has moved." />
      <SectionCard>
        <UnavailableState
          title="There’s nothing to show at this address"
          description="Go home and use the navigation available to your role. If someone sent you this link, ask them to check that it is complete and still current."
          action={<Link className="button" href="/">Go home</Link>}
        />
      </SectionCard>
      <SectionCard title="Why this can happen" description="A link can stop working even when your CAT account is fine">
        <ul className="sign-in-help-list">
          <li>The link was copied incompletely or points to an item that no longer exists.</li>
          <li>The workflow moved to a different page after an update.</li>
          <li>Your assigned role uses a different workspace area.</li>
        </ul>
      </SectionCard>
    </div>
  );
}
