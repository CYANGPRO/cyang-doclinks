"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useConditionalPolling } from "@/hooks/useConditionalPolling";
import { platformStatusSummary } from "@/lib/statusCopy";
import {
  deriveStatusPageScenario,
  type PlatformState,
  type StatusPageScenario,
  type StatusSnapshot,
} from "@/lib/statusPageScenario";

type ServiceState = PlatformState;
type IncidentState = "investigating" | "identified" | "monitoring" | "resolved";

type ServiceItem = {
  key: string;
  name: string;
  description: string;
  status: ServiceState;
  latencyMs: number | null;
  uptime30d: number;
  trend: number[];
};

type IncidentUpdate = {
  status: IncidentState;
  timestamp: string;
  message: string;
};

type IncidentItem = {
  id: string;
  title: string;
  summary: string;
  status: IncidentState;
  startedAt: string;
  resolvedAt: string | null;
  updates: IncidentUpdate[];
};

type UptimeDay = {
  date: string;
  status: PlatformState;
};

type StatusPreview =
  | "live"
  | "operational"
  | "degraded"
  | "partial_outage"
  | "major_outage"
  | "maintenance"
  | "loading";

const PREVIEW_VALUES = new Set<StatusPreview>([
  "live",
  "operational",
  "degraded",
  "partial_outage",
  "major_outage",
  "maintenance",
  "loading",
]);

const STATUS_POLL_HEALTHY_MS = 15 * 60_000;
const STATUS_POLL_DEGRADED_MS = 3 * 60_000;
const STATUS_POLL_UNHEALTHY_MS = 60_000;
const STATUS_RESUME_STALE_HEALTHY_MS = 10 * 60_000;
const STATUS_RESUME_STALE_DEGRADED_MS = 2 * 60_000;
const STATUS_RESUME_STALE_UNHEALTHY_MS = 45_000;
const STATUS_SUBSCRIBE_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const STATUS_SUBSCRIBE_STORAGE_KEY = "cyang_status_subscription_email";

type StatusSubscribeApiResponse = {
  ok?: boolean;
  message?: string;
};

const SERVICE_CATALOG: Array<{
  key: string;
  name: string;
  description: string;
  baseLatency: number | null;
  baseUptime: number;
}> = [
  { key: "website", name: "Website", description: "Marketing site and customer entry routes.", baseLatency: 118, baseUptime: 99.99 },
  { key: "api", name: "API", description: "Core API endpoints for docs, links, and account actions.", baseLatency: 152, baseUptime: 99.98 },
  { key: "protected_links", name: "Protected Links", description: "Token generation, access checks, and secure delivery.", baseLatency: 164, baseUptime: 99.97 },
  { key: "file_uploads", name: "File Uploads", description: "Signed upload flow and transfer handling.", baseLatency: 228, baseUptime: 99.95 },
  { key: "document_processing", name: "Document Processing", description: "Scan queue, sanitization, and processing workers.", baseLatency: 304, baseUptime: 99.93 },
  { key: "authentication", name: "Authentication", description: "Google, SSO, and email sign-in flows.", baseLatency: 136, baseUptime: 99.99 },
  { key: "admin_dashboard", name: "Workspace Dashboard", description: "Workspace operations and controls.", baseLatency: 182, baseUptime: 99.96 },
  { key: "member_access", name: "Member Access", description: "Member workspace access and document workflows.", baseLatency: 176, baseUptime: 99.97 },
  { key: "email_delivery", name: "Email Delivery", description: "Transactional notifications and share emails.", baseLatency: 248, baseUptime: 99.92 },
  { key: "background_jobs", name: "Background Jobs", description: "Scheduled scans, retention, and maintenance tasks.", baseLatency: null, baseUptime: 99.9 },
];

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function isoDaysAgo(days: number) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

function statusRank(status: PlatformState) {
  if (status === "major_outage") return 5;
  if (status === "partial_outage") return 4;
  if (status === "degraded") return 3;
  if (status === "maintenance") return 2;
  return 1;
}

function statusConfig(status: StatusPageScenario) {
  if (status === "snapshot_unavailable") {
    return {
      label: "Snapshot unavailable",
      short: "Unavailable",
      badge: "border-[rgba(186,104,48,0.18)] bg-[rgba(186,104,48,0.08)] text-[#8e4d14]",
      dot: "bg-[#d97706]",
      headline: "Public status snapshot is temporarily unavailable.",
      summary: "This page is withholding system-level health claims until a fresh public readiness snapshot is available.",
    };
  }
  if (status === "operational") {
    return {
      label: "Operational",
      short: "Operational",
      badge: "border-[rgba(40,136,88,0.18)] bg-[rgba(40,136,88,0.08)] text-[var(--success)]",
      dot: "bg-[var(--success)]",
      headline: platformStatusSummary("operational"),
      summary: "Customers can sign in, share protected links, and access documents without disruption.",
    };
  }
  if (status === "degraded") {
    return {
      label: "Degraded Performance",
      short: "Degraded",
      badge: "border-[rgba(161,109,27,0.18)] bg-[rgba(161,109,27,0.08)] text-[var(--accent-warm)]",
      dot: "bg-[var(--warning)]",
      headline: "Some services are slower than normal.",
      summary: "Core availability is intact, but response times are elevated for selected workflows.",
    };
  }
  if (status === "partial_outage") {
    return {
      label: "Partial Outage",
      short: "Partial outage",
      badge: "border-[rgba(186,104,48,0.18)] bg-[rgba(186,104,48,0.08)] text-[#8e4d14]",
      dot: "bg-[#d97706]",
      headline: "A subset of services is currently unavailable.",
      summary: "Customers may see intermittent failures in affected workflows while we restore full service.",
    };
  }
  if (status === "major_outage") {
    return {
      label: "Major Outage",
      short: "Major outage",
      badge: "border-[rgba(186,71,50,0.18)] bg-[rgba(186,71,50,0.08)] text-[var(--danger)]",
      dot: "bg-[var(--danger)]",
      headline: "We are actively responding to a major service disruption.",
      summary: "Multiple core workflows are impacted. Updates will be posted as mitigation progresses.",
    };
  }
  return {
    label: "Maintenance",
    short: "Maintenance",
    badge: "border-[var(--border-accent)] bg-[var(--surface-selected)] text-[var(--accent-primary)]",
    dot: "bg-[var(--accent-primary)]",
    headline: "Scheduled maintenance is in progress.",
    summary: "Some operations may be delayed while planned maintenance tasks complete.",
  };
}

