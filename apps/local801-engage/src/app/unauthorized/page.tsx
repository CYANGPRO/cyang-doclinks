import Link from "next/link";
import { AlertBanner, PageHeader } from "@/components/DesignSystem";

export default function UnauthorizedPage() {
  return (
    <div className="content">
      <PageHeader eyebrow="Access denied" title="This role cannot open that area" description="Page and API authorization is enforced on the server. Navigation visibility is only a convenience." />
      <AlertBanner title="No information was disclosed" tone="warning">Use an assigned role with the required permission or return to an authorized area.</AlertBanner>
      <div className="toolbar">
        <Link className="button" href="/">Return home</Link>
        <Link className="button secondary" href="/sign-in">Switch preview role</Link>
      </div>
    </div>
  );
}
