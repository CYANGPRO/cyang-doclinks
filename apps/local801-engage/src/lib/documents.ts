import "server-only";

import { can, type Role } from "./access.ts";
import { queryLocal801, type DatabaseQuery } from "./db.ts";
import {
  legacyDocumentVisibilitiesForRole,
  uploaderRolesBelow,
  type DocumentVisibility,
} from "./document-access.ts";
import type { WorkspaceContext } from "./workspace-context.ts";

export { DOCUMENT_VISIBILITIES, type DocumentVisibility } from "./document-access.ts";

type DocumentRow = {
  category: string;
  title: string;
  original_filename: string | null;
  media_type: string | null;
  visibility: DocumentVisibility;
  status: string;
  uploader_name: string;
  created_at: string | Date;
  download_handle: string;
  cursor_token: string;
};

export type DocumentMetadata = {
  category: string;
  title: string;
  originalFilename: string | null;
  mediaType: string | null;
  visibility: DocumentVisibility;
  status: string;
  uploaderName: string;
  createdAt: string;
  downloadHandle: string;
};

export type DocumentsPage = {
  documents: DocumentMetadata[];
  nextCursor: string | null;
  pageSize: number;
};

type DocumentCursor = { createdAt: string; token: string };

const documentHandlePattern = /^[a-f0-9]{64}$/i;

function timestamp(value: string | Date) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function validTimestamp(value: unknown) {
  if (typeof value !== "string" || value.length > 50) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function normalizeDocumentHandle(value: unknown) {
  return typeof value === "string" && documentHandlePattern.test(value)
    ? value.toLowerCase()
    : null;
}

function documentCursor(value: unknown): DocumentCursor | null {
  if (typeof value !== "string" || value.length > 500) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as {
      createdAt?: unknown;
      token?: unknown;
    };
    const createdAt = validTimestamp(parsed.createdAt);
    const token = normalizeDocumentHandle(parsed.token);
    return createdAt && token ? { createdAt, token } : null;
  } catch {
    return null;
  }
}

function encodeDocumentCursor(row: DocumentRow) {
  return Buffer.from(JSON.stringify({
    createdAt: timestamp(row.created_at),
    token: row.cursor_token,
  })).toString("base64url");
}

export function documentVisibilitiesForRole(role: Role): DocumentVisibility[] {
  return legacyDocumentVisibilitiesForRole(role);
}

export function documentAccessSql(
  alias: string,
  parameters: { legacyVisibilities: number; userId: number; uploaderRoles: number },
) {
  return `(
    ${alias}.visibility = ANY($${parameters.legacyVisibilities}::text[])
    OR ${alias}.visibility = 'everyone'
    OR (
      ${alias}.visibility = 'uploader_hierarchy'
      AND (
        ${alias}.created_by = $${parameters.userId}::uuid
        OR ${alias}.uploaded_by_role = ANY($${parameters.uploaderRoles}::text[])
      )
    )
  )`;
}

export function documentAccessParameters(context: WorkspaceContext) {
  return {
    legacyVisibilities: legacyDocumentVisibilitiesForRole(context.role),
    userId: context.userId,
    uploaderRoles: uploaderRolesBelow(context.role),
  };
}

function documentMetadata(row: DocumentRow): DocumentMetadata {
  return {
    category: row.category,
    title: row.title,
    originalFilename: row.original_filename,
    mediaType: row.media_type,
    visibility: row.visibility,
    status: row.status,
    uploaderName: row.uploader_name,
    createdAt: timestamp(row.created_at),
    downloadHandle: row.download_handle,
  };
}

export async function getDocumentsPage(
  context: WorkspaceContext,
  input: { cursor?: unknown; pageSize?: unknown } = {},
  query: DatabaseQuery = queryLocal801,
): Promise<DocumentsPage> {
  if (!can(context.role, "viewDocuments")) throw new Error("Forbidden.");

  const access = documentAccessParameters(context);

  const requested = Number(input.pageSize);
  const pageSize = Number.isSafeInteger(requested) ? Math.min(Math.max(requested, 1), 100) : 50;
  const position = documentCursor(input.cursor);

  const rows = await query<DocumentRow>(`
    /* documents:metadata-keyset-page */
    WITH visible_documents AS (
      SELECT
        document.category,
        document.title,
        document.original_filename,
        document.media_type,
        document.visibility,
        document.status,
        COALESCE(creator.display_name, 'System') AS uploader_name,
        document.created_at,
        encode(
          public.digest(document.organization_id::text || ':' || document.id::text, 'sha256'),
          'hex'
        ) AS download_handle,
        encode(
          public.digest(document.organization_id::text || ':' || document.id::text, 'sha256'),
          'hex'
        ) AS cursor_token
      FROM local801.documents document
      LEFT JOIN local801.users creator
        ON creator.id = document.created_by
       AND creator.organization_id = document.organization_id
      WHERE document.organization_id = $1::uuid
        AND document.archived_at IS NULL
        AND ${documentAccessSql("document", { legacyVisibilities: 2, userId: 3, uploaderRoles: 4 })}
    ), page_rows AS (
      SELECT *
      FROM visible_documents
      WHERE (
        $5::timestamptz IS NULL
        OR (created_at, cursor_token) < ($5::timestamptz, $6::text)
      )
      ORDER BY created_at DESC, cursor_token DESC
      LIMIT $7::integer
    )
    SELECT * FROM page_rows ORDER BY created_at DESC, cursor_token DESC
  `, [
    context.organizationId,
    access.legacyVisibilities,
    access.userId,
    access.uploaderRoles,
    position?.createdAt ?? null,
    position?.token ?? null,
    pageSize + 1,
  ]);

  const hasNext = rows.length > pageSize;
  const bounded = rows.slice(0, pageSize);
  const last = bounded.at(-1);

  return {
    documents: bounded.map(documentMetadata),
    nextCursor: hasNext && last ? encodeDocumentCursor(last) : null,
    pageSize,
  };
}

export async function resolveDocumentDownloadId(
  context: WorkspaceContext,
  handle: unknown,
  query: DatabaseQuery = queryLocal801,
) {
  if (!can(context.role, "viewDocuments")) throw new Error("Forbidden.");

  const access = documentAccessParameters(context);

  const normalizedHandle = normalizeDocumentHandle(handle);
  if (!normalizedHandle) return null;

  const [row] = await query<{ id: string }>(`
    /* documents:resolve-download-handle */
    SELECT document.id
    FROM local801.documents document
    WHERE document.organization_id = $1::uuid
      AND document.archived_at IS NULL
      AND ${documentAccessSql("document", { legacyVisibilities: 2, userId: 3, uploaderRoles: 4 })}
      AND encode(
        public.digest(document.organization_id::text || ':' || document.id::text, 'sha256'),
        'hex'
      ) = $5::text
    LIMIT 1
  `, [
    context.organizationId,
    access.legacyVisibilities,
    access.userId,
    access.uploaderRoles,
    normalizedHandle,
  ]);

  return row?.id ?? null;
}

export const __testing = { allowedVisibilities: documentVisibilitiesForRole, documentCursor, normalizeDocumentHandle };
