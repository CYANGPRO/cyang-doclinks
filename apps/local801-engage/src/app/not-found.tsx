import Link from "next/link";
import { PageHeader } from "@/components/DesignSystem";

export default function NotFoundPage() {
  return (
    <div className="content">
      <PageHeader eyebrow="Not found" title="That page was not found" description="Check the address or return to the Local 801 dashboard." />
      <div className="toolbar">
        <Link className="button" href="/">
          Home
        </Link>
      </div>
    </div>
  );
}
