import { DataTable, StatusBadge } from "@/components/DesignSystem";
import { getPreviewUser } from "@/lib/authz.server";
import { explanationKey, getImportReviewExplanations } from "@/lib/import-review-explanations";
import type { ImportReviewDetail } from "@/lib/import-review";
import { resolveWorkspaceContext } from "@/lib/workspace-context";

function genericExplanation(category: ImportReviewDetail["rows"][number]["category"]) {
  switch (category) {
    case "unchanged_existing": return "Exact identity match; no imported changes detected.";
    case "existing_with_changes": return "Existing person matched; one or more imported fields differ.";
    case "proposed_new": return "CAT did not find an exact employee or member ID match.";
    case "needs_attention": return "Manual review is required before this row can proceed.";
    case "rejected": return "The row was rejected during validation.";
  }
}

export async function ImportReviewDetailTable({
  batchId,
  detail,
}: {
  batchId: string;
  detail: ImportReviewDetail;
}) {
  const explanationMap = new Map<string, Awaited<ReturnType<typeof getImportReviewExplanations>>[number]>();
  try {
    const user = await getPreviewUser();
    if (user) {
      const context = await resolveWorkspaceContext(user);
      const explanations = await getImportReviewExplanations(
        { organizationId: context.organizationId, userId: context.userId, role: context.role },
        batchId,
        detail.rows.map((row) => ({ sheetName: row.sheet_name, sourceRowNumber: row.source_row_number })),
      );
      for (const explanation of explanations) {
        explanationMap.set(explanationKey(explanation.sheetName, explanation.sourceRowNumber), explanation);
      }
    }
  } catch {
    // Explanations are assistive only. The existing protected review classification remains authoritative.
  }

  return <DataTable caption="Import review rows with classification explanations" headers={["Source", "Person", "Work", "Status", "Why"]}>
    {detail.rows.map((row, index) => {
      const explanation = explanationMap.get(explanationKey(row.sheet_name, row.source_row_number));
      const why = explanation?.reasons.length
        ? explanation.reasons
        : explanation?.changeFields.length
          ? [`Changed fields: ${explanation.changeFields.join(", ")}.`]
          : [genericExplanation(row.category)];
      return <tr key={`${row.sheet_name}-${row.source_row_number}-${index}`}>
        <td>{row.sheet_name}<div className="muted">Row {row.source_row_number}</div></td>
        <td>
          <strong>{[row.first_name, row.last_name].filter(Boolean).join(" ") || "Unnamed row"}</strong>
          <div className="muted">{row.work_email || "No work email"}</div>
          {row.work_phone ? <div className="muted">Work phone supplied</div> : null}
          {row.personal_email ? <div className="muted">Personal email supplied</div> : null}
        </td>
        <td>{row.department || "Department unavailable"}<div className="muted">{row.classification || "Classification unavailable"}</div></td>
        <td><StatusBadge tone={row.category === "needs_attention" || row.category === "rejected" ? "danger" : row.category === "unchanged_existing" ? "ready" : "pending"}>{row.category.replaceAll("_", " ")}</StatusBadge></td>
        <td>
          <ul className="compact-reason-list">
            {why.map((reason) => <li key={reason}>{reason}</li>)}
          </ul>
          {explanation?.changeFields.length && explanation.reasons.length
            ? <div className="muted">Changed fields: {explanation.changeFields.join(", ")}.</div>
            : null}
        </td>
      </tr>;
    })}
  </DataTable>;
}
