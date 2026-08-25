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
      title="Using CAT with a keyboard, touch, or assistive technology"
      description="CAT is designed to work across screen sizes and input methods. Last updated August 25, 2026."
    />
    <SectionCard title="What CAT supports" description="The interface uses clear structure, labeled controls, and layouts that adapt to the device.">
      <ul className="policy-list">
        <li>Keyboard-accessible navigation, forms, dialogs, tables, and visible focus indicators.</li>
        <li>A skip link, semantic headings, labeled controls, status messages, and descriptive page titles.</li>
        <li>Responsive layouts and mobile field views that avoid unnecessary horizontal scrolling.</li>
        <li>Support for text resizing, high-contrast preferences, reduced motion, and coarse-pointer touch targets.</li>
      </ul>
    </SectionCard>
    <SectionCard title="Report an accessibility barrier" description="A few practical details will help us understand and fix the problem.">
      <p>Tell application support which page or feature you were using, your device and browser, any assistive technology involved, what you expected, and what happened. Do not include a member roster, protected contact information, password, MFA code, or recovery code.</p>
      <div className="page-actions">
        <Link className="button" href="/support">Contact support</Link>
        <Link className="button secondary" href="/about">About the service</Link>
      </div>
    </SectionCard>
    <SectionCard title="Ask for another way to complete the work" description="You do not need to wait for a software fix to ask for help.">
      <p>Ask an administrator or application support for an accessible alternative or reasonable assistance with the approved work while the barrier is reviewed.</p>
    </SectionCard>
  </div>;
}
