"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { usePathname } from "next/navigation";
import { activeNavigationHref, type NavigationGroup } from "@/lib/access";

type NavItem = { href: string; label: string; group?: NavigationGroup };
type NavGroup = { label: NavigationGroup; items: NavItem[] };

function navigationGroupId(label: NavigationGroup) {
  return `nav-${label.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}`;
}

const mobileGlyphs: Record<string, string> = {
  Home: "⌂",
  Membership: "◎",
  Directory: "◎",
  "Member outreach": "◉",
  "Data imports": "⇅",
  "To Do": "□",
  Reports: "▥",
};

function NavLink({ item, active, mobile = false, onNavigate }: { item: NavItem; active: boolean; mobile?: boolean; onNavigate?: () => void }) {
  return (
    <Link
      aria-current={active ? "page" : undefined}
      className={mobile ? "mobile-nav-link" : "nav-link"}
      href={item.href}
      onClick={onNavigate}
    >
      {mobile ? <span className="mobile-nav-glyph" aria-hidden="true">{mobileGlyphs[item.label] ?? "•"}</span> : <span className="nav-indicator" aria-hidden="true" />}
      <span>{item.label}</span>
    </Link>
  );
}

export function DesktopNavigation({ groups }: { groups: NavGroup[] }) {
  const pathname = usePathname();
  const activeHref = activeNavigationHref(pathname, groups.flatMap((group) => group.items.map((item) => item.href)));
  return (
    <nav className="nav-groups" aria-label="Primary navigation">
      {groups.map((group) => {
        const active = group.items.some((item) => item.href === activeHref);
        return <details className="nav-group" key={group.label} open={active}>
          <summary id={navigationGroupId(group.label)}>
            <span>{group.label}</span>
            <span className="nav-group-chevron" aria-hidden="true">⌄</span>
          </summary>
          <div className="nav-list" aria-labelledby={navigationGroupId(group.label)}>
            {group.items.map((item) => <NavLink item={item} active={item.href === activeHref} key={item.href} />)}
          </div>
        </details>;
      })}
    </nav>
  );
}

export function MobileNavigation({ primary, all, previewAuth }: { primary: NavItem[]; all: NavGroup[]; previewAuth: boolean }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const activeHref = activeNavigationHref(pathname, all.flatMap((group) => group.items.map((item) => item.href)));
  const primaryHrefs = new Set(primary.map((item) => item.href));
  const moreActive = Boolean(activeHref && !primaryHrefs.has(activeHref));
  const style = { "--mobile-nav-items": primary.length + 1 } as CSSProperties;

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const dialog = dialogRef.current;
    const focusable = dialog?.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])');
    focusable?.[0]?.focus();
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
        return;
      }
      if (event.key !== "Tab" || !focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  function closeDrawer() {
    setOpen(false);
    triggerRef.current?.focus();
  }

  return (
    <>
      <nav className="mobile-nav" aria-label="Mobile navigation" style={style}>
        {primary.map((item) => <NavLink item={item} active={item.href === activeHref} key={item.href} mobile />)}
        <button aria-current={moreActive ? "page" : undefined} aria-expanded={open} className="mobile-more-trigger" onClick={() => setOpen(true)} ref={triggerRef} type="button"><span className="more-glyph" aria-hidden="true">•••</span><span>More</span></button>
      </nav>
      {open ? <div className="mobile-drawer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) closeDrawer(); }}>
        <div aria-label="All authorized areas" aria-modal="true" className="mobile-drawer" ref={dialogRef} role="dialog">
          <div className="mobile-drawer-header"><div><span className="page-kicker">Navigate</span><div className="mobile-drawer-heading">Your workspace</div></div><button aria-label="Close navigation" className="drawer-close" onClick={closeDrawer} type="button">Close</button></div>
          <div className="mobile-drawer-groups">
            {all.map((group) => (
              <section key={group.label}>
                <h2>{group.label}</h2>
                <div className="nav-list">{group.items.map((item) => <NavLink item={item} active={item.href === activeHref} key={item.href} onNavigate={() => setOpen(false)} />)}</div>
              </section>
            ))}
            <section><h2>App</h2><div className="nav-list"><NavLink active={pathname === "/install"} item={{ href: "/install", label: "Install app" }} onNavigate={() => setOpen(false)} />{previewAuth ? <NavLink active={pathname === "/sign-in"} item={{ href: "/sign-in", label: "Switch Preview role" }} onNavigate={() => setOpen(false)} /> : null}</div></section>
          </div>
        </div>
      </div> : null}
    </>
  );
}