function incidentStateConfig(status: IncidentState) {
  if (status === "investigating") return { label: "Investigating", badge: "border-[rgba(161,109,27,0.18)] bg-[rgba(161,109,27,0.08)] text-[var(--accent-warm)]" };
  if (status === "identified") return { label: "Identified", badge: "border-[rgba(186,104,48,0.18)] bg-[rgba(186,104,48,0.08)] text-[#8e4d14]" };
  if (status === "monitoring") return { label: "Monitoring", badge: "border-[var(--border-accent)] bg-[var(--surface-selected)] text-[var(--accent-primary)]" };
  return { label: "Resolved", badge: "border-[rgba(40,136,88,0.18)] bg-[rgba(40,136,88,0.08)] text-[var(--success)]" };
}

function latencyForStatus(baseLatency: number | null, status: ServiceState) {
  if (baseLatency == null) return null;
  if (status === "operational") return baseLatency;
  if (status === "maintenance") return Math.round(baseLatency * 1.08);
  if (status === "degraded") return Math.round(baseLatency * 1.44);
  if (status === "partial_outage") return Math.round(baseLatency * 1.72);
  return Math.round(baseLatency * 2.2);
}

function uptimeForStatus(base: number, status: ServiceState) {
  if (status === "operational") return base;
  if (status === "maintenance") return clamp(base - 0.05, 97, 99.99);
  if (status === "degraded") return clamp(base - 0.2, 95, 99.99);
  if (status === "partial_outage") return clamp(base - 1.3, 90, 99.99);
  return clamp(base - 3.8, 80, 99.99);
}

function trendForStatus(status: ServiceState) {
  if (status === "operational") return [97, 98, 98, 99, 99, 99, 100];
  if (status === "maintenance") return [99, 99, 98, 96, 95, 97, 99];
  if (status === "degraded") return [93, 92, 90, 88, 89, 90, 91];
  if (status === "partial_outage") return [86, 82, 80, 78, 79, 81, 83];
  return [70, 62, 55, 48, 50, 53, 58];
}

function serviceStatusForScenario(key: string, scenario: PlatformState): ServiceState {
  if (scenario === "operational") return "operational";
  if (scenario === "maintenance") {
    if (key === "background_jobs" || key === "document_processing") return "maintenance";
    return "operational";
  }
  if (scenario === "degraded") {
    if (key === "api" || key === "protected_links" || key === "file_uploads" || key === "document_processing") return "degraded";
    return "operational";
  }
  if (scenario === "partial_outage") {
    if (key === "authentication" || key === "member_access") return "partial_outage";
    if (key === "api" || key === "admin_dashboard" || key === "protected_links") return "degraded";
    return "operational";
  }
  if (key === "api" || key === "authentication" || key === "protected_links" || key === "member_access") return "major_outage";
  if (key === "website" || key === "admin_dashboard" || key === "file_uploads") return "partial_outage";
  return "degraded";
}

function buildServices(scenario: PlatformState): ServiceItem[] {
  return SERVICE_CATALOG.map((item) => {
    const status = serviceStatusForScenario(item.key, scenario);
    return {
      key: item.key,
      name: item.name,
      description: item.description,
      status,
      latencyMs: latencyForStatus(item.baseLatency, status),
      uptime30d: uptimeForStatus(item.baseUptime, status),
      trend: trendForStatus(status),
    };
  });
}

