import Link from "next/link";
import { redirect } from "next/navigation";
import {
  DataTable,
  DisclosureCard,
  EmptyState,
  PageHeader,
  Pagination,
  SectionCard,
  StatusBadge,
  type StatusTone,
  UnavailableState,
} from "@/components/DesignSystem";
import { DocumentDeleteButton } from "@/components/DocumentDeleteButton";
import { DocumentApprovalButton } from "@/components/DocumentApprovalButton";
import { DocumentUploadForm } from "@/components/DocumentUploadForm";
import { MobileDocumentIntake } from "@/components/MobileDocumentIntake";
import { ProtectedPage } from "@/components/ProtectedPage";
import { can } from "@/lib/access";
import { getPreviewUser } from "@/lib/authz.server";
import { documentUploadVisibilities } from "@/lib/document-upload";
import { getDocumentsPage, type DocumentVisibility } from "@/lib/documents";
import { resolveWorkspaceContext } from "@/lib/workspace-context";

const visibilityLabels: Record<DocumentVisibility, string> = {
  local_admin_only: "Local admin only",
  membership_management: "Membership management",
  cat_admin_only: "801 administrator only",
  cat_lead_scope: "LCAT scope",
  cat_member_scope: "CATs",
  uploader_hierarchy: "Me and higher roles",
  everyone: "Everyone",
};

const visibilityDescriptions: Record<DocumentVisibility, string> = {
  local_admin_only: "Visible only to System Owners and Local Administrators.",
  membership_management: "Visible to System Owners, Local Administrators, and Membership Data Managers.",
  cat_admin_only: "Visible to System Owners, Local Administrators, and 801 Administrators.",
  cat_lead_scope: "Visible to System Owners, Local Administrators, 801 Administrators, and LCATs.",
  cat_member_scope: "Visible to System Owners, Local Administrators, 801 Administrators, LCATs, and CATs.",
  uploader_hierarchy: "Visible to you and users above your role in the Local 801 access hierarchy.",
  everyone: "Visible to every approved user in this Local 801 workspace.",
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

function uploaderLabel(value: string) {
  return /^Protected user [0-9a-f-]{36}$/i.test(value) ? "Protected user" : value;
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
  const hasCursor = typeof input.cursor === "string" && input.cursor.length > 0;
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
  const canApproveDocuments = can(user.role, "approveDocuments");
  const uploadOptions = documentUploadVisibilities(user.role).map((visibility) => ({
    value: visibility,
    label: visibilityLabels[visibility],
    description: visibilityDescriptions[visibility],
  }));

  return <ProtectedPage permission="viewDocuments"><div className="content route-documents-page library-first-page">
    <PageHeader
      eyebrow="Information"
      title="Documents"
      description="Upload, review, approve, and open encrypted Local 801 documents available to you."
    />
    {uploadOptions.length > 0 ? <DisclosureCard
      title="Upload a document"
      description="Choose a file and who should be able to see it. Files must pass malware scanning before encrypted storage."
      className="route-primary-panel upload-record-panel"
    >
      <DocumentUploadForm visibilityOptions={uploadOptions} />
    </DisclosureCard> : null}
    {uploadOptions.length > 0 ? <MobileDocumentIntake visibilityOptions={uploadOptions} /> : null}
    <SectionCard
      title="Document library"
      description={page ? `${page.documents.length} ${page.documents.length === 1 ? "document is" : "documents are"} shown on this page.` : "The encrypted document index could not be loaded safely."}
    >
      {!page ? (
        <UnavailableState
          title="Documents unavailable"
          description="We couldn’t load the document list. The encrypted files themselves are left unchanged."
        />
      ) : page.documents.length === 0 ? (
        <EmptyState
          title="No documents to show"
          description="No documents have been uploaded for you or shared with a scope you can access."
        />
      ) : <>
        <DataTable
          caption="Documents"
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
            <td>
              {visibilityLabels[document.visibility]}
              <div className="muted">{visibilityDescriptions[document.visibility]}</div>
            </td>
            <td>{uploaderLabel(document.uploaderName)}</td>
            <td>{createdDate(document.createdAt)}</td>
            <td>
              <div className="inline-actions">
                <a className="button secondary compact-button" href={`/api/documents/${document.downloadHandle}/download`}>Download</a>
                {canApproveDocuments && document.status === "under_review" ? (
                  <DocumentApprovalButton handle={document.downloadHandle} title={document.title} />
                ) : null}
                {canManageDocuments ? <Link className="button secondary compact-button" href={`/documents/${document.downloadHandle}`}>Tags &amp; links</Link> : null}
                {canManageDocuments ? (
                  <DocumentDeleteButton handle={document.downloadHandle} title={document.title} />
                ) : null}
              </div>
            </td>
          </tr>)}
        </DataTable>
        <Pagination
          label={`Showing up to ${page.pageSize} documents`}
          historyBackFallbackHref={hasCursor ? `/documents?limit=${page.pageSize}` : null}
          nextHref={page.nextCursor ? `/documents?limit=${page.pageSize}&cursor=${encodeURIComponent(page.nextCursor)}` : null}
        />
      </>}
    </SectionCard>
    <DisclosureCard title="How documents are protected" description="Storage and encryption details remain private." className="route-secondary-panel">
      <p className="page-copy">Files are scanned before storage, encrypted, and checked against your role on every request. Storage keys, encryption metadata, integrity hashes, and raw storage URLs are never shown here.</p>
    </DisclosureCard>
  </div></ProtectedPage>;
}
