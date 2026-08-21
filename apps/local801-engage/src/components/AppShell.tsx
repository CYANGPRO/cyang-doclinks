import Image from "next/image";
import Link from "next/link";
import { mobileNavForRole, navGroupsForRole, shellForRole } from "@/lib/access";
import { getPreviewUser } from "@/lib/authz.server";
import { DesktopNavigation, MobileNavigation } from "@/components/AppNavigation";
import { InstallPrompt } from "@/components/InstallPrompt";

export async function AppShell({ children }: { children: React.ReactNode }) {
  const user = await getPreviewUser();
  const shell = shellForRole(user?.role ?? null);
  const groups = user ? navGroupsForRole(user.role) : [];
  const mobile = user ? mobileNavForRole(user.role) : [];

  return (
    <div className="app-frame">
      <aside className="sidebar" aria-label="Primary">
        <Link aria-label="Local 801 Engage home" className="brand" href="/">
          <Image
            alt=""
            className="brand-logo"
            height={771}
            priority
            sizes="204px"
            src="/brand/mape-logo.png"
            width={920}
          />
          <span className="brand-copy">
            <span className="brand-region">Region 8 · Local 801</span>
            <span className="brand-title">Local 801 Engage</span>
            <span className="brand-subtitle">Member &amp; CAT Operations</span>
          </span>
        </Link>
        {user ? <DesktopNavigation groups={groups} /> : null}
        <div className="sidebar-foot">Private operational system</div>
      </aside>
      <main className="main-shell">
        <header className="topbar">
          <div>
            <strong>Local 801 Engage</strong>
            <div className="preview-status">Private preview · synthetic data only</div>
          </div>
          {user && shell.roleLabel ? (
            <div className="toolbar" style={{ marginTop: 0 }}>
              <InstallPrompt compact />
              <span className="role-chip">{shell.roleLabel}</span>
            </div>
          ) : null}
        </header>
        {children}
      </main>
      {user ? <MobileNavigation all={groups} primary={mobile} /> : null}
    </div>
  );
}
