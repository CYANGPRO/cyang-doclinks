import { InstallPrompt } from "@/components/InstallPrompt";
import { DisclosureCard, PageHeader, SectionCard } from "@/components/DesignSystem";

export default function InstallPage() {
  return (
    <div className="content">
      <PageHeader eyebrow="This device" title="Install the Local 801 app" description="Add the workspace to this device for faster access. Member and work data still requires a secure connection." />

      <SectionCard title="Install on this device" description="Use the install button when this browser supports it. If it does not appear, follow the browser-specific steps below.">
        <InstallPrompt />
      </SectionCard>

      <DisclosureCard title="iPhone and iPad" description="Install from Safari">
        <ol className="step-list">
          <li>Open Engaging Local 801 in Safari.</li>
          <li>Open the Share menu and choose Add to Home Screen.</li>
          <li>Confirm the app name, then open it from your home screen.</li>
        </ol>
      </DisclosureCard>

      <DisclosureCard title="Android" description="Install from Chrome or another supported browser">
        <ol className="step-list">
          <li>Open the browser menu.</li>
          <li>Choose Install app or Add to Home screen.</li>
          <li>Confirm installation, then open the app from your home screen.</li>
        </ol>
      </DisclosureCard>

      <DisclosureCard title="Desktop browsers" description="Use the install icon or browser menu when available">
        <ol className="step-list">
          <li>Look for an install icon in the address bar or open the browser menu.</li>
          <li>Choose Install Engaging Local 801 and confirm.</li>
        </ol>
      </DisclosureCard>

      <DisclosureCard title="Private by design" description="What remains online-only">
        <p className="muted">Only the app frame may be available without a connection. Member records, notes, assignments, documents, and reports always require secure online access.</p>
      </DisclosureCard>
    </div>
  );
}
