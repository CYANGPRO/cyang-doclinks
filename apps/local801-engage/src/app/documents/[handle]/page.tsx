import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { DocumentMetadataManager } from "@/components/DocumentMetadataManager";
import { PageHeader, SectionCard, UnavailableState } from "@/components/DesignSystem";
import { ProtectedPage } from "@/components/ProtectedPage";
import { can } from "@/lib/access";
import { getPreviewUser } from "@/lib/authz.server";
import { getDocumentMetadataWorkspace } from "@/lib/document-metadata";
import { resolveWorkspaceContext } from "@/lib/workspace-context";

export default async function DocumentMetadataPage({ params }: { params: Promise<{ handle: string }> }) {
  const [{ handle }, user] = await Promise.all([params, getPreviewUser()]);
  if (!user) redirect("/sign-in");
  if (!can(user.role, "manageDocuments")) redirect("/unauthorized");
  let workspace: Awaited<ReturnType<typeof getDocumentMetadataWorkspace>> | null = null;
  let unavailable = false;
  try { workspace = await getDocumentMetadataWorkspace(await resolveWorkspaceContext(user), handle); }
  catch (error) { if (error && typeof error === "object" && (error as { code?: string }).code === "DOCUMENT_NOT_FOUND") notFound(); unavailable = true; }
  return <ProtectedPage permission="manageDocuments"><div className="content record-workspace-page">
    <PageHeader eyebrow="Information · Documents" title={workspace?.document.title ?? "Document details"} description="Add tags and connect this encrypted document to the Local 801 work it belongs with." actions={<Link className="button secondary" href="/documents">Back to documents</Link>} />
    <SectionCard title="Document tags and relationships" description="Organize this document with audited tags and links to related Local 801 work records.">
      {unavailable || !workspace ? <UnavailableState title="Document metadata unavailable" description="No metadata changes were made." /> : <DocumentMetadataManager documentHandle={handle} tags={workspace.tags} relationships={workspace.relationships} targets={workspace.targets} />}
    </SectionCard>
    <SectionCard title="Protected-content boundary"><p className="page-copy">Tags and relationships never contain document contents or protected member records. The file remains encrypted and every download remains role-checked and network-only.</p></SectionCard>
  </div></ProtectedPage>;
}
