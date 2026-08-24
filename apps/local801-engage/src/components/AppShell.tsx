import Image from "next/image";
import Link from "next/link";
import { can, mobileNavForRole, navGroupsForRole, shellForRole } from "@/lib/access";
import { getPreviewUser } from "@/lib/authz.server";
import { DesktopNavigation, MobileNavigation } from "@/components/AppNavigation";
import { InstallPrompt } from "@/components/InstallPrompt";
import { NotificationBell } from "@/components/NotificationBell";
import { RouteAwareFrame } from "@/components/RouteAwareFrame";
import { AccountSessionMenu } from "@/components/AccountSessionMenu";
import { NativeNotificationRouter } from "@/components/NativeNotificationRouter";

export async function AppShell({ children }: { children: React.ReactNode }) {
  const user = await getPreviewUser();
  const shell = shellForRole(user?.role ?? null);
  const groups = user ? navGroupsForRole(user.role) : [];
  const mobile = user ? mobileNavForRole(user.role) : [];

  const sidebar = <aside className="sidebar" aria-label="Primary">
        <Link aria-label="Engaging Local 801 home" className="brand" href="/">
          <span className="brand-logo-surface" aria-hidden="true">
            <Image alt="" className="brand-logo" height={771} preload sizes="168px" src="/brand/mape-logo.png" width={920} />
          </span>
          <span className="brand-copy">
            <span className="brand-title">Engaging Local 801</span>
            <span className="brand-subtitle">Membership &amp; organizing</span>
          </span>
        </Link>
        {user ? <DesktopNavigation groups={groups} /> : null}
        <div className="sidebar-foot">
          <span>Private Local 801 workspace</span>
          <span className="sidebar-utility-links"><Link href="/install">Install app</Link>{user?.authentication === "preview" ? <Link href="/sign-in">Switch Preview role</Link> : null}</span>
        </div>
      </aside>;
  const topbar = <header className="topbar">
          <div className="topbar-identity">
            <Image alt="MAPE" className="topbar-mape-logo" height={771} sizes="48px" src="/brand/mape-logo.png" width={920} />
            <div className="topbar-copy">
              <strong className="topbar-title">Local 801 workspace</strong>
              {user?.authentication === "preview" ? <div className="preview-status"><span aria-hidden="true">●</span>Preview environment</div> : null}
            </div>
          </div>
          {user && shell.roleLabel ? (
            <div className="topbar-actions">
              {can(user.role, "viewPersonalWorkspace") ? <NotificationBell /> : null}
              <InstallPrompt compact />
              <AccountSessionMenu authentication={user.authentication} roleLabel={shell.roleLabel} />
            </div>
          ) : null}
        </header>;

  return <>
    {user && can(user.role, "viewPersonalWorkspace") ? <NativeNotificationRouter /> : null}
    <RouteAwareFrame sidebar={sidebar} topbar={topbar} mobile={user ? <MobileNavigation all={groups} previewAuth={user.authentication === "preview"} primary={mobile} /> : null}>{children}</RouteAwareFrame>
  </>;
}
