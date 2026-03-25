// src/app/admin/actions.ts
"use server";

import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import { revalidatePath } from "next/cache";
import bcrypt from "bcryptjs";

import { sql } from "@/lib/db";
import { getR2Bucket, getR2Prefix, r2Client } from "@/lib/r2";
import { sendMail } from "@/lib/email";
import { requireDocWrite, requireRole, requireUser } from "@/lib/authz";
import { generateApiKey, hashApiKey } from "@/lib/apiKeys";
import { emitWebhook } from "@/lib/webhooks";
import { appendImmutableAudit } from "@/lib/immutableAudit";
import { resolveConfiguredPublicAppBaseUrl } from "@/lib/publicBaseUrl";
import { MAX_SHARE_PASSWORD_LEN, normalizeExactPasswordInput, passwordCharLength } from "@/lib/password";

function getBaseUrl() {
  return resolveConfiguredPublicAppBaseUrl();
}

async function tableExists(name: string): Promise<boolean> {
  try {
    const rows = (await sql`select to_regclass(${name})::text as reg`) as unknown as Array<{ reg: string | null }>;
    return Boolean(rows?.[0]?.reg);
  } catch {
    return false;
  }
}

async function appendAdminAudit(args: {
  action: string;
  docId?: string | null;
  subjectId?: string | null;
  payload?: Record<string, unknown> | null;
}) {
  try {
    const u = await requireUser();
    await appendImmutableAudit({
      streamKey: args.docId ? `doc:${args.docId}` : `admin:${u.id}`,
      action: args.action,
      actorUserId: u.id,
      orgId: u.orgId ?? null,
      docId: args.docId ?? undefined,
      subjectId: args.subjectId ?? null,
      payload: args.payload ?? null,
    });
  } catch {
    // best-effort audit logging; do not block admin flow
  }
}

async function requireShareWrite(token: string) {
  const t = String(token || "").trim();
  if (!t) throw new Error("Missing token.");

  const rows = (await sql`
    select doc_id::text as doc_id
    from public.share_tokens
    where token = ${t}
    limit 1
  `) as unknown as Array<{ doc_id: string }>;

  const docId = rows?.[0]?.doc_id ?? null;
  if (!docId) throw new Error("Token not found.");
  await requireDocWrite(docId);
}

async function resolveR2LocationForDoc(docId: string): Promise<{ bucket: string; key: string }> {
  const r2Prefix = getR2Prefix();
  const r2Bucket = getR2Bucket();
  // Attempt 1: docs.pointer = "r2://bucket/key"
  try {
    const rows = (await sql`
      select pointer
      from docs
      where id = ${docId}::uuid
      limit 1
    `) as unknown as Array<{ pointer: string | null }>;

    const pointer = rows[0]?.pointer ?? null;
    if (!pointer) throw new Error("Doc not found.");
    if (!pointer.startsWith(r2Prefix)) throw new Error("Invalid pointer.");
    const key = pointer.slice(r2Prefix.length);
    return { bucket: r2Bucket, key };
  } catch (e: unknown) {
    const msg = String(e instanceof Error ? e.message : e || "").toLowerCase();
    const missingPointerCol =
      msg.includes("column") && msg.includes("pointer") && msg.includes("does not exist");

    if (!missingPointerCol) throw e;
  }

  // Attempt 2: docs.r2_bucket + docs.r2_key
  const rows2 = (await sql`
    select r2_bucket, r2_key
    from docs
    where id = ${docId}::uuid
    limit 1
  `) as unknown as Array<{ r2_bucket: string | null; r2_key: string | null }>;

  const r2b = rows2[0]?.r2_bucket ?? null;
  const r2k = rows2[0]?.r2_key ?? null;
  if (!r2b || !r2k) throw new Error("Doc not found.");
  return { bucket: r2b, key: r2k };
}

function normalizeAliasInput(input: string): string {
  return String(input || "").trim().toLowerCase();
}

function parseAliasTtlDays(raw: unknown): number {
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) {
    return Math.max(1, Math.min(365, Math.floor(n)));
  }
  const envDefault = Number(process.env.ALIAS_DEFAULT_TTL_DAYS || 30);
  if (Number.isFinite(envDefault) && envDefault > 0) {
    return Math.max(1, Math.min(365, Math.floor(envDefault)));
  }
  return 30;
}

