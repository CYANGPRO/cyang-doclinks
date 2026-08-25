import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader, SectionCard } from "@/components/DesignSystem";

export const metadata: Metadata = {
  title: "Accessibility | Engaging Local 801",
  description: "Accessibility support and feedback information for Engaging Local 801.",
};

export default function AccessibilityPage() {
  return <div className="content sign-in-content">
    <PageHeader
      eyebrow="Accessibility"
      title="Access that works across devices and abilities"
      description="Engaging Local 801 is designed to support keyboard, touch, assistive-technology, and responsive use. Last updated August 25, 2026."
    />
    <SectionCard title="Current accessibility support" description="The service is built around clear structure and adaptable controls.">
      <ul className="policy-list">
        <li>Keyboard-accessible navigation, forms, dialogs, tables, and visible focus indicators.</li>
        <li>A skip link, semantic headings, labeled controls, status messages, and descriptive page titles.</li>
        <li>Responsive layouts and mobile field views that avoid unnecessary horizontal scrolling.</li>
        <li>Support for text resizing, high-contrast preferences, reduced motion, and coarse-pointer touch targets.</li>
      </ul>
    </SectionCard>
    <SectionCard title="Report an accessibility barrier" description="Useful feedback helps us reproduce and correct the problem.">
      <p>Contact application support with the page or feature, device and browser, assistive technology if applicable, and a description of what you expected to happen. Do not include a member roster, protected contact information, password, MFA code, or recovery code.</p>
      <div className="page-actions">
        <Link className="button" href="/support">Contact support</Link>
        <Link className="button secondary" href="/about">About the service</Link>
      </div>
    </SectionCard>
    <SectionCard title="Alternative access" description="Local 801 can help when a feature creates a barrier.">
      <p>Ask an administrator or application support for an accessible alternative or reasonable assistance with an authorized workflow while the barrier is reviewed.</p>
    </SectionCard>
  </div>;
}
