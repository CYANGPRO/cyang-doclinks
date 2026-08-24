"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import styles from "./NotificationBell.module.css";

type NotificationUrgency = "overdue" | "today" | "soon" | "info";

type NotificationItem = {
  key: string;
  title: string;
  detail: string;
  href: string;
  urgency: NotificationUrgency;
  dueAt: string | null;
};

type NotificationPayload = {
  count: number;
  items: NotificationItem[];
};

function urgencyLabel(urgency: NotificationUrgency) {
  if (urgency === "overdue") return "Overdue";
  if (urgency === "today") return "Today";
  if (urgency === "soon") return "Due soon";
  return "Review";
}

async function dispatchBrowserPush(payload: NotificationPayload) {
  if (payload.count < 1 || !("Notification" in window) || Notification.permission !== "granted" || !window.crypto?.subtle) return;
  const source = JSON.stringify({ count: payload.count, keys: payload.items.map((item) => item.key) });
  const bytes = await window.crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
  const digest = [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, "0")).join("");
  await fetch("/api/work-preferences/push/dispatch", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ digest }),
  });
}

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [payload, setPayload] = useState<NotificationPayload | null>(null);
  const [error, setError] = useState(false);
  const [dismissError, setDismissError] = useState("");
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/work-preferences/notifications", {
        cache: "no-store",
        credentials: "same-origin",
      });
      if (!response.ok) throw new Error("notification summary unavailable");
      const body = await response.json() as NotificationPayload;
      const normalized = {
        count: Number.isSafeInteger(body.count) && body.count >= 0 ? body.count : 0,
        items: Array.isArray(body.items) ? body.items.slice(0, 5) : [],
      };
      setPayload(normalized);
      void dispatchBrowserPush(normalized).catch(() => undefined);
      setError(false);
    } catch {
      setError(true);
    }
  }, []);

  useEffect(() => {
    const initialRefresh = window.setTimeout(() => void load(), 0);
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearTimeout(initialRefresh);
      window.removeEventListener("focus", onFocus);
    };
  }, [load]);

  useEffect(() => {
    if (!open) return;
    const openRefresh = window.setTimeout(() => void load(), 0);

    function onPointerDown(event: PointerEvent) {
      if (!wrapperRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        window.requestAnimationFrame(() => triggerRef.current?.focus());
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.clearTimeout(openRefresh);
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [load, open]);

  function toggleOpen() {
    setDismissError("");
    setOpen((value) => !value);
  }

  async function dismiss(notificationKey: string) {
    if (busyKey) return;
    setBusyKey(notificationKey);
    setDismissError("");
    try {
      const response = await fetch(`/api/work-preferences/notifications/${encodeURIComponent(notificationKey)}`, {
        method: "POST",
      });
      if (!response.ok) throw new Error("dismiss failed");
      await load();
    } catch {
      setDismissError("We couldn’t dismiss that notification. Try again.");
    } finally {
      setBusyKey(null);
    }
  }

  const count = payload?.count ?? 0;
  const badge = count > 99 ? "99+" : String(count);

  return <div className={styles.wrapper} ref={wrapperRef}>
    <button
      aria-controls="notification-panel"
      aria-expanded={open}
      aria-label={count > 0 ? `Notifications, ${count} current` : "Notifications"}
      className={styles.trigger}
      onClick={toggleOpen}
      ref={triggerRef}
      type="button"
    >
      <svg aria-hidden="true" className={styles.icon} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.8">
        <path strokeLinecap="round" strokeLinejoin="round" d="M14.857 17.082a23.848 23.848 0 0 0 5.454-1.31A8.967 8.967 0 0 1 18 9.75V9a6 6 0 1 0-12 0v.75a8.967 8.967 0 0 1-2.312 6.022c1.733.64 3.56 1.084 5.455 1.31m5.714 0a24.255 24.255 0 0 1-5.714 0m5.714 0a3 3 0 1 1-5.714 0" />
      </svg>
      {count > 0 ? <span className={styles.count}>{badge}</span> : null}
    </button>

    {open ? <section aria-label="Notifications" className={styles.panel} id="notification-panel">
      <div className={styles.heading}>
        <div>
          <strong>Notifications</strong>
          <span className={styles.summary}>{count} current</span>
        </div>
        <button
          aria-label="Close notifications"
          className={styles.close}
          onClick={() => {
            setOpen(false);
            triggerRef.current?.focus();
          }}
          type="button"
        >
          Close
        </button>
      </div>

      <div className={styles.scroller}>
        {error ? <div className={styles.error}>Notifications are temporarily unavailable. You can still open the full notifications page.</div> : payload === null ? <div className={styles.empty}>Loading notifications…</div> : payload.items.length === 0 ? <div className={styles.empty}>You’re caught up. Nothing needs your attention here right now.</div> : <div className={styles.list}>
          {payload.items.map((notification) => <article className={styles.item} key={notification.key}>
            <Link className={styles.itemBody} href={notification.href} onClick={() => setOpen(false)}>
              <div className={styles.itemHeader}>
                <span className={styles.itemTitle}>{notification.title}</span>
                <span className={`${styles.urgency} ${styles[notification.urgency]}`}>{urgencyLabel(notification.urgency)}</span>
              </div>
              <div className={styles.detail}>{notification.detail}</div>
            </Link>
            <div className={styles.itemActions}>
              <button className={styles.dismiss} disabled={busyKey === notification.key} onClick={() => void dismiss(notification.key)} type="button">
                {busyKey === notification.key ? "Dismissing…" : "Dismiss"}
              </button>
            </div>
          </article>)}
        </div>}

        {dismissError ? <div className={styles.error} role="alert">{dismissError}</div> : null}
      </div>

      <div className={styles.footer}>
        <Link className={styles.footerLink} href="/notifications" onClick={() => setOpen(false)}>View all notifications</Link>
      </div>
    </section> : null}
  </div>;
}
