import "server-only";

import { can } from "./access.ts";
import { prepareAtomicAuditStatement } from "./audit.ts";
import { queryLocal801, runLocal801Transaction, type DatabaseQuery, type DatabaseStatement } from "./db.ts";
import { documentAccessParameters, documentAccessSql } from "./documents.ts";
import type { WorkspaceContext } from "./workspace-context.ts";

const HANDLE_RE = /^[0-9a-f]{64}$/i;
const TAG_RE = /^[\p{L}\p{N}][\p{L}\p{N} .&/_-]{0,39}$/u;
export const DOCUMENT_RELATIONSHIP_TYPES = ["related", "supports", "reference", "supersedes"] as const;
export type DocumentRelationshipType = (typeof DOCUMENT_RELATIONSHIP_TYPES)[number];
export type DocumentTargetKind = "document" | "campaign" | "cat_action";

export class DocumentMetadataError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message); this.name = "DocumentMetadataError"; this.code = code; this.status = status;
  }
}

type Dependencies = { query?: DatabaseQuery; runTransaction?: (statements: readonly DatabaseStatement[]) => Promise<void>; prepareAudit?: typeof prepareAtomicAuditStatement };
type TargetOption = { kind: DocumentTargetKind; handle: string; label: string };

function requireManage(context: WorkspaceContext) {
  if (!can(context.role, "manageDocuments")) throw new DocumentMetadataError("FORBIDDEN", "Document metadata management is not authorized.", 403);
}
function validHandle(value: unknown, label: string) {
  if (typeof value !== "string" || !HANDLE_RE.test(value)) throw new DocumentMetadataError("INVALID_HANDLE", `${label} is not available.`, 400);
  return value.toLowerCase();
}
function normalizeTags(value: unknown) {
  if (!Array.isArray(value) || value.length > 8) throw new DocumentMetadataError("INVALID_TAGS", "Use no more than eight document tags.", 400);
  const tags = [...new Set(value.map((item) => typeof item === "string" ? item.trim().replace(/\s+/g, " ") : ""))];
  if (tags.some((tag) => !TAG_RE.test(tag))) throw new DocumentMetadataError("INVALID_TAGS", "Each tag must be 1–40 plain-text characters.", 400);
  return tags;
}
function relationshipType(value: unknown): DocumentRelationshipType {
  if (!DOCUMENT_RELATIONSHIP_TYPES.includes(value as DocumentRelationshipType)) throw new DocumentMetadataError("INVALID_RELATIONSHIP", "The document relationship type is invalid.", 400);
  return value as DocumentRelationshipType;
}

async function resolveDocument(context: WorkspaceContext, input: unknown, query: DatabaseQuery) {
  const handle = validHandle(input, "Document");
  const access = documentAccessParameters(context);
  const [row] = await query<{ id: string; title: string; visibility: string }>(`
    SELECT id, title, visibility FROM local801.documents
    WHERE organization_id = $1::uuid AND archived_at IS NULL
      AND ${documentAccessSql("documents", { legacyVisibilities: 2, userId: 3, uploaderRoles: 4 })}
      AND encode(public.digest(organization_id::text || ':' || id::text, 'sha256'), 'hex') = $5::text LIMIT 1
  `, [context.organizationId, access.legacyVisibilities, access.userId, access.uploaderRoles, handle]);
  if (!row) throw new DocumentMetadataError("DOCUMENT_NOT_FOUND", "The document is no longer available.", 409);
  return row;
}