function buildIncidents(scenario: PlatformState): IncidentItem[] {
  if (scenario === "operational") return [];
  if (scenario === "degraded") {
    return [
      {
        id: "inc-latency-links",
        title: "Elevated latency for protected link creation",
        summary: "A subset of customers may notice slower protected link creation requests.",
        status: "investigating",
        startedAt: isoDaysAgo(0),
        resolvedAt: null,
        updates: [
          {
            status: "investigating",
            timestamp: new Date(Date.now() - 26 * 60 * 1000).toISOString(),
            message: "We are investigating elevated response times for link creation endpoints.",
          },
        ],
      },
    ];
  }
  if (scenario === "partial_outage") {
    return [
      {
        id: "inc-auth-intermittent",
        title: "Intermittent authentication failures",
        summary: "Sign-in attempts may fail intermittently while mitigation is rolled out.",
        status: "identified",
        startedAt: isoDaysAgo(0),
        resolvedAt: null,
        updates: [
          { status: "investigating", timestamp: new Date(Date.now() - 48 * 60 * 1000).toISOString(), message: "We are investigating sign-in failures impacting a subset of users." },
          { status: "identified", timestamp: new Date(Date.now() - 22 * 60 * 1000).toISOString(), message: "Root cause identified. Mitigation rollout is in progress." },
        ],
      },
    ];
  }
  if (scenario === "major_outage") {
    return [
      {
        id: "inc-platform-major",
        title: "Platform-wide service disruption",
        summary: "Core workflows are impacted. Recovery is in progress.",
        status: "investigating",
        startedAt: isoDaysAgo(0),
        resolvedAt: null,
        updates: [
          { status: "investigating", timestamp: new Date(Date.now() - 34 * 60 * 1000).toISOString(), message: "We are investigating broad service availability issues." },
        ],
      },
    ];
  }
  return [
    {
      id: "inc-maint-window",
      title: "Scheduled platform maintenance",
      summary: "Planned maintenance is active. Some workflows may experience short delays.",
      status: "monitoring",
      startedAt: isoDaysAgo(0),
      resolvedAt: null,
      updates: [
        { status: "monitoring", timestamp: new Date(Date.now() - 20 * 60 * 1000).toISOString(), message: "Maintenance tasks are running as planned with limited customer impact." },
      ],
    },
  ];
}

function buildUptime(scenario: PlatformState): UptimeDay[] {
  const days: UptimeDay[] = [];
  for (let i = 29; i >= 0; i -= 1) {
    days.push({ date: isoDaysAgo(i), status: "operational" });
  }
  if (scenario === "degraded") {
    days[24].status = "degraded";
    days[29].status = "degraded";
  } else if (scenario === "partial_outage") {
    days[19].status = "degraded";
    days[27].status = "partial_outage";
  } else if (scenario === "major_outage") {
    days[18].status = "degraded";
    days[26].status = "partial_outage";
    days[29].status = "major_outage";
  } else if (scenario === "maintenance") {
    days[28].status = "maintenance";
    days[29].status = "maintenance";
  }
  return days;
}

function uptimeWeight(status: PlatformState) {
  if (status === "operational") return 100;
  if (status === "degraded") return 99.4;
  if (status === "maintenance") return 99.8;
  if (status === "partial_outage") return 96;
  return 85;
}

function dailyBarClass(status: PlatformState) {
  if (status === "operational") return "bg-emerald-300/90";
  if (status === "degraded") return "bg-amber-300/90";
  if (status === "maintenance") return "bg-sky-300/90";
  if (status === "partial_outage") return "bg-orange-300/90";
  return "bg-rose-300/90";
}

