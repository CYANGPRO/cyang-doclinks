import { can, type Permission, type Role } from "./access.ts";

export const LEGACY_DOCUMENT_VISIBILITIES = [
  "local_admin_only",
  "membership_management",
  "cat_admin_only",
  "cat_lead_scope",
  "cat_member_scope",
] as const;

export const DOCUMENT_VISIBILITIES = [
  ...LEGACY_DOCUMENT_VISIBILITIES,
  "uploader_hierarchy",
  "everyone",
] as const;

export const DOCUMENT_UPLOAD_VISIBILITIES = ["uploader_hierarchy", "everyone"] as const;

export type LegacyDocumentVisibility = (typeof LEGACY_DOCUMENT_VISIBILITIES)[number];
export type DocumentVisibility = (typeof DOCUMENT_VISIBILITIES)[number];
export type DocumentUploadVisibility = (typeof DOCUMENT_UPLOAD_VISIBILITIES)[number];

const roleHierarchy: readonly Role[] = [
  "system_owner",
  "local_admin",
  "membership_data_manager",
  "cat_admin",
  "cat_lead",
  "cat_member",
  "report_viewer",
];

const legacyVisibilityPermission: Record<LegacyDocumentVisibility, Permission> = {
  local_admin_only: "viewLocalAdminDocuments",
  membership_management: "viewPersonLevelReports",
  cat_admin_only: "viewRestrictedStrategy",
  cat_lead_scope: "viewTeamScope",
  cat_member_scope: "viewCatMemberDocuments",
};

const documentVisibilitySet = new Set<string>(DOCUMENT_VISIBILITIES);

export function parseDocumentVisibility(value: unknown): DocumentVisibility {
  if (typeof value !== "string" || !documentVisibilitySet.has(value)) {
    throw new Error("Unsupported document visibility.");
  }
  return value as DocumentVisibility;
}

export function legacyDocumentVisibilitiesForRole(role: Role): LegacyDocumentVisibility[] {
  return LEGACY_DOCUMENT_VISIBILITIES.filter((visibility) => can(role, legacyVisibilityPermission[visibility]));
}

export function uploaderRolesBelow(role: Role): Role[] {
  const rank = roleHierarchy.indexOf(role);
  return rank < 0 ? [] : roleHierarchy.slice(rank + 1);
}

export function documentUploadVisibilitiesForRole(role: Role): DocumentUploadVisibility[] {
  if (!can(role, "uploadDocuments")) return [];
  return can(role, "shareDocumentsWithEveryone")
    ? ["uploader_hierarchy", "everyone"]
    : ["uploader_hierarchy"];
}

export function canAccessStoredDocument(
  actor: { userId?: string; role: Role },
  document: { visibility: unknown; createdBy?: string | null; uploadedByRole?: string | null },
) {
  const visibility = parseDocumentVisibility(document.visibility);
  if (visibility === "everyone") return true;
  if (visibility === "uploader_hierarchy") {
    if (actor.userId && document.createdBy === actor.userId) return true;
    return uploaderRolesBelow(actor.role).includes(document.uploadedByRole as Role);
  }
  return can(actor.role, legacyVisibilityPermission[visibility]);
}

export function canChooseDocumentVisibility(role: Role, visibilityValue: unknown) {
  const visibility = parseDocumentVisibility(visibilityValue);
  if (visibility === "uploader_hierarchy") return can(role, "uploadDocuments");
  if (visibility === "everyone") return can(role, "shareDocumentsWithEveryone");
  return can(role, legacyVisibilityPermission[visibility]);
}

export const __testing = { roleHierarchy };