export async function getDocumentMetadataWorkspace(context: WorkspaceContext, documentHandle: unknown, query: DatabaseQuery = queryLocal801) {
  requireManage(context);
  const document = await resolveDocument(context, documentHandle, query);
  const access = documentAccessParameters(context);
  const [tags, relationships, documents, campaigns, actions] = await Promise.all([
    query<{ label: string }>(`SELECT tag.label FROM local801.document_tag_assignments assignment JOIN local801.document_tags tag ON tag.organization_id = assignment.organization_id AND tag.id = assignment.tag_id WHERE assignment.organization_id = $1::uuid AND assignment.document_id = $2::uuid AND tag.archived_at IS NULL ORDER BY tag.normalized_label LIMIT 8`, [context.organizationId, document.id]),
    query<{ handle: string; relationship_type: DocumentRelationshipType; target_kind: DocumentTargetKind; target_handle: string; target_label: string }>(`
      SELECT encode(public.digest('document-relationship:' || relationship.organization_id::text || ':' || relationship.id::text, 'sha256'), 'hex') AS handle,
        relationship.relationship_type,
        CASE WHEN relationship.related_document_id IS NOT NULL THEN 'document' WHEN relationship.campaign_id IS NOT NULL THEN 'campaign' ELSE 'cat_action' END AS target_kind,
        CASE WHEN relationship.related_document_id IS NOT NULL THEN encode(public.digest(relationship.organization_id::text || ':' || relationship.related_document_id::text, 'sha256'), 'hex')
          WHEN relationship.campaign_id IS NOT NULL THEN encode(public.digest('campaign:' || relationship.organization_id::text || ':' || relationship.campaign_id::text, 'sha256'), 'hex')
          ELSE encode(public.digest('cat-action:' || relationship.organization_id::text || ':' || relationship.cat_action_id::text, 'sha256'), 'hex') END AS target_handle,
        COALESCE(related_document.title, campaign.name, action.name) AS target_label
      FROM local801.document_relationships relationship
      LEFT JOIN local801.documents related_document ON related_document.organization_id = relationship.organization_id AND related_document.id = relationship.related_document_id
      LEFT JOIN local801.outreach_campaigns campaign ON campaign.organization_id = relationship.organization_id AND campaign.id = relationship.campaign_id
      LEFT JOIN local801.cat_actions action ON action.organization_id = relationship.organization_id AND action.id = relationship.cat_action_id
      WHERE relationship.organization_id = $1::uuid AND relationship.document_id = $2::uuid AND relationship.archived_at IS NULL
        AND ((relationship.related_document_id IS NOT NULL AND related_document.archived_at IS NULL AND ${documentAccessSql("related_document", { legacyVisibilities: 3, userId: 4, uploaderRoles: 5 })})
          OR (relationship.campaign_id IS NOT NULL AND $6::boolean AND campaign.archived_at IS NULL AND campaign.status <> 'archived')
          OR (relationship.cat_action_id IS NOT NULL AND $7::boolean AND action.archived_at IS NULL AND action.status <> 'archived'))
      ORDER BY relationship.created_at DESC LIMIT 100
    `, [context.organizationId, document.id, access.legacyVisibilities, access.userId, access.uploaderRoles, can(context.role, "manageCampaigns"), can(context.role, "manageCatActions")]),
    query<{ handle: string; label: string }>(`SELECT encode(public.digest(organization_id::text || ':' || id::text, 'sha256'), 'hex') AS handle, title AS label FROM local801.documents WHERE organization_id = $1::uuid AND archived_at IS NULL AND id <> $2::uuid AND ${documentAccessSql("documents", { legacyVisibilities: 3, userId: 4, uploaderRoles: 5 })} ORDER BY lower(title), id LIMIT 200`, [context.organizationId, document.id, access.legacyVisibilities, access.userId, access.uploaderRoles]),
    can(context.role, "manageCampaigns") ? query<{ handle: string; label: string }>(`SELECT encode(public.digest('campaign:' || organization_id::text || ':' || id::text, 'sha256'), 'hex') AS handle, name AS label FROM local801.outreach_campaigns WHERE organization_id = $1::uuid AND archived_at IS NULL AND status <> 'archived' ORDER BY lower(name), id LIMIT 200`, [context.organizationId]) : Promise.resolve([]),
    can(context.role, "manageCatActions") ? query<{ handle: string; label: string }>(`SELECT encode(public.digest('cat-action:' || organization_id::text || ':' || id::text, 'sha256'), 'hex') AS handle, name AS label FROM local801.cat_actions WHERE organization_id = $1::uuid AND archived_at IS NULL AND status <> 'archived' ORDER BY lower(name), id LIMIT 200`, [context.organizationId]) : Promise.resolve([]),
  ]);
  const targets: TargetOption[] = [
    ...documents.map((item) => ({ kind: "document" as const, ...item })),
    ...campaigns.map((item) => ({ kind: "campaign" as const, ...item })),
    ...actions.map((item) => ({ kind: "cat_action" as const, ...item })),
  ];
  return { document: { title: document.title }, tags: tags.map((tag) => tag.label), relationships, targets };
}

