"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

export function RouteAwareFrame({ sidebar, topbar, mobile, footer, children }: {
  sidebar: ReactNode;
  topbar: ReactNode;
  mobile: ReactNode;
  footer: ReactNode;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const isolated = pathname === "/sign-in"
    || pathname === "/privacy"
    || pathname === "/about"
    || pathname === "/accessibility"
    || pathname === "/support"
    || pathname.startsWith("/legal/");
  return (
    <div className={`app-frame${isolated ? " isolated-route" : ""}`}>
      <a className="skip-link" href="#main-content">Skip to main content</a>
      {sidebar}
      <main className="main-shell" id="main-content" tabIndex={-1}>
        {topbar}
        <div className="route-body">{children}</div>
        {footer}
      </main>
      {mobile}
    </div>
  );
}