function fmtDateTime(value: string | number | null) {
  if (!value) return "Unavailable";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

function fmtRelative(value: string | number | null) {
  if (!value) return "Unavailable";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "Unavailable";
  const minutes = Math.round((Date.now() - d.getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function UptimeSparkline({ values }: { values: number[] }) {
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const range = Math.max(max - min, 1);
  const points = values.map((v, i) => {
    const x = (i / (values.length - 1 || 1)) * 100;
    const y = 100 - ((v - min) / range) * 100;
    return `${x},${y}`;
  }).join(" ");
  return (
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-8 w-24" aria-hidden="true">
      <polyline points={points} fill="none" stroke="rgba(138,193,255,0.92)" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ServiceGlyph({ name }: { name: string }) {
  const lower = name.toLowerCase();
  if (lower.includes("auth")) {
    return (
      <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden="true">
        <path d="M12 3 20 7v5.5c0 4.2-2.5 6.8-8 8.5-5.5-1.7-8-4.3-8-8.5V7z" stroke="currentColor" strokeWidth="1.6" />
      </svg>
    );
  }
  if (lower.includes("upload")) {
    return (
      <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden="true">
        <path d="M12 16V6m0 0-3.5 3.5M12 6l3.5 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        <path d="M4 18v.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V18" stroke="currentColor" strokeWidth="1.6" />
      </svg>
    );
  }
  if (lower.includes("api")) {
    return (
      <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden="true">
        <path d="M6 6h12v12H6z" stroke="currentColor" strokeWidth="1.6" />
        <path d="M9 12h6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden="true">
      <circle cx="12" cy="12" r="6.8" stroke="currentColor" strokeWidth="1.6" />
      <path d="M12 8.8v3.5M12 15.8h.01" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function LoadingSkeleton() {
  return (
    <div className="space-y-6" aria-live="polite" aria-busy="true">
      <section className="surface-panel-strong p-6 sm:p-8">
        <div className="h-5 w-32 animate-pulse rounded bg-[var(--surface-soft)]" />
        <div className="mt-3 h-10 w-72 animate-pulse rounded bg-[var(--surface-soft)]" />
        <div className="mt-3 h-5 w-full max-w-2xl animate-pulse rounded bg-[var(--surface-soft)]" />
      </section>
      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="surface-panel-strong p-4">
            <div className="h-5 w-36 animate-pulse rounded bg-[var(--surface-soft)]" />
            <div className="mt-3 h-4 w-full animate-pulse rounded bg-[var(--surface-soft)]" />
          </div>
        ))}
      </section>
    </div>
  );
}

function readPreviewFromLocation(): StatusPreview {
  if (typeof window === "undefined") return "live";
  const preview = String(new URLSearchParams(window.location.search).get("preview") || "")
    .trim()
    .toLowerCase() as StatusPreview;
  return PREVIEW_VALUES.has(preview) ? preview : "live";
}

function normalizeLiveSnapshot(args: {
  ok: boolean;
  payload: Partial<StatusSnapshot> | null;
  statusCode?: number;
}): { snapshot: StatusSnapshot; errorMsg: string | null } {
  if (!args.ok) {
    return {
      snapshot: {
        ok: false,
        service: "cyang.io",
        ts: null,
        error:
          typeof args.payload?.error === "string"
            ? args.payload.error
            : `HTTP_${args.statusCode || 500}`,
      },
      errorMsg: "Live telemetry is temporarily unavailable. Showing fallback service posture.",
    };
  }

  return {
    snapshot: {
      ok: Boolean(args.payload?.ok),
      service: typeof args.payload?.service === "string" ? args.payload.service : "cyang.io",
      ts: typeof args.payload?.ts === "number" && Number.isFinite(args.payload.ts) && args.payload.ts > 0 ? args.payload.ts : null,
      status:
        args.payload?.status === "ok" ||
        args.payload?.status === "degraded" ||
        args.payload?.status === "down"
          ? args.payload.status
          : undefined,
      error: typeof args.payload?.error === "string" ? args.payload.error : undefined,
    },
    errorMsg: null,
  };
}

function statusSnapshotSignature(snapshot: StatusSnapshot | null): string {
  if (!snapshot) return "";
  return [
    snapshot.ok ? "1" : "0",
    snapshot.service || "cyang.io",
    snapshot.status || "",
    snapshot.error || "",
    String(Number(snapshot.ts || 0)),
  ].join(":");
}

function statusPollDelayMs(snapshot: StatusSnapshot | null): number {
  if (!snapshot) return STATUS_POLL_UNHEALTHY_MS;
  if (snapshot.ok && snapshot.status === "ok") return STATUS_POLL_HEALTHY_MS;
  if (snapshot.status === "degraded") return STATUS_POLL_DEGRADED_MS;
  return STATUS_POLL_UNHEALTHY_MS;
}

function statusResumeStaleMs(snapshot: StatusSnapshot | null): number {
  if (!snapshot) return STATUS_RESUME_STALE_UNHEALTHY_MS;
  if (snapshot.ok && snapshot.status === "ok") return STATUS_RESUME_STALE_HEALTHY_MS;
  if (snapshot.status === "degraded") return STATUS_RESUME_STALE_DEGRADED_MS;
  return STATUS_RESUME_STALE_UNHEALTHY_MS;
}

export default function StatusCenterClient({ preview }: { preview?: StatusPreview }) {
  const [previewMode, setPreviewMode] = useState<StatusPreview>(preview ?? "live");
  const [loading, setLoading] = useState((preview ?? "live") === "loading");
  const [refreshing, setRefreshing] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<StatusSnapshot | null>(null);
  const [lastRefreshAt, setLastRefreshAt] = useState<number | null>(null);
  const [subscriptionEmail, setSubscriptionEmail] = useState("");
  const [subscriptionBusy, setSubscriptionBusy] = useState(false);
  const [subscriptionFeedback, setSubscriptionFeedback] = useState<{ tone: "success" | "error"; message: string } | null>(null);
  const lastRefreshAtRef = useRef<number | null>(null);
  const liveMode = previewMode === "live";

  useEffect(() => {
    const nextPreview = preview ?? readPreviewFromLocation();
    setPreviewMode(nextPreview);
    setLoading(nextPreview === "loading");
  }, [preview]);

  const applyLiveSnapshot = useCallback((nextSnapshot: StatusSnapshot, nextErrorMsg: string | null) => {
    const nextSignature = statusSnapshotSignature(nextSnapshot);
    setSnapshot((prev) => (statusSnapshotSignature(prev) === nextSignature ? prev : nextSnapshot));
    setErrorMsg((prev) => (prev === nextErrorMsg ? prev : nextErrorMsg));
    const refreshedAt = Date.now();
    lastRefreshAtRef.current = refreshedAt;
    setLastRefreshAt(refreshedAt);
  }, []);

  const refreshSnapshot = useCallback(async (silent = false) => {
    if (!liveMode) return null;
    if (!silent) setLoading(true);
    setRefreshing(silent);
    try {
      const res = await fetch("/api/health/public", { headers: { Accept: "application/json" } });
      const payload = (await res.json().catch(() => null)) as Partial<StatusSnapshot> | null;
      const next = normalizeLiveSnapshot({ ok: res.ok, payload, statusCode: res.status });
      applyLiveSnapshot(next.snapshot, next.errorMsg);
      return next.snapshot;
    } catch {
      const nextSnapshot = { ok: false, service: "cyang.io", ts: null, error: "NETWORK" } satisfies StatusSnapshot;
      applyLiveSnapshot(nextSnapshot, "Unable to reach live telemetry right now. Showing fallback service posture.");
      return nextSnapshot;
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [applyLiveSnapshot, liveMode]);

  useEffect(() => {
    if (!liveMode) {
      setRefreshing(false);
      setLoading(previewMode === "loading");
      return;
    }
    void refreshSnapshot(false);
  }, [liveMode, previewMode, refreshSnapshot]);

  useConditionalPolling({
    enabled: liveMode,
    getDelayMs: () => statusPollDelayMs(snapshot),
    getResumeDelayMs: () => {
      const lastRefresh = lastRefreshAtRef.current;
      if (!lastRefresh) return 0;
      const staleMs = statusResumeStaleMs(snapshot);
      const ageMs = Date.now() - lastRefresh;
      return ageMs >= staleMs ? 0 : staleMs - ageMs;
    },
    poll: async () => {
      await refreshSnapshot(true);
      return {
        shouldContinue: true,
      };
    },
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = String(window.localStorage.getItem(STATUS_SUBSCRIBE_STORAGE_KEY) || "").trim().toLowerCase();
    if (stored && STATUS_SUBSCRIBE_EMAIL_RE.test(stored)) {
      setSubscriptionEmail(stored);
    }
  }, []);

  const submitSubscription = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const email = subscriptionEmail.trim().toLowerCase();
    if (!STATUS_SUBSCRIBE_EMAIL_RE.test(email)) {
      setSubscriptionFeedback({ tone: "error", message: "Enter a valid email address." });
      return;
    }

    setSubscriptionBusy(true);
    setSubscriptionFeedback(null);
    try {
      const res = await fetch("/api/status/subscribe", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ email }),
      });
      const payload = (await res.json().catch(() => ({}))) as StatusSubscribeApiResponse;
      if (!res.ok || !payload.ok) {
        setSubscriptionFeedback({
          tone: "error",
          message: payload.message || "Unable to subscribe right now. Please try again shortly.",
        });
        return;
      }
      window.localStorage.setItem(STATUS_SUBSCRIBE_STORAGE_KEY, email);
      setSubscriptionFeedback({
        tone: "success",
        message: payload.message || "You are subscribed to daily status updates.",
      });
    } catch {
      setSubscriptionFeedback({
        tone: "error",
        message: "Network error while subscribing. Please try again.",
      });
    } finally {
      setSubscriptionBusy(false);
    }
  }, [subscriptionEmail]);

  const scenario = useMemo<StatusPageScenario>(() => {
    return deriveStatusPageScenario(snapshot, previewMode);
  }, [previewMode, snapshot]);
  const isPreviewScenario = previewMode !== "live" && previewMode !== "loading";
  const snapshotUnavailable = !isPreviewScenario && scenario === "snapshot_unavailable";
  const modeledScenario = !snapshotUnavailable && isPreviewScenario ? (scenario as PlatformState) : null;

  const services = useMemo(() => (modeledScenario ? buildServices(modeledScenario) : []), [modeledScenario]);
  const incidents = useMemo(() => (modeledScenario ? buildIncidents(modeledScenario) : []), [modeledScenario]);
  const uptime = useMemo(() => (modeledScenario ? buildUptime(modeledScenario) : []), [modeledScenario]);
  const state = useMemo<StatusPageScenario>(
    () =>
      snapshotUnavailable
        ? "snapshot_unavailable"
        : modeledScenario
          ? services.reduce<PlatformState>((worst, cur) => (statusRank(cur.status) > statusRank(worst) ? cur.status : worst), "operational")
          : scenario,
    [modeledScenario, scenario, services, snapshotUnavailable]
  );
  const stateUi = useMemo(() => statusConfig(state), [state]);
  const uptimePercent = useMemo(() => {
    if (!uptime.length) return null;
    const avg = uptime.reduce((sum, d) => sum + uptimeWeight(d.status), 0) / Math.max(uptime.length, 1);
    return Math.min(100, avg);
  }, [uptime]);
  const openIncidents = incidents.filter((i) => i.status !== "resolved").length;

  const technical = useMemo(() => ({
    service: snapshot?.service ?? "cyang.io",
    ok: snapshotUnavailable ? null : snapshot?.ok ?? false,
    timestamp: snapshot?.ts ?? null,
    environment: (typeof process.env.NEXT_PUBLIC_APP_ENV === "string" && process.env.NEXT_PUBLIC_APP_ENV.trim()) || "production",
    build: (typeof process.env.NEXT_PUBLIC_BUILD_SHA === "string" && process.env.NEXT_PUBLIC_BUILD_SHA.trim()) || "current",
    status: snapshotUnavailable ? "snapshot_unavailable" : snapshot?.status ?? null,
    error: snapshotUnavailable ? "PUBLIC_SNAPSHOT_UNAVAILABLE" : snapshot?.error ?? null,
  }), [snapshot, snapshotUnavailable]);

  if (loading && !snapshot) return <LoadingSkeleton />;

  return (
    <div className="space-y-6">
      <section className="surface-panel-strong ui-sheen p-6 sm:p-8">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="text-xs uppercase tracking-[0.16em] text-[var(--text-faint)]">Current service posture</div>
            <h2 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950 sm:text-3xl">{stateUi.headline}</h2>
            <p className="mt-3 max-w-3xl text-sm leading-6 text-[var(--text-secondary)] sm:text-base">{stateUi.summary}</p>
            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-[var(--text-faint)]">
              <span className="selection-pill px-2.5 py-1">
                {isPreviewScenario ? "Preview scenario with modeled service detail" : "Live mode with snapshot-backed public status"}
              </span>
              {!isPreviewScenario ? (
                <span className="selection-pill px-2.5 py-1">Per-service cards and history stay unpublished until they have explicit backing data.</span>
              ) : null}
            </div>
          </div>
          <div className="flex flex-col items-end gap-2">
            <span className={`inline-flex items-center gap-2 border px-3 py-1.5 text-sm font-medium ${stateUi.badge}`}>
              <span className={`h-2 w-2 rounded-full ${stateUi.dot}`} />
              {stateUi.label}
            </span>
            <div className="text-xs text-[var(--text-faint)]">
              Last updated {fmtDateTime(snapshot?.ts ?? null)} ({fmtRelative(snapshot?.ts ?? null)})
            </div>
            <div className="flex items-center gap-2">
              <span className="selection-pill px-2.5 py-1 text-[11px] text-[var(--text-secondary)]">
                {liveMode
                  ? snapshotUnavailable
                    ? "Auto-refresh retries while the public snapshot is unavailable"
                    : snapshot?.ok && snapshot.status === "ok"
                    ? "Auto-refresh slows while healthy"
                    : "Auto-refresh accelerates while degraded"
                  : "Preview mode disables live polling"}
              </span>
              <button type="button" onClick={() => void refreshSnapshot(true)} disabled={refreshing} className="btn-base btn-secondary px-3 py-1.5 text-xs disabled:opacity-60">
                {refreshing ? "Refreshing..." : "Refresh now"}
              </button>
            </div>
          </div>
        </div>
      </section>

      {errorMsg ? <div className="border border-[rgba(186,71,50,0.22)] bg-[rgba(186,71,50,0.08)] px-4 py-3 text-sm text-[var(--danger)]">{errorMsg}</div> : null}

      <section className="surface-panel-strong p-6 sm:p-7">
        <div className="grid gap-4 xl:grid-cols-[1.2fr_minmax(0,0.8fr)]">
          <div>
            <div className="text-xs uppercase tracking-[0.16em] text-[var(--text-faint)]">Overall platform status</div>
            <h2 className="mt-2 text-2xl font-semibold text-slate-950">
              {isPreviewScenario ? "Preview summary and modeled coverage" : "Live public snapshot summary"}
            </h2>
            <p className="mt-3 max-w-2xl text-sm text-[var(--text-secondary)]">
              {isPreviewScenario
                ? "Preview mode intentionally models service coverage so incident states, cards, and timelines can be reviewed before publication."
                : "Public traffic reads a cached readiness snapshot. Deeper dependency diagnostics stay on operator-only surfaces until they can be published with explicit backing data."}
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
            <div className="surface-panel-soft p-4">
              <div className="text-xs uppercase tracking-[0.16em] text-[var(--text-faint)]">30-day uptime</div>
              <div className="mt-2 text-2xl font-semibold text-slate-950">
                {snapshotUnavailable ? "Snapshot unavailable" : uptimePercent != null ? `${uptimePercent.toFixed(2)}%` : "Not published here"}
              </div>
              <div className="mt-1 text-sm text-[var(--text-muted)]">
                {snapshotUnavailable
                  ? "This public page is waiting for a fresh cached readiness snapshot before publishing service-wide health claims."
                  : uptimePercent != null
                  ? "Platform availability over the last 30 days."
                  : "Live mode avoids synthesizing uptime history from a single cached snapshot."}
              </div>
            </div>
            <div className="surface-panel-soft p-4">
              <div className="text-xs uppercase tracking-[0.16em] text-[var(--text-faint)]">
                {isPreviewScenario ? "Open incidents" : "Incident publication"}
              </div>
              <div className="mt-2 text-2xl font-semibold text-slate-950">
                {isPreviewScenario ? openIncidents : "Manual"}
              </div>
              <div className="mt-1 text-sm text-[var(--text-muted)]">
                {isPreviewScenario
                  ? openIncidents === 0
                    ? "No unresolved incidents at this time."
                    : "Incident response is currently in progress."
                  : "Historical incident entries are published intentionally rather than inferred from one health check."}
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="surface-panel-strong p-5 sm:p-6">
        <div className="mb-4">
          <div className="text-xs uppercase tracking-[0.16em] text-[var(--text-faint)]">
            {isPreviewScenario ? "Services" : "Service detail"}
          </div>
          <h2 className="mt-2 text-xl font-semibold text-slate-950">
            {isPreviewScenario ? "Modeled core service health" : "Why live mode stays conservative"}
          </h2>
          <p className="mt-1 text-sm text-[var(--text-secondary)]">
            {isPreviewScenario
              ? "At-a-glance status for key product systems in preview mode."
              : "The public status page avoids fabricating service-by-service health cards from a single cached readiness result."}
          </p>
        </div>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {!isPreviewScenario ? (
            <div className="md:col-span-2 xl:col-span-3 surface-panel-soft border-dashed px-5 py-8 text-center">
              <div className="text-lg font-semibold text-slate-950">Live snapshot mode</div>
              <p className="mx-auto mt-2 max-w-2xl text-sm text-[var(--text-secondary)]">
                Live public status is currently backed by the cached readiness snapshot above. Per-service latency,
                uptime, and trend cards only appear in preview mode, where they are explicitly presented as modeled
                scenarios rather than published live facts.
              </p>
            </div>
          ) : snapshotUnavailable ? (
            <div className="md:col-span-2 xl:col-span-3 surface-panel-soft border-dashed px-5 py-8 text-center">
              <div className="text-lg font-semibold text-slate-950">Service-wide snapshot unavailable</div>
              <p className="mx-auto mt-2 max-w-2xl text-sm text-[var(--text-secondary)]">
                Public service cards are hidden until a fresh readiness snapshot is available. This avoids showing synthetic per-service states without current backing data.
              </p>
              <div className="mt-4 text-xs text-[var(--text-faint)]">
                Last refresh attempt {fmtDateTime(lastRefreshAt)} ({fmtRelative(lastRefreshAt)})
              </div>
            </div>
          ) : services.map((service) => {
            const ui = statusConfig(service.status);
            return (
              <article key={service.key} className="selection-tile p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2 text-sm font-medium text-slate-950">
                      <span className="inline-flex h-7 w-7 items-center justify-center border border-[var(--border-subtle)] bg-white text-[var(--text-secondary)] shadow-[var(--shadow-soft)]">
                        <ServiceGlyph name={service.name} />
                      </span>
                      <span>{service.name}</span>
                    </div>
                    <p className="mt-2 text-xs leading-5 text-[var(--text-faint)]">{service.description}</p>
                  </div>
                  <span className={`inline-flex shrink-0 items-center border px-2 py-1 text-[11px] ${ui.badge}`}>{ui.short}</span>
                </div>
                <div className="mt-3 flex items-center justify-between text-xs text-[var(--text-faint)]">
                  <span>{service.latencyMs != null ? `${service.latencyMs}ms p95` : "Latency n/a"}</span>
                  <span>{service.uptime30d.toFixed(2)}% uptime</span>
                </div>
                <div className="mt-2 flex justify-end">
                  <UptimeSparkline values={service.trend} />
                </div>
              </article>
            );
          })}
        </div>
      </section>

      <section className="surface-panel-strong p-5 sm:p-6">
        <div className="mb-4">
          <div className="text-xs uppercase tracking-[0.16em] text-[var(--text-faint)]">Incident history</div>
          <h2 className="mt-2 text-xl font-semibold text-slate-950">Recent events</h2>
        </div>
        {!isPreviewScenario ? (
          <div className="surface-panel-soft border-dashed px-5 py-8 text-center">
            <div className="text-lg font-semibold text-slate-950">Live snapshot mode</div>
            <p className="mx-auto mt-2 max-w-2xl text-sm text-[var(--text-secondary)]">
              This public page shows the current cached service snapshot. Historical incident publishing stays manual so
              we do not fabricate timelines from a single health check.
            </p>
          </div>
        ) : incidents.length === 0 ? (
          <div className="surface-panel-soft border-dashed px-5 py-8 text-center">
            <div className="text-lg font-semibold text-slate-950">No recent incidents</div>
            <p className="mx-auto mt-2 max-w-2xl text-sm text-[var(--text-secondary)]">We have not recorded incidents in the current reporting window. Core systems are operating as expected.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {incidents.map((incident) => {
              const ui = incidentStateConfig(incident.status);
              return (
                <article key={incident.id} className="selection-tile p-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <h3 className="text-sm font-semibold text-slate-950">{incident.title}</h3>
                      <p className="mt-1 text-sm text-[var(--text-secondary)]">{incident.summary}</p>
                    </div>
                    <span className={`inline-flex items-center border px-2 py-1 text-[11px] ${ui.badge}`}>{ui.label}</span>
                  </div>
                  <div className="mt-3 text-xs text-[var(--text-faint)]">Started {fmtDateTime(incident.startedAt)}</div>
                  <div className="mt-3 space-y-2 border-l border-[var(--border-subtle)] pl-3">
                    {incident.updates.map((update, idx) => {
                      const updateUi = incidentStateConfig(update.status);
                      return (
                        <div key={`${incident.id}-${idx}`} className="surface-panel-soft p-3">
                          <div className="flex flex-wrap items-center gap-2 text-xs">
                            <span className={`inline-flex border px-2 py-0.5 ${updateUi.badge}`}>{updateUi.label}</span>
                            <span className="text-[var(--text-faint)]">{fmtDateTime(update.timestamp)}</span>
                          </div>
                          <p className="mt-2 text-sm text-[var(--text-secondary)]">{update.message}</p>
                        </div>
                      );
                    })}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      <section className="surface-panel-strong p-5 sm:p-6">
        <div className="mb-4">
          <div className="text-xs uppercase tracking-[0.16em] text-[var(--text-faint)]">{isPreviewScenario ? "Reliability" : "Snapshot model"}</div>
          <h2 className="mt-2 text-xl font-semibold text-slate-950">{isPreviewScenario ? "Uptime over 30 days" : "How this status page stays cheap and accurate"}</h2>
        </div>
        {isPreviewScenario ? (
          <div className="grid gap-4 xl:grid-cols-[1.35fr_minmax(0,0.65fr)]">
            <div className="surface-panel-soft p-4">
              <div className="mt-3 grid grid-cols-[repeat(15,minmax(0,1fr))] gap-1 sm:grid-cols-[repeat(30,minmax(0,1fr))]">
                {uptime.map((day) => (
                  <div key={day.date} className={`h-8 rounded ${dailyBarClass(day.status)}`} title={`${fmtDateTime(day.date)} · ${statusConfig(day.status).short}`} />
                ))}
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-[var(--text-faint)]">
                <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-emerald-300/90" />Operational</span>
                <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-amber-300/90" />Degraded</span>
                <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-orange-300/90" />Partial outage</span>
                <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-rose-300/90" />Major outage</span>
                <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-sky-300/90" />Maintenance</span>
              </div>
            </div>
            <div className="surface-panel-soft p-4">
              <div className="text-xs uppercase tracking-[0.16em] text-[var(--text-faint)]">Highlights</div>
              <div className="mt-3 text-3xl font-semibold text-slate-950">{uptimePercent?.toFixed(2)}%</div>
              <div className="mt-1 text-sm text-[var(--text-muted)]">Platform uptime over the last 30 days.</div>
              <div className="mt-4 space-y-2 text-sm text-[var(--text-secondary)]">
                <div className="surface-panel px-3 py-2"><span className="font-medium text-slate-950">Open incidents:</span> {openIncidents}</div>
                <div className="surface-panel px-3 py-2"><span className="font-medium text-slate-950">Last refresh:</span> {lastRefreshAt ? fmtDateTime(lastRefreshAt) : "Pending"}</div>
              </div>
            </div>
          </div>
        ) : (
          <div className="grid gap-4 xl:grid-cols-3">
            <div className="surface-panel-soft p-4">
              <div className="text-xs uppercase tracking-[0.16em] text-[var(--text-faint)]">Current source</div>
              <div className="mt-2 text-lg font-semibold text-slate-950">Cached public health snapshot</div>
              <div className="mt-1 text-sm text-[var(--text-muted)]">Anonymous traffic reads a lightweight summary instead of live dependency fan-out.</div>
            </div>
            <div className="surface-panel-soft p-4">
              <div className="text-xs uppercase tracking-[0.16em] text-[var(--text-faint)]">Refresh policy</div>
              <div className="mt-2 text-lg font-semibold text-slate-950">Manual plus slow auto-refresh</div>
              <div className="mt-1 text-sm text-[var(--text-muted)]">Live mode only polls while visible, backs off when healthy, and resumes immediately only once the cached snapshot is stale.</div>
            </div>
            <div className="surface-panel-soft p-4">
              <div className="text-xs uppercase tracking-[0.16em] text-[var(--text-faint)]">Historical reporting</div>
              <div className="mt-2 text-lg font-semibold text-slate-950">Published intentionally</div>
              <div className="mt-1 text-sm text-[var(--text-muted)]">We do not synthesize incident timelines or uptime history from a single transient health check.</div>
            </div>
          </div>
        )}
      </section>

      <details className="surface-panel-strong p-4 sm:p-5">
        <summary className="cursor-pointer list-none text-sm font-semibold text-slate-950">Technical diagnostics (advanced)</summary>
        <div className="surface-panel mt-3 p-4">
          <p className="mb-3 text-xs text-[var(--text-faint)]">
            This section is intended for engineering review and integration troubleshooting.
          </p>
          {snapshotUnavailable ? (
            <div className="mb-3 border border-[rgba(186,104,48,0.18)] bg-[rgba(186,104,48,0.06)] px-3 py-2 text-xs text-[#8e4d14]">
              The cached public readiness snapshot is unavailable or stale, so this block only shows the current public fallback state.
            </div>
          ) : null}
          <pre className="overflow-auto whitespace-pre-wrap text-xs leading-6 text-[var(--text-secondary)]">
{JSON.stringify(technical, null, 2)}
          </pre>
          <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-[var(--text-faint)]">
            <a href="/api/health/live" target="_blank" rel="noreferrer" className="subtle-link underline">Live</a>
            {!snapshotUnavailable ? <a href="/api/health/ready" target="_blank" rel="noreferrer" className="subtle-link underline">Ready</a> : null}
          </div>
        </div>
      </details>

      <section className="surface-panel-strong p-4 sm:p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-base font-semibold text-slate-950">Need help or updates?</h2>
            <p className="mt-1 text-sm text-[var(--text-secondary)]">Contact support for account-specific questions, or subscribe for daily platform updates delivered at 6:00 AM UTC.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <a href="mailto:support@cyang.io" className="btn-base btn-secondary px-3 py-2">Contact support</a>
            <Link href="/contact" className="btn-base btn-secondary px-3 py-2">Contact page</Link>
            <Link href="/security-disclosure" className="btn-base btn-secondary px-3 py-2">Security docs</Link>
          </div>
        </div>
        <form onSubmit={submitSubscription} className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center" noValidate>
          <label className="sr-only" htmlFor="status-subscribe-email">Email address</label>
          <input
            id="status-subscribe-email"
            type="email"
            inputMode="email"
            autoComplete="email"
            placeholder="you@company.com"
            value={subscriptionEmail}
            onChange={(event) => setSubscriptionEmail(event.target.value)}
            className="field-input h-11 w-full px-3.5 text-sm sm:max-w-sm"
            required
          />
          <button
            type="submit"
            disabled={subscriptionBusy}
            className="btn-base btn-primary px-4 py-2.5 text-sm font-medium disabled:opacity-60"
          >
            {subscriptionBusy ? "Subscribing..." : "Subscribe to updates"}
          </button>
        </form>
        {subscriptionFeedback ? (
          <div
            className={`mt-3 border px-3 py-2 text-sm ${
              subscriptionFeedback.tone === "success"
                ? "border-[rgba(40,136,88,0.18)] bg-[rgba(40,136,88,0.08)] text-[var(--success)]"
                : "border-[rgba(186,71,50,0.22)] bg-[rgba(186,71,50,0.08)] text-[var(--danger)]"
            }`}
            role="status"
            aria-live="polite"
          >
            {subscriptionFeedback.message}
          </div>
        ) : null}
      </section>

    </div>
  );
}
