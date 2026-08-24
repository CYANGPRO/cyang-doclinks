import { redirect } from "next/navigation";
import { DataTable, DisclosureCard, EmptyState, FilterBar, PageHeader, Pagination, SectionCard, StatusBadge, UnavailableState } from "@/components/DesignSystem";
import { ProtectedPage } from "@/components/ProtectedPage";
import { can } from "@/lib/access";
import { auditEventFilterOptions, getAuditDisplayPage } from "@/lib/audit-display";
import { getPreviewUser } from "@/lib/authz.server";
import { resolveWorkspaceContext } from "@/lib/workspace-context";

export const dynamic = "force-dynamic";

function href(eventType: string, pageSize: number, cursor: string | null) {
  const query = new URLSearchParams({ limit: String(pageSize) });
  if (cursor) query.set("cursor", cursor);
  if (eventType) query.set("eventType", eventType);
  return `/audit?${query}`;
}

function displayTimestamp(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Timestamp unavailable";
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "America/Chicago",
  }).format(date);
}

export default async function AuditPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await getPreviewUser();
  if (!user) redirect("/sign-in");
  if (!can(user.role, "manageUsers")) redirect("/unauthorized");

  const input = await searchParams;
  const hasCursor = typeof input.cursor === "string" && input.cursor.length > 0;
  let page: Awaited<ReturnType<typeof getAuditDisplayPage>> | null = null;
  try {
    const context = await resolveWorkspaceContext(user);
    page = await getAuditDisplayPage(context, {
      eventType: input.eventType,
      cursor: input.cursor,
      pageSize: input.limit,
    });
  } catch {
    // Safe unavailable state: never expose protected-PII, database, or decryption details.
  }

  const selectedKnown = page?.eventType && auditEventFilterOptions.some((option) => option.value === page?.eventType);

  return <ProtectedPage permission="manageUsers"><div className="content route-audit-page queue-first-page">
    <PageHeader
      eyebrow="Administration"
      title="Audit activity"
      description="See who made important security or workflow changes, when they happened, and what area was affected. Internal IDs and audit payloads stay hidden."
    />

    <DisclosureCard title="Filter activity" description="Choose an activity type or show everything." defaultOpen={Boolean(page?.eventType)} className="route-secondary-panel queue-filter-panel">
      <form action="/audit" method="get">
        <FilterBar>
          <div className="field">
            <label htmlFor="eventType">Activity</label>
            <select id="eventType" name="eventType" defaultValue={page?.eventType ?? ""}>
              <option value="">All activity</option>
              {page?.eventType && !selectedKnown ? <option value={page.eventType}>{page.eventType.replaceAll("_", " ").replaceAll(".", " ")}</option> : null}
              {auditEventFilterOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="audit-limit">Results per page</label>
            <select id="audit-limit" name="limit" defaultValue={String(page?.pageSize ?? 50)}>
              <option value="25">25</option>
              <option value="50">50</option>
              <option value="100">100</option>
            </select>
          </div>
          <button className="button" type="submit">Apply filter</button>
        </FilterBar>
      </form>
    </DisclosureCard>

    <SectionCard
      title="Activity log"
      description="Review the filtered security and workflow events below. Actor names appear only when your admin access permits a protected read; internal event payloads remain hidden."
      badge={page?.protectedActorNames ? <StatusBadge tone="info">Protected PII</StatusBadge> : null}
    >
      {!page ? <UnavailableState title="Audit activity unavailable" description="We couldn’t load the protected audit view. No internal error details are shown." />
        : page.events.length === 0 ? <EmptyState title="No matching activity" description="No audit events match the filter you chose." />
        : <>
          <DataTable caption="Audit activity" headers={["When", "What happened", "Actor", "Affected area"]}>
            {page.events.map((event) => <tr key={event.id}>
              <td>{displayTimestamp(event.created_at)}</td>
              <td>
                <strong>{event.eventLabel}</strong>
              </td>
              <td>{event.actor_user_id ? event.actorDisplayName ?? "Protected user unavailable" : "System"}</td>
              <td>{event.subjectLabel}</td>
            </tr>)}
          </DataTable>
          <Pagination
            label={`Showing ${page.events.length} events`}
            historyBackFallbackHref={hasCursor ? href(page.eventType, page.pageSize, null) : null}
            nextHref={page.nextCursor ? href(page.eventType, page.pageSize, page.nextCursor) : null}
          />
        </>}
    </SectionCard>
  </div></ProtectedPage>;
}
