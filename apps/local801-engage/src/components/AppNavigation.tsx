"use client";

import Link from "next/link";
import type { CSSProperties } from "react";
import { usePathname } from "next/navigation";
import type { NavigationGroup } from "@/lib/access";

type NavItem = { href: string; label: string; group?: NavigationGroup };
type NavGroup = { label: NavigationGroup; items: NavItem[] };

function isActive(pathname: string, href: string) {
  return href === "/" ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
}

function NavLink({ item, mobile = false }: { item: NavItem; mobile?: boolean }) {
  const pathname = usePathname();
  const active = isActive(pathname, item.href);
  return (
    <Link
      aria-current={active ? "page" : undefined}
      className={mobile ? "mobile-nav-link" : "nav-link"}
      href={item.href}
    >
      <span className="nav-indicator" aria-hidden="true" />
      <span>{item.label}</span>
    </Link>
  );
}

export function DesktopNavigation({ groups }: { groups: NavGroup[] }) {
  return (
    <nav className="nav-groups" aria-label="Primary navigation">
      {groups.map((group) => (
        <section className="nav-group" key={group.label} aria-labelledby={`nav-${group.label}`}>
          <h2 id={`nav-${group.label}`}>{group.label}</h2>
          <div className="nav-list">
            {group.items.map((item) => <NavLink item={item} key={item.href} />)}
          </div>
        </section>
      ))}
    </nav>
  );
}

export function MobileNavigation({ primary, all }: { primary: NavItem[]; all: NavGroup[] }) {
  const style = { "--mobile-nav-items": primary.length + 1 } as CSSProperties;
  return (
    <>
      <nav className="mobile-nav" aria-label="Mobile navigation" style={style}>
        {primary.map((item) => <NavLink item={item} key={item.href} mobile />)}
        <details className="mobile-more">
          <summary><span className="more-glyph" aria-hidden="true">•••</span><span>More</span></summary>
          <div className="mobile-drawer">
            <div className="mobile-drawer-heading">All authorized areas</div>
            {all.map((group) => (
              <section key={group.label}>
                <h2>{group.label}</h2>
                {group.items.map((item) => <NavLink item={item} key={item.href} />)}
              </section>
            ))}
          </div>
        </details>
      </nav>
    </>
  );
}
