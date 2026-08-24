"use client";

import Link from "next/link";
import { signOut } from "next-auth/react";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";

export function AccountSessionMenu({
  authentication,
  roleLabel,
}: {
  authentication: "preview" | "production";
  roleLabel: string;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function closeAndRestoreFocus() {
      setOpen(false);
      triggerRef.current?.focus();
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeAndRestoreFocus();
      }
    }
    function handlePointerDown(event: PointerEvent) {
      const target = event.target;
      if (target instanceof Node && !panelRef.current?.contains(target) && !triggerRef.current?.contains(target)) {
        setOpen(false);
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("pointerdown", handlePointerDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [open]);

  function previewSwitchHref() {
    const currentPath = typeof window === "undefined" ? pathname : `${window.location.pathname}${window.location.search}`;
    return `/sign-in?next=${encodeURIComponent(currentPath)}`;
  }

  return <div className="account-menu">
    <button
      aria-controls="account-session-panel"
      aria-expanded={open}
      className="account-menu-trigger"
      onClick={() => setOpen((current) => !current)}
      ref={triggerRef}
      type="button"
    >
      <span className="account-menu-glyph" aria-hidden="true">●</span>
      <span className="account-menu-role">{roleLabel}</span>
      <span aria-hidden="true">⌄</span>
      <span className="sr-only">Account and session</span>
    </button>
    {open ? <div aria-label="Account and session" className="account-menu-panel" id="account-session-panel" ref={panelRef}>
      <div className="account-menu-heading">Account and session</div>
      <div className="account-menu-summary">
        <span>Current role</span>
        <strong>{roleLabel}</strong>
        <span>{authentication === "preview" ? "Preview session" : "Production session"}</span>
      </div>
      {authentication === "preview" ? (
        <Link className="button secondary account-menu-action" href={`/sign-in?next=${encodeURIComponent(pathname)}`} onClick={(event) => {
          event.preventDefault();
          window.location.assign(previewSwitchHref());
        }}>Switch Preview role</Link>
      ) : (
        <button className="button secondary account-menu-action" disabled={signingOut} onClick={async () => {
          setSigningOut(true);
          await signOut({ callbackUrl: "/sign-in" });
        }} type="button">{signingOut ? "Signing out…" : "Sign out"}</button>
      )}
    </div> : null}
  </div>;
}