export async function setDocumentTags(context: WorkspaceContext, input: { documentHandle: unknown; tags: unknown }, dependencies: Dependencies = {}) {
  requireManage(context);
  const query = dependencies.query ?? queryLocal801;
  const tags = normalizeTags(input.tags);
  const document = await resolveDocument(context, input.documentHandle, query);
  const access = documentAccessParameters(context);
  const mutation: DatabaseStatement = { sql: `
    /* document-metadata:set-tags */
    WITH actor AS (SELECT app_user.id FROM local801.users app_user WHERE app_user.organization_id = $1::uuid AND app_user.id = $3::uuid AND app_user.deactivated_at IS NULL AND EXISTS (SELECT 1 FROM local801.workspace_user_roles user_role JOIN local801.workspace_roles role ON role.id = user_role.role_id AND role.organization_id = $1::uuid WHERE user_role.user_id = app_user.id AND role.code IN ('system_owner','local_admin','membership_data_manager','cat_admin'))),
    target_document AS (SELECT id FROM local801.documents WHERE organization_id = $1::uuid AND id = $2::uuid AND archived_at IS NULL AND ${documentAccessSql("documents", { legacyVisibilities: 5, userId: 3, uploaderRoles: 6 })}),
    cleared AS (DELETE FROM local801.document_tag_assignments assignment USING target_document WHERE assignment.organization_id = $1::uuid AND assignment.document_id = target_document.id),
    source AS (SELECT btrim(value) AS label, lower(btrim(value)) AS normalized_label FROM jsonb_array_elements_text($4::text::jsonb) value),
    restored AS (UPDATE local801.document_tags tag SET archived_at = NULL FROM source, actor WHERE tag.organization_id = $1::uuid AND tag.normalized_label = source.normalized_label AND tag.archived_at IS NOT NULL RETURNING tag.id, tag.normalized_label),
    created AS (INSERT INTO local801.document_tags (organization_id, label, normalized_label, created_by) SELECT $1::uuid, source.label, source.normalized_label, actor.id FROM source CROSS JOIN actor WHERE NOT EXISTS (SELECT 1 FROM local801.document_tags tag WHERE tag.organization_id = $1::uuid AND tag.normalized_label = source.normalized_label AND tag.archived_at IS NULL) RETURNING id, normalized_label),
    active_tags AS (SELECT id, normalized_label FROM local801.document_tags WHERE organization_id = $1::uuid AND archived_at IS NULL UNION SELECT id, normalized_label FROM created UNION SELECT id, normalized_label FROM restored),
    assigned AS (INSERT INTO local801.document_tag_assignments (organization_id, document_id, tag_id, created_by) SELECT $1::uuid, target_document.id, tag.id, actor.id FROM source JOIN active_tags tag USING (normalized_label) CROSS JOIN actor CROSS JOIN target_document ON CONFLICT DO NOTHING RETURNING tag_id)
    SELECT 1 / CASE WHEN (SELECT count(*) FROM actor) = 1 AND (SELECT count(*) FROM target_document) = 1 AND (SELECT count(*) FROM assigned) = (SELECT count(*) FROM source) THEN 1 ELSE 0 END = 1 AS saved
  `, parameters: [context.organizationId, document.id, context.userId, JSON.stringify(tags), access.legacyVisibilities, access.uploaderRoles] };
  const audit = await (dependencies.prepareAudit ?? prepareAtomicAuditStatement)({ eventType: "record.update", organizationId: context.organizationId, actorId: context.userId, subjectType: "document_tags", subjectId: document.id, payload: { tagCount: tags.length } }, query);
  await (dependencies.runTransaction ?? runLocal801Transaction)([mutation, audit]);
  return { saved: true } as const;
}

