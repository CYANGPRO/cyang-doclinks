"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

export function RouteAwareFrame({ sidebar, topbar, mobile, children }: {
  sidebar: ReactNode;
  topbar: ReactNode;
  mobile: ReactNode;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const isolated = pathname === "/sign-in" || pathname === "/privacy" || pathname === "/support" || pathname.startsWith("/legal/");
  return (
    <div className={`app-frame${isolated ? " isolated-route" : ""}`}>
      <a className="skip-link" href="#main-content">Skip to main content</a>
      {sidebar}
      <main className="main-shell" id="main-content" tabIndex={-1}>
        {topbar}
        {children}
      </main>
      {mobile}
    </div>
  );
}