const MAX_DOC_ID_LEN = 64;
const MAX_ALIAS_LEN = 160;
const MAX_TOKEN_LEN = 128;
const MAX_EMAIL_LEN = 320;
const MAX_REASON_LEN = 512;
const MAX_API_KEY_NAME_LEN = 120;
const MAX_BULK_JSON_CHARS = 64 * 1024;
const MAX_BULK_ITEMS = 500;

function readFormText(formData: FormData, keys: string | string[], maxLen: number): string {
  const list = Array.isArray(keys) ? keys : [keys];
  for (const key of list) {
    const raw = formData.get(key);
    if (raw == null) continue;
    const source = String(raw || "").replace(/[\r\n]+/g, " ");
    if (/[\0]/.test(source)) throw new Error(`${key} contains invalid characters.`);
    const value = source.trim();
    if (value.length > maxLen) throw new Error(`${key} is too long.`);
    return value;
  }
  return "";
}

function parseStringArrayFormField(formData: FormData, key: string, itemLabel: string): string[] {
  const raw = readFormText(formData, key, MAX_BULK_JSON_CHARS);
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid ${itemLabel} payload.`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`Invalid ${itemLabel} payload.`);
  }
  const out: string[] = [];
  for (const item of parsed) {
    if (out.length >= MAX_BULK_ITEMS) break;
    const value = String(item || "").trim();
    if (!value || value.length > MAX_TOKEN_LEN || /[\r\n\0]/.test(value)) continue;
    out.push(value);
  }
  return out;
}

async function purgeDocGraphRows(docId: string): Promise<boolean> {
  const shareTokensExists = await tableExists("public.share_tokens");
  const shareUnlocksExists = await tableExists("public.share_unlocks");
  const docAliasesExists = await tableExists("public.doc_aliases");
  const docAccessGrantsExists = await tableExists("public.doc_access_grants");
  const scanJobsExists = await tableExists("public.malware_scan_jobs");

  if (shareUnlocksExists && shareTokensExists) {
    await sql`
      delete from public.share_unlocks
      where token in (
        select token from public.share_tokens where doc_id = ${docId}::uuid
      )
    `;
  }
  if (shareTokensExists) {
    await sql`delete from public.share_tokens where doc_id = ${docId}::uuid`;
  }
  if (docAliasesExists) {
    await sql`delete from public.doc_aliases where doc_id = ${docId}::uuid`;
  }
  if (docAccessGrantsExists) {
    await sql`delete from public.doc_access_grants where doc_id = ${docId}::uuid`;
  }
  if (scanJobsExists) {
    await sql`delete from public.malware_scan_jobs where doc_id = ${docId}::uuid`;
  }

  const deleted = (await sql`
    delete from public.docs
    where id = ${docId}::uuid
    returning id::text as id
  `) as unknown as Array<{ id: string }>;
  return deleted.length > 0;
}

// Used as <form action={createOrAssignAliasAction}> — must return void
export async function createOrAssignAliasAction(formData: FormData): Promise<void> {
  const alias = normalizeAliasInput(readFormText(formData, "alias", MAX_ALIAS_LEN));
  const docId = readFormText(formData, ["docId", "doc_id"], MAX_DOC_ID_LEN);
  const expiresDays = parseAliasTtlDays(formData.get("expiresDays"));

  if (!alias) throw new Error("Missing alias.");
  if (!docId) throw new Error("Missing docId.");

  await requireDocWrite(docId);
  if (!/^[a-zA-Z0-9_-]{3,80}$/.test(alias)) {
    throw new Error("Alias must be 3-80 chars: letters, numbers, underscore, dash.");
  }

  let createdAlias: string | null = null;
  try {
    const created = (await sql`
      insert into doc_aliases (alias, doc_id, is_active, expires_at, revoked_at)
      values (${alias}, ${docId}::uuid, true, now() + (${expiresDays}::int * interval '1 day'), null)
      returning alias::text as alias
    `) as unknown as Array<{ alias: string }>;
    if (!created.length) {
      throw new Error("Alias is already in use.");
    }
    createdAlias = created[0].alias;
  } catch (e: unknown) {
    const msg = String(e instanceof Error ? e.message : e || "");
    const missingCol =
      msg.includes("column") &&
      (msg.includes("expires_at") || msg.includes("revoked_at") || msg.includes("is_active"));
    if (missingCol) {
      const created = (await sql`
        insert into doc_aliases (alias, doc_id)
        values (${alias}, ${docId}::uuid)
        returning alias::text as alias
      `) as unknown as Array<{ alias: string }>;
      if (!created.length) throw new Error("Alias is already in use.");
      createdAlias = created[0].alias;
    } else if (String((e as { code?: string })?.code || "") === "23505") {
      throw new Error("Alias is already in use.");
    } else {
      throw e;
    }
  }

  emitWebhook("alias.created", { alias: createdAlias || alias, doc_id: docId });
  await appendAdminAudit({
    action: "doc.alias_upserted",
    docId,
    subjectId: createdAlias || alias,
    payload: { alias: createdAlias || alias },
  });

  revalidatePath("/admin");
  revalidatePath("/admin/dashboard");
}

export async function renameDocAliasAction(formData: FormData): Promise<void> {
  const docId = readFormText(formData, "docId", MAX_DOC_ID_LEN);
  const newAlias = normalizeAliasInput(readFormText(formData, "newAlias", MAX_ALIAS_LEN));
  if (!docId) throw new Error("Missing docId.");
  if (!newAlias) throw new Error("Missing new alias.");
  if (!/^[a-z0-9_-]{3,80}$/.test(newAlias)) {
    throw new Error("Alias must be 3-80 chars: letters, numbers, underscore, dash.");
  }

  await requireDocWrite(docId);

  let updatedAlias: string = newAlias;
  try {
    const updated = (await sql`
      with target as (
        select id
        from public.doc_aliases
        where doc_id = ${docId}::uuid
        order by created_at desc nulls last
        limit 1
      )
      update public.doc_aliases a
      set
        alias = ${newAlias},
        revoked_at = null,
        is_active = true
      from target t
      where a.id = t.id
      returning a.alias::text as alias
    `) as unknown as Array<{ alias: string }>;

    if (!updated.length) {
      await sql`
        insert into public.doc_aliases (alias, doc_id, is_active)
        values (${newAlias}, ${docId}::uuid, true)
      `;
      updatedAlias = newAlias;
    } else {
      updatedAlias = updated[0].alias;
    }
  } catch (e: unknown) {
    const msg = String(e instanceof Error ? e.message : e || "");
    const missingCol =
      msg.includes("column") &&
      (msg.includes("revoked_at") || msg.includes("is_active"));
    if (missingCol) {
      const updated = (await sql`
        with target as (
          select id
          from public.doc_aliases
          where doc_id = ${docId}::uuid
          order by created_at desc nulls last
          limit 1
        )
        update public.doc_aliases a
        set alias = ${newAlias}
        from target t
        where a.id = t.id
        returning a.alias::text as alias
      `) as unknown as Array<{ alias: string }>;
      if (!updated.length) {
        await sql`
          insert into public.doc_aliases (alias, doc_id)
          values (${newAlias}, ${docId}::uuid)
        `;
        updatedAlias = newAlias;
      } else {
        updatedAlias = updated[0].alias;
      }
    } else if (String((e as { code?: string })?.code || "") === "23505") {
      throw new Error("Alias is already in use.");
    } else {
      throw e;
    }
  }

  emitWebhook("alias.created", { alias: updatedAlias, doc_id: docId, renamed: true });
  await appendAdminAudit({
    action: "doc.alias_renamed",
    docId,
    subjectId: updatedAlias,
    payload: { alias: updatedAlias, via: "admin_action" },
  });

  revalidatePath("/admin/dashboard");
  revalidatePath("/admin");
  revalidatePath(`/admin/docs/${docId}`);
}

export async function setAliasExpirationAction(formData: FormData): Promise<void> {
  const docId = readFormText(formData, "docId", MAX_DOC_ID_LEN);
  const days = parseAliasTtlDays(formData.get("days"));
  if (!docId) throw new Error("Missing docId.");

  await requireDocWrite(docId);

  try {
    await sql`
      update public.doc_aliases
      set
        expires_at = now() + (${days}::int * interval '1 day'),
        is_active = true,
        revoked_at = null
      where doc_id = ${docId}::uuid
    `;
  } catch {
    // Older schemas may not have expires_at/is_active/revoked_at.
  }

  await appendAdminAudit({
    action: "doc.alias_expiration_set",
    docId,
    payload: { days, via: "admin_action" },
  });

  revalidatePath("/admin/dashboard");
  revalidatePath("/admin");
  revalidatePath(`/admin/docs/${docId}`);
}

// Used as <form action={emailMagicLinkAction}> — must return void
export async function emailMagicLinkAction(formData: FormData): Promise<void> {
  const u = await requireUser();

  const to = readFormText(formData, ["to", "email", "recipient"], MAX_EMAIL_LEN);

  const docId = readFormText(formData, ["docId", "doc_id"], MAX_DOC_ID_LEN);
  const alias = readFormText(formData, "alias", MAX_ALIAS_LEN);

  if (!to) throw new Error("Missing recipient email.");
  if (!alias && !docId) throw new Error("Provide alias or docId.");

  // AuthZ: verify ownership when docId/alias is provided.
  if (docId) {
    await requireDocWrite(docId);
  } else if (alias) {
    const rows = (await sql`
      select doc_id::text as doc_id
      from public.doc_aliases
      where lower(alias) = lower(${alias})
      limit 1
    `) as unknown as Array<{ doc_id: string }>;
    const did = rows?.[0]?.doc_id ?? null;
    if (!did) throw new Error("Alias not found.");
    await requireDocWrite(did);
  }

  const base = getBaseUrl();
  const token = alias || docId;
  const url = `${base}/d/${encodeURIComponent(token)}`;

  await sendMail({
    to,
    subject: "Your document link",
    text: `Here is your secure link:\n\n${url}\n\nIf you did not expect this message, you can ignore it.`,
  });

  // Optional audit
  await sendMail({
    to: u.email,
    subject: "cyang.io: link emailed",
    text: `Sent link to ${to}\n\n${url}`,
  });

  revalidatePath("/admin");
  revalidatePath("/admin/dashboard");
}

// Used as <form action={deleteDocAction}> — must return void
export async function deleteDocAction(formData: FormData): Promise<void> {
  const docId = readFormText(formData, ["docId", "doc_id"], MAX_DOC_ID_LEN);
  const reason = readFormText(formData, "reason", MAX_REASON_LEN) || null;
  if (!docId) throw new Error("Missing docId.");

  await requireDocWrite(docId);
  const drows = (await sql`
    select title::text as title
    from public.docs
    where id = ${docId}::uuid
    limit 1
  `) as unknown as Array<{ title: string | null }>;
  const title = drows?.[0]?.title ?? null;

  const { bucket, key } = await resolveR2LocationForDoc(docId);

  await r2Client.send(
    new DeleteObjectCommand({
      Bucket: bucket,
      Key: key,
    })
  );

  const deleted = await purgeDocGraphRows(docId);
  if (!deleted) {
    throw new Error("Document not found.");
  }

  revalidatePath("/admin");
  revalidatePath("/admin/dashboard");

  emitWebhook("doc.deleted", { doc_id: docId, title });
  await appendImmutableAudit(
    {
      streamKey: `doc:${docId}`,
      action: "doc.deleted",
      docId,
      payload: { title, reason, via: "admin_action" },
    },
    { strict: true }
  );
}

/**
 * Share admin actions
 * Expected table: share_tokens(token text primary key, revoked_at timestamptz, password_hash text null, ...)
 */

// Used as <form action={revokeDocShareAction}>
export async function revokeDocShareAction(formData: FormData): Promise<void> {
  const token = readFormText(formData, "token", MAX_TOKEN_LEN);
  if (!token) throw new Error("Missing token.");

  await requireShareWrite(token);

  const before = (await sql`
    select doc_id::text as doc_id, to_email, expires_at::text as expires_at, max_views, views_count
    from public.share_tokens
    where token = ${token}
    limit 1
  `) as unknown as Array<{
    doc_id: string;
    to_email: string | null;
    expires_at: string | null;
    max_views: number | null;
    views_count: number | null;
  }>;

  await sql`
    update share_tokens
    set revoked_at = now()
    where token = ${token}
      and revoked_at is null
  `;

  // Webhook (best-effort)
  emitWebhook("share.revoked", {
    token,
    doc_id: before?.[0]?.doc_id ?? null,
    to_email: before?.[0]?.to_email ?? null,
    expires_at: before?.[0]?.expires_at ?? null,
    max_views: before?.[0]?.max_views ?? null,
    views_count: before?.[0]?.views_count ?? null,
  });
  await appendAdminAudit({
    action: "share.revoked",
    docId: before?.[0]?.doc_id ?? null,
    subjectId: token,
    payload: {
      toEmail: before?.[0]?.to_email ?? null,
      expiresAt: before?.[0]?.expires_at ?? null,
      maxViews: before?.[0]?.max_views ?? null,
      viewsCount: before?.[0]?.views_count ?? null,
      via: "admin_action",
    },
  });

  revalidatePath("/admin/dashboard");
  revalidatePath("/admin");
}

// Used as <form action={setSharePasswordAction}>
export async function setSharePasswordAction(formData: FormData): Promise<void> {
  const token = readFormText(formData, "token", MAX_TOKEN_LEN);
  const passwordInput = String(formData.get("password") || "");
  const password = normalizeExactPasswordInput(passwordInput, MAX_SHARE_PASSWORD_LEN);

  if (!token) throw new Error("Missing token.");
  if (!password) throw new Error("Password contains unsupported characters or is too long.");
  if (passwordCharLength(password) < 4) throw new Error("Password must be at least 4 characters.");

  await requireShareWrite(token);

  // bcrypt cost (12 is a good default for serverless)
  const hash = await bcrypt.hash(password, 12);

  await sql`
    update share_tokens
    set password_hash = ${hash}
    where token = ${token}
  `;

  revalidatePath("/admin/dashboard");
  revalidatePath("/admin");
}

// Used as <form action={clearSharePasswordAction}>
export async function clearSharePasswordAction(formData: FormData): Promise<void> {
  const token = readFormText(formData, "token", MAX_TOKEN_LEN);
  if (!token) throw new Error("Missing token.");

  await requireShareWrite(token);

  await sql`
    update share_tokens
    set password_hash = null
    where token = ${token}
  `;

  revalidatePath("/admin/dashboard");
  revalidatePath("/admin");
}

// --- Dashboard v2 actions (actionable + bulk) ---

export async function revokeAllSharesForDocAction(formData: FormData): Promise<void> {
  await requireRole("admin");
  const docId = readFormText(formData, "docId", MAX_DOC_ID_LEN);
  if (!docId) throw new Error("Missing docId.");

  await sql`
    update public.share_tokens
    set revoked_at = now()
    where doc_id = ${docId}::uuid
      and revoked_at is null
  `;
  await appendAdminAudit({
    action: "share.bulk_revoked_for_doc",
    docId,
    payload: { via: "admin_action" },
  });

  revalidatePath("/admin/dashboard");
  revalidatePath("/admin");
  revalidatePath(`/admin/docs/${docId}`);
}

export async function disableAliasForDocAction(formData: FormData): Promise<void> {
  await requireRole("admin");
  const docId = readFormText(formData, "docId", MAX_DOC_ID_LEN);
  if (!docId) throw new Error("Missing docId.");

  const arows = (await sql`
    select alias::text as alias
    from public.doc_aliases
    where doc_id = ${docId}::uuid
    limit 1
  `) as unknown as Array<{ alias: string }>;
  const alias = arows?.[0]?.alias ?? null;

  // Best-effort: prefer is_active=false if the column exists; fall back to revoked_at.
  try {
    await sql`
      update public.doc_aliases
      set is_active = false
      where doc_id = ${docId}::uuid
    `;
  } catch {
    try {
      await sql`
        update public.doc_aliases
        set revoked_at = now()
        where doc_id = ${docId}::uuid
          and revoked_at is null
      `;
    } catch {
      // last-resort: delete (older envs)
      await sql`
        delete from public.doc_aliases
        where doc_id = ${docId}::uuid
      `;
    }
  }

  emitWebhook("alias.disabled", { doc_id: docId, alias });
  await appendAdminAudit({
    action: "doc.alias_disabled",
    docId,
    subjectId: alias,
    payload: { alias, via: "admin_action" },
  });

  revalidatePath("/admin/dashboard");
  revalidatePath("/admin");
  revalidatePath(`/admin/docs/${docId}`);
}

export async function extendAliasExpirationAction(formData: FormData): Promise<void> {
  await requireRole("admin");
  const docId = readFormText(formData, "docId", MAX_DOC_ID_LEN);
  const days = Number(formData.get("days") || 0);
  if (!docId) throw new Error("Missing docId.");
  if (!Number.isFinite(days) || days <= 0) throw new Error("Invalid days.");

  // Extend alias expiration (or set it) by +days from now.
  try {
    await sql`
      update public.doc_aliases
      set expires_at = greatest(coalesce(expires_at, now()), now()) + (${days}::int * interval '1 day')
      where doc_id = ${docId}::uuid
    `;
  } catch {
    // If the env doesn't have expires_at, ignore.
  }

  revalidatePath("/admin/dashboard");
  revalidatePath("/admin");
  revalidatePath(`/admin/docs/${docId}`);
}

export async function extendShareExpirationAction(formData: FormData): Promise<void> {
  const token = readFormText(formData, "token", MAX_TOKEN_LEN);
  const days = Number(formData.get("days") || 0);
  if (!token) throw new Error("Missing token.");
  if (!Number.isFinite(days) || days <= 0) throw new Error("Invalid days.");
  await requireShareWrite(token);

  await sql`
    update public.share_tokens
    set expires_at = greatest(coalesce(expires_at, now()), now()) + (${days}::int * interval '1 day')
    where token = ${token}
  `;

  revalidatePath("/admin/dashboard");
  revalidatePath("/admin");
}

export async function setShareMaxViewsAction(formData: FormData): Promise<void> {
  const token = readFormText(formData, "token", MAX_TOKEN_LEN);
  const maxViewsRaw = readFormText(formData, "maxViews", 16);
  if (!token) throw new Error("Missing token.");
  await requireShareWrite(token);

  const maxViews = maxViewsRaw === "" ? null : Number(maxViewsRaw);
  if (maxViews !== null && (!Number.isFinite(maxViews) || maxViews < 0)) {
    throw new Error("Invalid maxViews.");
  }

  await sql`
    update public.share_tokens
    set max_views = ${maxViews}
    where token = ${token}
  `;

  revalidatePath("/admin/dashboard");
  revalidatePath("/admin");
}

export async function resetShareViewsCountAction(formData: FormData): Promise<void> {
  const token = readFormText(formData, "token", MAX_TOKEN_LEN);
  if (!token) throw new Error("Missing token.");
  await requireShareWrite(token);

  await sql`
    update public.share_tokens
    set views_count = 0
    where token = ${token}
  `;

  revalidatePath("/admin/dashboard");
  revalidatePath("/admin");
}

export async function forceSharePasswordResetAction(formData: FormData): Promise<void> {
  const token = readFormText(formData, "token", MAX_TOKEN_LEN);
  if (!token) throw new Error("Missing token.");
  await requireShareWrite(token);

  await sql`
    update public.share_tokens
    set password_hash = null
    where token = ${token}
  `;

  // Also invalidate existing unlocks (if table exists).
  try {
    await sql`delete from public.share_unlocks where token = ${token}`;
  } catch {
    // ignore
  }

  revalidatePath("/admin/dashboard");
  revalidatePath("/admin");
}

export async function bulkRevokeSharesAction(formData: FormData): Promise<void> {
  await requireRole("admin");
  const tokens = parseStringArrayFormField(formData, "tokens", "tokens");
  if (!Array.isArray(tokens) || tokens.length === 0) throw new Error("Missing tokens.");

  await sql`
    update public.share_tokens
    set revoked_at = now()
    where token = any(${tokens}::text[])
      and revoked_at is null
  `;

  revalidatePath("/admin/dashboard");
  revalidatePath("/admin");
}

export async function bulkExtendSharesAction(formData: FormData): Promise<void> {
  await requireRole("admin");
  const tokens = parseStringArrayFormField(formData, "tokens", "tokens");
  const days = Number(formData.get("days") || 0);
  if (!tokens.length) throw new Error("Missing tokens.");
  if (!Number.isFinite(days) || days <= 0) throw new Error("Invalid days.");

  await sql`
    update public.share_tokens
    set expires_at = greatest(coalesce(expires_at, now()), now()) + (${days}::int * interval '1 day')
    where token = any(${tokens}::text[])
  `;

  revalidatePath("/admin/dashboard");
  revalidatePath("/admin");
}

export async function bulkRevokeAllSharesForDocsAction(formData: FormData): Promise<void> {
  await requireRole("admin");
  const docIds = parseStringArrayFormField(formData, "docIds", "docIds");
  if (!Array.isArray(docIds) || docIds.length === 0) throw new Error("Missing docIds.");

  await sql`
    update public.share_tokens
    set revoked_at = now()
    where doc_id = any(${docIds}::uuid[])
      and revoked_at is null
  `;
  for (const docId of docIds) {
    await appendAdminAudit({
      action: "share.bulk_revoked_for_doc",
      docId,
      payload: { via: "admin_action", bulk: true },
    });
  }

  revalidatePath("/admin/dashboard");
  revalidatePath("/admin");
  for (const id of docIds) revalidatePath(`/admin/docs/${id}`);
}

export async function bulkDisableAliasesForDocsAction(formData: FormData): Promise<void> {
  await requireRole("admin");
  const docIds = parseStringArrayFormField(formData, "docIds", "docIds");
  if (!Array.isArray(docIds) || docIds.length === 0) throw new Error("Missing docIds.");

  try {
    await sql`
      update public.doc_aliases
      set is_active = false
      where doc_id = any(${docIds}::uuid[])
    `;
  } catch {
    try {
      await sql`
        update public.doc_aliases
        set revoked_at = now()
        where doc_id = any(${docIds}::uuid[])
          and revoked_at is null
      `;
    } catch {
      await sql`
        delete from public.doc_aliases
        where doc_id = any(${docIds}::uuid[])
      `;
    }
  }
  for (const docId of docIds) {
    await appendAdminAudit({
      action: "doc.alias_disabled",
      docId,
      payload: { via: "admin_action", bulk: true },
    });
  }

  revalidatePath("/admin/dashboard");
  revalidatePath("/admin");
  for (const id of docIds) revalidatePath(`/admin/docs/${id}`);
}

export async function bulkDeleteDocsAction(formData: FormData): Promise<void> {
  await requireUser();
  const docIds = parseStringArrayFormField(formData, "docIds", "docIds");
  const reason = readFormText(formData, "reason", MAX_REASON_LEN) || null;
  if (!Array.isArray(docIds) || docIds.length === 0) throw new Error("Missing docIds.");

  for (const docId of docIds) {
    const id = String(docId || "").trim();
    if (!id) continue;

    try {
      await requireDocWrite(id);
      const drows = (await sql`
        select title::text as title
        from public.docs
        where id = ${id}::uuid
        limit 1
      `) as unknown as Array<{ title: string | null }>;
      const title = drows?.[0]?.title ?? null;

      const { bucket, key } = await resolveR2LocationForDoc(id);
      await r2Client.send(
        new DeleteObjectCommand({
          Bucket: bucket,
          Key: key,
        })
      );
      await purgeDocGraphRows(id);

      emitWebhook("doc.deleted", { doc_id: id, title, bulk: true, reason });
      await appendImmutableAudit(
        {
          streamKey: `doc:${id}`,
          action: "doc.deleted",
          docId: id,
          payload: { title, reason, via: "owner_bulk_delete" },
        },
        { strict: true }
      );
    } catch {
      // continue processing other selected docs
    }
  }

  revalidatePath("/admin/viewer-uploads");
  revalidatePath("/admin/dashboard");
  revalidatePath("/admin");
}

// =========================
// API Keys (admin/owner)
// =========================

export async function createApiKeyAction(formData: FormData) {
  const u = await requireRole("admin");

  const name = readFormText(formData, "name", MAX_API_KEY_NAME_LEN);
  if (!name) throw new Error("Missing name.");

  const { plaintext, prefix } = generateApiKey();
  const keyHash = hashApiKey(plaintext);

  const rows = (await sql`
    insert into public.api_keys (owner_id, name, prefix, key_hash)
    values (${u.id}::uuid, ${name}, ${prefix}, ${keyHash})
    returning id::text as id
  `) as unknown as Array<{ id: string }>;

  revalidatePath("/admin/api-keys");
  return { ok: true as const, id: rows?.[0]?.id ?? null, apiKey: plaintext };
}

export async function revokeApiKeyAction(formData: FormData) {
  await requireRole("admin");
  const id = readFormText(formData, "id", MAX_DOC_ID_LEN);
  if (!id) throw new Error("Missing id.");

  await sql`
    update public.api_keys
    set revoked_at = now()
    where id = ${id}::uuid
  `;

  revalidatePath("/admin/api-keys");
  return { ok: true as const };
}