export async function addDocumentRelationship(context: WorkspaceContext, input: { documentHandle: unknown; targetKind: unknown; targetHandle: unknown; relationshipType: unknown }, dependencies: Dependencies = {}) {
  requireManage(context);
  const query = dependencies.query ?? queryLocal801;
  const document = await resolveDocument(context, input.documentHandle, query);
  const kind = input.targetKind;
  if (kind !== "document" && kind !== "campaign" && kind !== "cat_action") throw new DocumentMetadataError("INVALID_TARGET", "The relationship target is invalid.", 400);
  if (kind === "campaign" && !can(context.role, "manageCampaigns")) throw new DocumentMetadataError("FORBIDDEN", "Campaign relationships are not authorized.", 403);
  if (kind === "cat_action" && !can(context.role, "manageCatActions")) throw new DocumentMetadataError("FORBIDDEN", "CAT Action relationships are not authorized.", 403);
  const targetHandle = validHandle(input.targetHandle, "Relationship target");
  const type = relationshipType(input.relationshipType);
  const table = kind === "document" ? "documents" : kind === "campaign" ? "outreach_campaigns" : "cat_actions";
  const prefix = kind === "document" ? "" : kind === "campaign" ? "campaign:" : "cat-action:";
  const access = documentAccessParameters(context);
  const visibilityClause = kind === "document" ? `AND ${documentAccessSql("documents", { legacyVisibilities: 3, userId: 4, uploaderRoles: 5 })}` : "";
  const [target] = await query<{ id: string }>(`SELECT id FROM local801.${table} WHERE organization_id = $1::uuid AND archived_at IS NULL ${visibilityClause} AND encode(public.digest('${prefix}' || organization_id::text || ':' || id::text, 'sha256'), 'hex') = $2::text LIMIT 1`, kind === "document" ? [context.organizationId, targetHandle, access.legacyVisibilities, access.userId, access.uploaderRoles] : [context.organizationId, targetHandle]);
  if (!target || (kind === "document" && target.id === document.id)) throw new DocumentMetadataError("TARGET_NOT_FOUND", "The relationship target is no longer available.", 409);
  const columns = { document: ["related_document_id", null, null], campaign: [null, "campaign_id", null], cat_action: [null, null, "cat_action_id"] }[kind];
  const values = columns.map((column) => column ? target.id : null);
  const mutation: DatabaseStatement = { sql: `
    WITH inserted AS (
      INSERT INTO local801.document_relationships (organization_id, document_id, relationship_type, related_document_id, campaign_id, cat_action_id, created_by)
      SELECT $1::uuid, source_document.id, $3, $4::uuid, $5::uuid, $6::uuid, actor.id FROM local801.users actor
      JOIN local801.documents source_document ON source_document.organization_id = $1::uuid AND source_document.id = $2::uuid AND source_document.archived_at IS NULL AND ${documentAccessSql("source_document", { legacyVisibilities: 8, userId: 7, uploaderRoles: 9 })}
      WHERE actor.organization_id = $1::uuid AND actor.id = $7::uuid AND actor.deactivated_at IS NULL
        AND EXISTS (SELECT 1 FROM local801.workspace_user_roles user_role JOIN local801.workspace_roles role ON role.id = user_role.role_id AND role.organization_id = $1::uuid WHERE user_role.user_id = actor.id AND role.code IN ('system_owner','local_admin','membership_data_manager','cat_admin'))
        AND ($4::uuid IS NULL OR EXISTS (SELECT 1 FROM local801.documents target_document WHERE target_document.organization_id = $1::uuid AND target_document.id = $4::uuid AND target_document.archived_at IS NULL AND ${documentAccessSql("target_document", { legacyVisibilities: 8, userId: 7, uploaderRoles: 9 })}))
        AND ($5::uuid IS NULL OR EXISTS (SELECT 1 FROM local801.outreach_campaigns target_campaign WHERE target_campaign.organization_id = $1::uuid AND target_campaign.id = $5::uuid AND target_campaign.archived_at IS NULL AND target_campaign.status <> 'archived'))
        AND ($6::uuid IS NULL OR EXISTS (SELECT 1 FROM local801.cat_actions target_action WHERE target_action.organization_id = $1::uuid AND target_action.id = $6::uuid AND target_action.archived_at IS NULL AND target_action.status <> 'archived'))
        AND NOT EXISTS (SELECT 1 FROM local801.document_relationships relationship WHERE relationship.organization_id = $1::uuid AND relationship.document_id = $2::uuid AND relationship.relationship_type = $3 AND relationship.archived_at IS NULL AND relationship.related_document_id IS NOT DISTINCT FROM $4::uuid AND relationship.campaign_id IS NOT DISTINCT FROM $5::uuid AND relationship.cat_action_id IS NOT DISTINCT FROM $6::uuid)
      RETURNING id
    ) SELECT CASE WHEN count(*) = 1 THEN true ELSE 1 / count(*)::integer = 1 END FROM inserted
  `, parameters: [context.organizationId, document.id, type, ...values, context.userId, access.legacyVisibilities, access.uploaderRoles] };
  const audit = await (dependencies.prepareAudit ?? prepareAtomicAuditStatement)({ eventType: "record.create", organizationId: context.organizationId, actorId: context.userId, subjectType: "document_relationship", subjectId: document.id, payload: { targetKind: kind, relationshipType: type } }, query);
  await (dependencies.runTransaction ?? runLocal801Transaction)([mutation, audit]);
  return { linked: true } as const;
}

