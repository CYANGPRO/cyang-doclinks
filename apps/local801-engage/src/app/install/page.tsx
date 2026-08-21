import { InstallPrompt } from "@/components/InstallPrompt";
import { AlertBanner, PageHeader, SectionCard } from "@/components/DesignSystem";

export default function InstallPage() {
  return (
    <div className="content">
      <PageHeader eyebrow="Progressive Web App" title="Install Local 801 Engage" description="Install the workspace for faster access while keeping private operational data online-only." actions={<InstallPrompt />} />
      <AlertBanner title="Offline boundary">The app shell may be available offline. Member records, notes, assignments, documents, and reports are never cached for offline use.</AlertBanner>
      <section className="section grid two-grid">
        <SectionCard title="Apple devices">
          <ol className="step-list">
            <li>Open Local 801 Engage in Safari.</li>
            <li>Open the Share menu.</li>
            <li>Select Add to Home Screen.</li>
            <li>Confirm the application name.</li>
            <li>Launch Local 801 Engage from the home screen.</li>
          </ol>
        </SectionCard>
        <SectionCard title="Android devices">
          <ol className="step-list">
            <li>Open Local 801 Engage in Chrome or another supported browser.</li>
            <li>Select Install App when prompted or use the browser menu.</li>
            <li>Confirm installation.</li>
            <li>Launch Local 801 Engage from the home screen.</li>
          </ol>
        </SectionCard>
      </section>
    </div>
  );
}
