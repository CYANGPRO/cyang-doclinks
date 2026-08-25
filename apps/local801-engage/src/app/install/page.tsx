import { InstallPrompt } from "@/components/InstallPrompt";
import { DisclosureCard, PageHeader, SectionCard } from "@/components/DesignSystem";

export default function InstallPage() {
  return (
    <div className="content">
      <PageHeader eyebrow="This device" title="Add CAT to this device" description="Install a shortcut for faster access. Member and work data still require a secure connection." />

      <SectionCard title="Install the shortcut" description="Use the install button if it appears. Otherwise, open the instructions for your device below.">
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

      <DisclosureCard title="What still needs an internet connection" description="The shortcut does not store member information offline">
        <p className="muted">The CAT frame may open without a connection, but member records, notes, assignments, documents, and reports will not. Reconnect before continuing the work.</p>
      </DisclosureCard>
    </div>
  );
}