export async function removeDocumentRelationship(context: WorkspaceContext, relationshipHandleInput: unknown, dependencies: Dependencies = {}) {
  requireManage(context);
  const query = dependencies.query ?? queryLocal801;
  const relationshipHandle = validHandle(relationshipHandleInput, "Document relationship");
  const [row] = await query<{ id: string; document_id: string }>(`SELECT id, document_id FROM local801.document_relationships WHERE organization_id = $1::uuid AND archived_at IS NULL AND encode(public.digest('document-relationship:' || organization_id::text || ':' || id::text, 'sha256'), 'hex') = $2::text LIMIT 1`, [context.organizationId, relationshipHandle]);
  if (!row) throw new DocumentMetadataError("RELATIONSHIP_NOT_FOUND", "The document relationship is no longer current.", 409);
  const mutation: DatabaseStatement = { sql: `WITH archived AS (UPDATE local801.document_relationships SET archived_at = now() WHERE organization_id = $1::uuid AND id = $2::uuid AND archived_at IS NULL AND EXISTS (SELECT 1 FROM local801.users actor WHERE actor.organization_id = $1::uuid AND actor.id = $3::uuid AND actor.deactivated_at IS NULL AND EXISTS (SELECT 1 FROM local801.workspace_user_roles user_role JOIN local801.workspace_roles role ON role.id = user_role.role_id AND role.organization_id = $1::uuid WHERE user_role.user_id = actor.id AND role.code IN ('system_owner','local_admin','membership_data_manager','cat_admin'))) RETURNING id) SELECT CASE WHEN count(*) = 1 THEN true ELSE 1 / count(*)::integer = 1 END FROM archived`, parameters: [context.organizationId, row.id, context.userId] };
  const audit = await (dependencies.prepareAudit ?? prepareAtomicAuditStatement)({ eventType: "record.archive", organizationId: context.organizationId, actorId: context.userId, subjectType: "document_relationship", subjectId: row.id }, query);
  await (dependencies.runTransaction ?? runLocal801Transaction)([mutation, audit]);
  return { removed: true } as const;
}
