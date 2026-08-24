import { NextResponse } from "next/server";
import { requirePreviewUser } from "@/lib/authz.server";
import { getWorkNotifications } from "@/lib/work-notifications";
import { resolveWorkspaceContext } from "@/lib/workspace-context";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const noStore = {
  "Cache-Control": "private, no-store, max-age=0, must-revalidate",
};

export async function GET() {
  const auth = await requirePreviewUser("viewPersonalWorkspace");
  if (!auth.ok) return auth.response;

  try {
    const context = await resolveWorkspaceContext(auth.user);
    const notifications = await getWorkNotifications(context);
    return NextResponse.json({
      count: notifications.length,
      items: notifications.slice(0, 5).map(({ key, title, detail, href, urgency, dueAt }) => ({
        key,
        title,
        detail,
        href,
        urgency,
        dueAt,
      })),
    }, { headers: noStore });
  } catch (error) {
    const name = error instanceof Error ? error.name : "UnknownError";
    console.error("[local801-notification-summary-safe-failure]", JSON.stringify({ name }));
    return NextResponse.json({
      error: "NOTIFICATIONS_UNAVAILABLE",
      message: "Notifications are temporarily unavailable.",
    }, { status: 503, headers: noStore });
  }
}
