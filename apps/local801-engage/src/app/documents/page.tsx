import { redirect } from "next/navigation";
import {
  AlertBanner,
  DataTable,
  EmptyState,
  PageHeader,
  Pagination,
  SectionCard,
  StatusBadge,
  type StatusTone,
  UnavailableState,
} from "@/components/DesignSystem";
import { DocumentDeleteButton } from "@/components/DocumentDeleteButton";
import { DocumentUploadForm } from "@/components/DocumentUploadForm";
import { ProtectedPage } from "@/components/ProtectedPage";
import { can } from "@/lib/access";
import { getPreviewUser } from "@/lib/authz.server";
import { documentUploadVisibilities } from "@/lib/document-upload";
import { getDocumentsPage, type DocumentVisibility } from "@/lib/documents";
import { resolveWorkspaceContext } from "@/lib/workspace-context";

const visibilityLabels: Record<DocumentVisibility, string> = {
  local_admin_only: "Local admin only",
  membership_management: "Membership management",
  cat_admin_only: "CAT admin only",
  cat_lead_scope: "CAT lead scope",
  cat_member_scope: "CAT members",
};

const mediaTypeLabels: Record<string, string> = {
  "application/pdf": "PDF",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "Word",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "Excel",
  "text/csv": "CSV",
  "text/plain": "Text",
};

function statusTone(status: string): StatusTone {
  if (status === "active" || status === "approved") return "ready";
  if (status === "under_review") return "pending";
  if (status === "superseded") return "warning";
  return "neutral";
}

function statusLabel(status: string) {
  return status.replaceAll("_", " ");
}

function documentType(mediaType: string | null, filename: string | null) {
  if (mediaType && mediaTypeLabels[mediaType]) return mediaTypeLabels[mediaType];
  const extension = filename?.split(".").at(-1)?.trim();
  return extension && extension.length <= 8 ? extension.toUpperCase() : "Unknown";
}

function createdDate(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeZone: "America/Chicago",
  }).format(new Date(value));
}

export default async function DocumentsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await getPreviewUser();
  if (!user) redirect("/sign-in");
  if (!can(user.role, "viewDocuments")) redirect("/unauthorized");

  const input = await searchParams;
  let page: Awaited<ReturnType<typeof getDocumentsPage>> | null = null;

  try {
    const context = await resolveWorkspaceContext(user);
    page = await getDocumentsPage(context, {
      cursor: input.cursor,
      pageSize: input.limit,
    });
  } catch {
    // Fail closed with a safe unavailable state. Never substitute mock metadata.
  }

  const canManageDocuments = can(user.role, "manageDocuments");
  const uploadOptions = canManageDocuments
    ? documentUploadVisibilities(user.role).map((visibility) => ({ value: visibility, label: visibilityLabels[visibility] }))
    : [];

  return <ProtectedPage permission="viewDocuments"><div className="content">
    <PageHeader
      eyebrow="Information"
      title="Documents"
      description="Organization-scoped documents are server-filtered by visibility. Authorized uploads are malware-scanned before encryption and private storage."
    />
    <AlertBanner title="Private encrypted storage">
      Storage keys, encryption metadata, integrity hashes, cleanup state, and raw object-store URLs are never exposed in this interface.
    </AlertBanner>
    {uploadOptions.length > 0 ? <DocumentUploadForm visibilityOptions={uploadOptions} /> : null}
    <SectionCard
      title="Document library"
      badge={<StatusBadge tone="info">{page ? `${page.documents.length} shown` : "Metadata unavailable"}</StatusBadge>}
    >
      {!page ? (
        <UnavailableState
          title="Document metadata unavailable"
          description="The encrypted document services remain unchanged; no synthetic document metadata is substituted."
        />
      ) : page.documents.length === 0 ? (
        <EmptyState
          title="No visible documents"
          description="No document metadata is available within your authorized visibility scopes."
        />
      ) : <>
        <DataTable
          caption="Authorized document metadata"
          headers={["Document", "Category", "File", "Visibility", "Uploader", "Created", "Action"]}
        >
          {page.documents.map((document) => <tr key={document.downloadHandle}>
            <td>
              <strong>{document.title}</strong>
              <div><StatusBadge tone={statusTone(document.status)}>{statusLabel(document.status)}</StatusBadge></div>
            </td>
            <td>{document.category}</td>
            <td>
              <strong>{documentType(document.mediaType, document.originalFilename)}</strong>
              <div className="muted">{document.originalFilename ?? "Filename unavailable"}</div>
            </td>
            <td>{visibilityLabels[document.visibility]}</td>
            <td>{document.uploaderName}</td>
            <td>{createdDate(document.createdAt)}</td>
            <td>
              <div style={{ alignItems: "center", display: "flex", flexWrap: "wrap", gap: 8 }}>
                <a href={`/api/documents/${document.downloadHandle}/download`}>Download</a>
                {canManageDocuments ? (
                  <DocumentDeleteButton handle={document.downloadHandle} title={document.title} />
                ) : null}
              </div>
            </td>
          </tr>)}
        </DataTable>
        <Pagination
          label={`Showing up to ${page.pageSize} documents`}
          nextHref={page.nextCursor ? `/documents?limit=${page.pageSize}&cursor=${encodeURIComponent(page.nextCursor)}` : null}
        />
      </>}
    </SectionCard>
  </div></ProtectedPage>;
}
