import { redirect } from "next/navigation";
import { DataTable, EmptyState, FilterBar, PageHeader, Pagination, SectionCard, StatusBadge, UnavailableState } from "@/components/DesignSystem";
import { ProtectedPage } from "@/components/ProtectedPage";
import { can } from "@/lib/access";
import { getAuditPage } from "@/lib/audit";
import { getPreviewUser } from "@/lib/authz.server";
import { resolveWorkspaceContext } from "@/lib/workspace-context";

export const dynamic = "force-dynamic";
function href(eventType: string, pageSize: number, cursor: string) { const query = new URLSearchParams({ limit: String(pageSize), cursor }); if (eventType) query.set("eventType", eventType); return `/audit?${query}`; }

export default async function AuditPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await getPreviewUser(); if (!user) redirect("/sign-in"); if (!can(user.role, "manageUsers")) redirect("/unauthorized");
  const input = await searchParams; let page: Awaited<ReturnType<typeof getAuditPage>> | null = null;
  try { const context = await resolveWorkspaceContext(user); page = await getAuditPage(context, { eventType: input.eventType, cursor: input.cursor, pageSize: input.limit }); } catch { /* Safe unavailable state. */ }
  return <ProtectedPage permission="manageUsers"><div className="content">
    <PageHeader eyebrow="Administration" title="Audit activity" description="Durable, organization-scoped security and workflow events with safe metadata, deterministic ordering, and bounded keyset pagination." />
    <SectionCard><form action="/audit" method="get"><FilterBar><div className="field"><label htmlFor="eventType">Event type</label><input id="eventType" name="eventType" maxLength={80} defaultValue={page?.eventType ?? ""} placeholder="For example: import.validation" /></div><div className="field"><label htmlFor="audit-limit">Rows per page</label><select id="audit-limit" name="limit" defaultValue={String(page?.pageSize ?? 50)}><option value="25">25</option><option value="50">50</option><option value="100">100</option></select></div><button className="button" type="submit">Filter events</button></FilterBar></form></SectionCard>
    <SectionCard title="Event log" badge={<StatusBadge tone="info">Durable database log</StatusBadge>}>
      {!page ? <UnavailableState title="Audit activity unavailable" description="No internal exception details are shown. Try again after the database connection is restored." /> : page.events.length === 0 ? <EmptyState title="No matching audit events" description="No events matched the current organization-scoped filter." /> : <><DataTable caption="Audit events" headers={["Timestamp (UTC)", "Event", "Actor", "Subject"]}>{page.events.map((event) => <tr key={event.id}><td>{event.created_at}</td><td><strong>{event.event_type}</strong></td><td>{event.actor_user_id ? "Authenticated actor" : "System"}</td><td>{event.subject_type ?? "—"}</td></tr>)}</DataTable>{page.nextCursor ? <Pagination label={`Showing ${page.events.length} events`} nextHref={href(page.eventType, page.pageSize, page.nextCursor)} /> : null}</>}
    </SectionCard>
  </div></ProtectedPage>;
}
