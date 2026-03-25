import crypto from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

import { createMigrationClient, getMigrationStatus } from "./migrations.mjs";
import {
  assertRestoreVerificationReady,
  readRestoreVerificationSnapshot,
  recordRecoveryDrill,
} from "./restore-verify.mjs";

const DEFAULT_HTTP_TIMEOUT_MS = 30_000;
const DEFAULT_UPLOAD_SCAN_TIMEOUT_MS = 180_000;
const DEFAULT_STRIPE_TIMEOUT_MS = 180_000;
const DEFAULT_POLL_INTERVAL_MS = 2_500;

function trimEnv(name, env = process.env) {
  return String(env[name] || "").trim();
}

function requireEnv(name, env = process.env) {
  const value = trimEnv(name, env);
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function parseBooleanEnv(name, fallback = false, env = process.env) {
  const raw = trimEnv(name, env).toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return fallback;
}

function parseIntEnv(name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}, env = process.env) {
  const raw = trimEnv(name, env);
  const parsed = Number(raw || fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function normalizeBaseUrl(raw) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`Invalid base URL: ${raw || "<empty>"}`);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`Unsupported base URL protocol: ${parsed.protocol}`);
  }
  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  return parsed.pathname === "/" ? parsed.origin : `${parsed.origin}${parsed.pathname}`;
}

function resolveLiveRuntimeBaseUrl(env = process.env) {
  const raw = trimEnv("LIVE_RUNTIME_BASE_URL", env) || trimEnv("APP_URL", env) || trimEnv("NEXTAUTH_URL", env);
  if (!raw) {
    throw new Error("Missing live runtime base URL. Set LIVE_RUNTIME_BASE_URL or load APP_URL/NEXTAUTH_URL from the deployed environment.");
  }
  return normalizeBaseUrl(raw);
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)}s`;
}

function summarizeError(error) {
  return error instanceof Error ? error.message : String(error);
}

function randomSuffix() {
  return `${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
}

async function streamToBuffer(body) {
  const chunks = [];
  for await (const chunk of body) {
    if (Buffer.isBuffer(chunk)) {
      chunks.push(chunk);
      continue;
    }
    if (chunk instanceof Uint8Array) {
      chunks.push(Buffer.from(chunk));
      continue;
    }
    if (chunk instanceof ArrayBuffer) {
      chunks.push(Buffer.from(chunk));
      continue;
    }
    chunks.push(Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks);
}

function bufferFromReadableStream(body) {
  if (!body) return Promise.resolve(Buffer.alloc(0));
  if (typeof body.transformToByteArray === "function") {
    return body.transformToByteArray().then((bytes) => Buffer.from(bytes));
  }
  return streamToBuffer(body);
}

async function sleep(ms) {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function poll({
  label,
  timeoutMs,
  intervalMs = DEFAULT_POLL_INTERVAL_MS,
  fn,
  isDone,
}) {
  const startedAt = Date.now();
  let lastValue = null;
  while (Date.now() - startedAt <= timeoutMs) {
    lastValue = await fn();
    if (isDone(lastValue)) {
      return lastValue;
    }
    await sleep(intervalMs);
  }
  throw new Error(`${label} did not complete within ${formatDuration(timeoutMs)}. Last value: ${JSON.stringify(lastValue)}`);
}

function parseSetCookieValue(raw) {
  const first = String(raw || "").split(";", 1)[0] || "";
  const eqIndex = first.indexOf("=");
  if (eqIndex <= 0) return null;
  const name = first.slice(0, eqIndex).trim();
  const value = first.slice(eqIndex + 1).trim();
  if (!name) return null;
  return { name, value };
}

class CookieJar {
  constructor() {
    this.cookies = new Map();
  }

  setFromResponse(response) {
    const rawCookies =
      typeof response.headers.getSetCookie === "function"
        ? response.headers.getSetCookie()
        : (() => {
            const fallback = response.headers.get("set-cookie");
            return fallback ? [fallback] : [];
          })();
    for (const raw of rawCookies) {
      const parsed = parseSetCookieValue(raw);
      if (!parsed) continue;
      this.cookies.set(parsed.name, parsed.value);
    }
  }

  apply(init = {}) {
    const headers = new Headers(init.headers || {});
    if (!headers.has("cookie") && this.cookies.size > 0) {
      headers.set(
        "cookie",
        [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ")
      );
    }
    return { ...init, headers };
  }
}

async function fetchWithTimeout(url, init = {}, timeoutMs = DEFAULT_HTTP_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("timeout"), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
      redirect: init.redirect || "follow",
      cache: "no-store",
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchWithCookies(jar, url, init = {}, timeoutMs = DEFAULT_HTTP_TIMEOUT_MS) {
  const response = await fetchWithTimeout(url, jar.apply(init), timeoutMs);
  jar.setFromResponse(response);
  return response;
}

async function readJsonResponse(response, label) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`${label} returned non-JSON (${response.status}): ${text.slice(0, 400)}`);
  }
}

async function expectStatus(response, allowedStatuses, label) {
  if (allowedStatuses.includes(response.status)) return;
  const text = await response.text().catch(() => "");
  throw new Error(`${label} failed with ${response.status}: ${text.slice(0, 500)}`);
}

function createR2Client(env = process.env) {
  return new S3Client({
    region: "auto",
    endpoint: requireEnv("R2_ENDPOINT", env),
    credentials: {
      accessKeyId: requireEnv("R2_ACCESS_KEY_ID", env),
      secretAccessKey: requireEnv("R2_SECRET_ACCESS_KEY", env),
    },
  });
}

async function createProofPdf(marker) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([420, 240]);
  page.drawText("Cyang Doclinks Runtime Proof", {
    x: 36,
    y: 180,
    size: 18,
    font,
    color: rgb(0.05, 0.18, 0.31),
  });
  page.drawText(`marker: ${marker}`, {
    x: 36,
    y: 146,
    size: 12,
    font,
    color: rgb(0.12, 0.12, 0.12),
  });
  page.drawText("This file validates live presign, R2 upload, finalize, and scanner cron flow.", {
    x: 36,
    y: 112,
    size: 11,
    font,
    color: rgb(0.18, 0.18, 0.18),
  });
  return Buffer.from(await pdf.save());
}

async function signInSmokeUser({ baseUrl, email, password }) {
  const jar = new CookieJar();

  const csrfResponse = await fetchWithCookies(jar, `${baseUrl}/api/auth/csrf`, {
    headers: { accept: "application/json" },
  });
  await expectStatus(csrfResponse, [200], "GET /api/auth/csrf");
  const csrfJson = await readJsonResponse(csrfResponse, "GET /api/auth/csrf");
  const csrfToken = String(csrfJson?.csrfToken || "").trim();
  if (!csrfToken) {
    throw new Error("Failed to obtain NextAuth CSRF token for smoke login.");
  }

  const form = new URLSearchParams();
  form.set("csrfToken", csrfToken);
  form.set("email", email);
  form.set("password", password);
  form.set("callbackUrl", `${baseUrl}/auth/continue-admin`);
  form.set("json", "true");

  const signInResponse = await fetchWithCookies(
    jar,
    `${baseUrl}/api/auth/callback/manual-password`,
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json, text/plain, */*",
      },
      body: form.toString(),
      redirect: "manual",
    }
  );
  await expectStatus(signInResponse, [200, 302], "POST /api/auth/callback/manual-password");

  const sessionResponse = await fetchWithCookies(jar, `${baseUrl}/api/auth/session`, {
    headers: { accept: "application/json" },
  });
  await expectStatus(sessionResponse, [200], "GET /api/auth/session");
  const sessionJson = await readJsonResponse(sessionResponse, "GET /api/auth/session");
  const sessionEmail = String(sessionJson?.user?.email || "").trim().toLowerCase();
  if (!sessionEmail || sessionEmail !== email.trim().toLowerCase()) {
    throw new Error("Smoke login did not yield an authenticated session for the configured LIVE_SMOKE_EMAIL.");
  }

  return {
    jar,
    session: sessionJson,
  };
}

async function readUploadRuntimeSnapshot(sql, docId) {
  const rows = await sql`
    select
      d.id::text as doc_id,
      coalesce(d.status::text, '') as doc_status,
      coalesce(d.scan_status::text, '') as scan_status,
      coalesce(d.moderation_status::text, '') as moderation_status,
      coalesce(d.r2_bucket::text, '') as r2_bucket,
      coalesce(d.r2_key::text, '') as r2_key,
      coalesce(j.status::text, '') as job_status,
      coalesce(j.attempts::int, 0) as job_attempts,
      coalesce(j.scanner_version::text, '') as scanner_version,
      coalesce(j.result #>> '{meta,source}', '') as result_source,
      coalesce(j.last_error::text, '') as last_error
    from public.docs d
    left join lateral (
      select status, attempts, scanner_version, result, last_error
      from public.malware_scan_jobs
      where doc_id = ${docId}::uuid
      order by created_at desc
      limit 1
    ) j on true
    where d.id = ${docId}::uuid
    limit 1
  `;
  return rows?.[0] || null;
}

async function triggerScanCron(baseUrl, cronSecret) {
  const response = await fetchWithTimeout(`${baseUrl}/api/cron/scan`, {
    method: "GET",
    headers: {
      authorization: `Bearer ${cronSecret}`,
      accept: "application/json",
    },
  });
  await expectStatus(response, [200], "GET /api/cron/scan");
  return readJsonResponse(response, "GET /api/cron/scan");
}

async function cleanupUploadArtifacts({ sql, r2Client, docId, bucket, key }) {
  if (docId) {
    await Promise.allSettled([
      sql`delete from public.share_unlocks where token in (select token from public.share_tokens where doc_id = ${docId}::uuid)`,
      sql`delete from public.share_tokens where doc_id = ${docId}::uuid`,
      sql`delete from public.doc_aliases where doc_id = ${docId}::uuid`,
      sql`delete from public.malware_scan_jobs where doc_id = ${docId}::uuid`,
      sql`delete from public.docs where id = ${docId}::uuid`,
    ]);
  }
  if (bucket && key) {
    try {
      await r2Client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    } catch {
      // best-effort cleanup for proof artifacts
    }
  }
}

async function runUploadAndScannerProof({ env, baseUrl, sql, auth }) {
  const cronSecret = requireEnv("CRON_SECRET", env);
  const r2Client = createR2Client(env);
  const marker = `runtime-proof-${randomSuffix()}`;
  const filename = `${marker}.pdf`;
  const pdfBytes = await createProofPdf(marker);
  const timeoutMs = parseIntEnv(
    "LIVE_RUNTIME_UPLOAD_SCAN_TIMEOUT_SECONDS",
    Math.floor(DEFAULT_UPLOAD_SCAN_TIMEOUT_MS / 1000),
    { min: 30, max: 900 },
    env
  ) * 1000;

  let docId = "";
  let bucket = "";
  let key = "";

  try {
    const presignResponse = await fetchWithCookies(auth.jar, `${baseUrl}/api/admin/upload/presign`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        title: marker,
        filename,
        contentType: "application/pdf",
        sizeBytes: pdfBytes.length,
        encrypt: true,
      }),
    });
    await expectStatus(presignResponse, [200], "POST /api/admin/upload/presign");
    const presign = await readJsonResponse(presignResponse, "POST /api/admin/upload/presign");
    if (!presign?.ok || !presign?.doc_id || !presign?.upload_url || !presign?.bucket || !presign?.r2_key) {
      throw new Error("Presign response was missing required upload proof fields.");
    }

    docId = String(presign.doc_id);
    bucket = String(presign.bucket);
    key = String(presign.r2_key);

    const uploadHeaders = new Headers();
    for (const [header, value] of Object.entries(presign.upload_headers || {})) {
      if (value == null) continue;
      uploadHeaders.set(header, String(value));
    }
    if (!uploadHeaders.has("content-type")) {
      uploadHeaders.set("content-type", "application/pdf");
    }

    const putResponse = await fetchWithTimeout(presign.upload_url, {
      method: "PUT",
      headers: uploadHeaders,
      body: pdfBytes,
      redirect: "manual",
    });
    await expectStatus(putResponse, [200, 201], "PUT presigned R2 upload");

    const preFinalizeHead = await r2Client.send(
      new HeadObjectCommand({
        Bucket: bucket,
        Key: key,
      })
    );
    if (Number(preFinalizeHead.ContentLength || 0) !== pdfBytes.length) {
      throw new Error(`Uploaded R2 object length mismatch before finalize: expected ${pdfBytes.length}, got ${preFinalizeHead.ContentLength || 0}.`);
    }
    if (String(preFinalizeHead.ContentType || "").trim() !== "application/pdf") {
      throw new Error(`Uploaded R2 object content-type mismatch before finalize: ${preFinalizeHead.ContentType || "<empty>"}`);
    }

    const completeResponse = await fetchWithCookies(auth.jar, `${baseUrl}/api/admin/upload/complete`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        doc_id: docId,
        title: marker,
        original_filename: filename,
        r2_bucket: bucket,
        r2_key: key,
      }),
    });
    await expectStatus(completeResponse, [200], "POST /api/admin/upload/complete");
    const completeJson = await readJsonResponse(completeResponse, "POST /api/admin/upload/complete");
    if (!completeJson?.ok) {
      throw new Error(`Upload completion failed: ${JSON.stringify(completeJson)}`);
    }
    if (String(completeJson.doc_state || "") !== "ready") {
      throw new Error(`Upload completion did not mark the document ready. Received doc_state=${completeJson.doc_state || "<empty>"}`);
    }
    if (String(completeJson.scan_state || "") !== "pending") {
      throw new Error(`Upload completion did not queue scanning. Received scan_state=${completeJson.scan_state || "<empty>"}`);
    }

    const postFinalizeHead = await r2Client.send(
      new HeadObjectCommand({
        Bucket: bucket,
        Key: key,
      })
    );
    if (String(postFinalizeHead.ContentType || "").trim() !== "application/octet-stream") {
      throw new Error(`Finalized R2 object was not rewritten as ciphertext. content-type=${postFinalizeHead.ContentType || "<empty>"}`);
    }
    if (Number(postFinalizeHead.ContentLength || 0) <= pdfBytes.length) {
      throw new Error(`Finalized R2 object size did not increase as expected after encryption: ${postFinalizeHead.ContentLength || 0}`);
    }

    const postFinalizeGet = await r2Client.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: key,
      })
    );
    const encryptedBytes = await bufferFromReadableStream(postFinalizeGet.Body);
    if (encryptedBytes.length <= pdfBytes.length) {
      throw new Error("Finalized R2 object GET did not return encrypted bytes.");
    }

    const initialSnapshot = await readUploadRuntimeSnapshot(sql, docId);
    if (!initialSnapshot) {
      throw new Error("Uploaded doc could not be reloaded from the database.");
    }
    if (String(initialSnapshot.scan_status || "") !== "pending") {
      throw new Error(`Uploaded doc did not remain pending before cron scan. scan_status=${initialSnapshot.scan_status || "<empty>"}`);
    }

    let cronTriggerCount = 0;
    let lastCronResult = null;
    const finalSnapshot = await poll({
      label: "live upload scan proof",
      timeoutMs,
      fn: async () => {
        const snapshot = await readUploadRuntimeSnapshot(sql, docId);
        if (!snapshot) return snapshot;
        const shouldTriggerCron =
          cronTriggerCount === 0 ||
          (cronTriggerCount < 4 && ["pending", "error"].includes(String(snapshot.job_status || "").toLowerCase()));
        if (shouldTriggerCron) {
          lastCronResult = await triggerScanCron(baseUrl, cronSecret);
          cronTriggerCount += 1;
        }
        return snapshot;
      },
      isDone: (snapshot) => {
        if (!snapshot) return false;
        const scanStatus = String(snapshot.scan_status || "").toLowerCase();
        const jobStatus = String(snapshot.job_status || "").toLowerCase();
        return ["clean", "quarantined", "error"].includes(scanStatus) || ["clean", "infected", "dead_letter"].includes(jobStatus);
      },
    });

    if (String(finalSnapshot.scan_status || "").toLowerCase() !== "clean") {
      throw new Error(
        `Live scanner proof failed closed for benign upload. scan_status=${finalSnapshot.scan_status || "<empty>"}, job_status=${finalSnapshot.job_status || "<empty>"}, last_error=${finalSnapshot.last_error || "<none>"}`
      );
    }
    if (String(finalSnapshot.job_status || "").toLowerCase() !== "clean") {
      throw new Error(`Live scan job did not finish cleanly. job_status=${finalSnapshot.job_status || "<empty>"}`);
    }
    if (!String(finalSnapshot.scanner_version || "").trim()) {
      throw new Error("Live scan proof completed without recording a scanner_version, so external scanner execution was not proven.");
    }

    return {
      proof: "upload_r2_scan",
      marker,
      docId,
      bucket,
      key,
      uploadBytes: pdfBytes.length,
      encryptedBytes: encryptedBytes.length,
      cronTriggerCount,
      cronResult: lastCronResult,
      scanStatus: finalSnapshot.scan_status,
      jobStatus: finalSnapshot.job_status,
      scannerVersion: finalSnapshot.scanner_version,
      scannerSource: finalSnapshot.result_source || null,
    };
  } finally {
    await cleanupUploadArtifacts({ sql, r2Client, docId, bucket, key });
  }
}

async function stripeApiRequest(path, { method = "POST", body = null, env = process.env } = {}) {
  const secretKey = requireEnv("STRIPE_SECRET_KEY", env);
  if (!parseBooleanEnv("LIVE_RUNTIME_STRIPE_ALLOW_LIVE", false, env) && secretKey.startsWith("sk_live_")) {
    throw new Error(
      "LIVE runtime Stripe proof refuses to run against a live Stripe secret by default. Set LIVE_RUNTIME_STRIPE_ALLOW_LIVE=1 only if you intentionally want that."
    );
  }

  const response = await fetchWithTimeout(`https://api.stripe.com${path}`, {
    method,
    headers: {
      authorization: `Bearer ${secretKey}`,
      ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}),
    },
    body: body ? new URLSearchParams(body).toString() : undefined,
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!response.ok) {
    throw new Error(`Stripe API ${method} ${path} failed with ${response.status}: ${text.slice(0, 500)}`);
  }
  return json;
}

async function readStripeRuntimeSnapshot(sql, { subscriptionId, customerId }) {
  const subRows = await sql`
    select
      stripe_subscription_id::text as stripe_subscription_id,
      stripe_customer_id::text as stripe_customer_id,
      status::text as status,
      plan_id::text as plan_id,
      cancel_at_period_end::boolean as cancel_at_period_end,
      grace_until::text as grace_until,
      current_period_end::text as current_period_end,
      updated_at::text as updated_at
    from public.billing_subscriptions
    where stripe_subscription_id = ${subscriptionId}
    limit 1
  `;

  const eventRows = await sql`
    select
      event_id::text as event_id,
      event_type::text as event_type,
      status::text as status,
      message::text as message,
      received_at::text as received_at
    from public.billing_webhook_events
    where
      coalesce(payload #>> '{data,object,id}', '') = ${subscriptionId}
      or coalesce(payload #>> '{data,object,subscription}', '') = ${subscriptionId}
      or coalesce(payload #>> '{data,object,customer}', '') = ${customerId}
    order by received_at desc
    limit 20
  `;

  const stripeLogRows = await sql`
    select
      event_id::text as event_id,
      event_type::text as event_type,
      status::text as status,
      message::text as message,
      received_at::text as received_at
    from public.stripe_event_log
    where
      coalesce(payload #>> '{data,object,id}', '') = ${subscriptionId}
      or coalesce(payload #>> '{data,object,subscription}', '') = ${subscriptionId}
      or coalesce(payload #>> '{data,object,customer}', '') = ${customerId}
    order by received_at desc
    limit 20
  `;

  return {
    subscription: subRows?.[0] || null,
    webhookEvents: eventRows || [],
    stripeLogEvents: stripeLogRows || [],
  };
}

async function waitForStripeCondition({
  sql,
  subscriptionId,
  customerId,
  timeoutMs,
  label,
  predicate,
}) {
  return poll({
    label,
    timeoutMs,
    fn: () => readStripeRuntimeSnapshot(sql, { subscriptionId, customerId }),
    isDone: predicate,
  });
}

async function runStripeDeliveryProof({ env, sql }) {
  const timeoutMs = parseIntEnv(
    "LIVE_RUNTIME_STRIPE_TIMEOUT_SECONDS",
    Math.floor(DEFAULT_STRIPE_TIMEOUT_MS / 1000),
    { min: 30, max: 900 },
    env
  ) * 1000;
  const priceId =
    trimEnv("LIVE_RUNTIME_STRIPE_PRICE_ID", env) ||
    requireEnv("STRIPE_PRO_PRICE_IDS", env)
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)[0];

  if (!priceId) {
    throw new Error("No Stripe price id was available for live runtime smoke proof.");
  }

  const marker = `runtime-proof-${randomSuffix()}`;
  const customer = await stripeApiRequest("/v1/customers", {
    env,
    body: {
      email: `runtime-proof+${marker}@example.test`,
      name: `Runtime Proof ${marker}`,
      "metadata[runtime_proof_marker]": marker,
    },
  });
  const customerId = String(customer?.id || "").trim();
  if (!customerId) {
    throw new Error("Stripe customer creation returned no id.");
  }

  await stripeApiRequest("/v1/payment_methods/pm_card_visa/attach", {
    env,
    body: { customer: customerId },
  });

  await stripeApiRequest(`/v1/customers/${encodeURIComponent(customerId)}`, {
    env,
    body: {
      "invoice_settings[default_payment_method]": "pm_card_visa",
    },
  });

  const subscription = await stripeApiRequest("/v1/subscriptions", {
    env,
    body: {
      customer: customerId,
      "items[0][price]": priceId,
      default_payment_method: "pm_card_visa",
      "metadata[runtime_proof_marker]": marker,
    },
  });
  const subscriptionId = String(subscription?.id || "").trim();
  if (!subscriptionId) {
    throw new Error("Stripe subscription creation returned no id.");
  }

  const createdSnapshot = await waitForStripeCondition({
    sql,
    subscriptionId,
    customerId,
    timeoutMs,
    label: "stripe webhook created delivery",
    predicate: (snapshot) => {
      const eventTypes = new Set(snapshot.webhookEvents.map((event) => String(event.event_type || "")));
      return eventTypes.has("customer.subscription.created") && Boolean(snapshot.subscription);
    },
  });

  const createdEvent = createdSnapshot.webhookEvents.find((event) => event.event_type === "customer.subscription.created");
  if (!createdEvent || String(createdEvent.status || "").toLowerCase() !== "processed") {
    throw new Error("Stripe created event reached the database but was not processed successfully.");
  }
  if (!createdSnapshot.stripeLogEvents.some((event) => event.event_type === "customer.subscription.created")) {
    throw new Error("stripe_event_log did not record the created subscription event.");
  }

  await stripeApiRequest(`/v1/subscriptions/${encodeURIComponent(subscriptionId)}`, {
    env,
    body: {
      cancel_at_period_end: "true",
      "metadata[runtime_proof_marker]": marker,
    },
  });

  const updatedSnapshot = await waitForStripeCondition({
    sql,
    subscriptionId,
    customerId,
    timeoutMs,
    label: "stripe webhook updated delivery",
    predicate: (snapshot) => {
      const eventTypes = new Set(snapshot.webhookEvents.map((event) => String(event.event_type || "")));
      return eventTypes.has("customer.subscription.updated") && Boolean(snapshot.subscription?.cancel_at_period_end);
    },
  });

  await stripeApiRequest(`/v1/subscriptions/${encodeURIComponent(subscriptionId)}`, {
    env,
    method: "DELETE",
  });

  const deletedSnapshot = await waitForStripeCondition({
    sql,
    subscriptionId,
    customerId,
    timeoutMs,
    label: "stripe webhook deleted delivery",
    predicate: (snapshot) => {
      const eventTypes = new Set(snapshot.webhookEvents.map((event) => String(event.event_type || "")));
      return eventTypes.has("customer.subscription.deleted") && String(snapshot.subscription?.status || "").toLowerCase() === "canceled";
    },
  });

  return {
    proof: "stripe_delivery",
    marker,
    customerId,
    subscriptionId,
    createdEventId: createdSnapshot.webhookEvents.find((event) => event.event_type === "customer.subscription.created")?.event_id || null,
    updatedEventId: updatedSnapshot.webhookEvents.find((event) => event.event_type === "customer.subscription.updated")?.event_id || null,
    deletedEventId: deletedSnapshot.webhookEvents.find((event) => event.event_type === "customer.subscription.deleted")?.event_id || null,
    finalStatus: deletedSnapshot.subscription?.status || null,
    finalPlanId: deletedSnapshot.subscription?.plan_id || null,
    cancelAtPeriodEnd: Boolean(updatedSnapshot.subscription?.cancel_at_period_end),
  };
}

function databaseIdentity(databaseUrl) {
  const parsed = new URL(databaseUrl);
  return `${parsed.protocol}//${parsed.hostname}${parsed.pathname}`;
}

async function fetchLatestBackupRun(sql, backupFile = "") {
  if (backupFile) {
    const rows = await sql`
      select
        status::text as status,
        coalesce(details->>'backup_file', '') as backup_file,
        created_at::text as created_at,
        coalesce(details->>'source', '') as source
      from public.backup_runs
      where coalesce(details->>'backup_file', '') = ${backupFile}
      order by created_at desc
      limit 1
    `;
    return rows?.[0] || null;
  }

  const rows = await sql`
    select
      status::text as status,
      coalesce(details->>'backup_file', '') as backup_file,
      created_at::text as created_at,
      coalesce(details->>'source', '') as source
    from public.backup_runs
    where lower(coalesce(status::text, '')) in ('ok', 'success')
    order by created_at desc
    limit 1
  `;
  return rows?.[0] || null;
}

async function runRestoreRecoveryProof({ env }) {
  const sourceDatabaseUrl = requireEnv("DATABASE_URL", env);
  const targetDatabaseUrl = requireEnv("LIVE_RESTORE_TARGET_DATABASE_URL", env);
  const expectedBackupFile = requireEnv("LIVE_RESTORE_EXPECTED_BACKUP_FILE", env);
  const targetBaseUrlRaw = trimEnv("LIVE_RESTORE_TARGET_BASE_URL", env);
  const recordResult = parseBooleanEnv("LIVE_RESTORE_RECORD_RESULT", true, env);

  if (databaseIdentity(sourceDatabaseUrl) === databaseIdentity(targetDatabaseUrl)) {
    throw new Error("Restore runtime proof requires a distinct LIVE_RESTORE_TARGET_DATABASE_URL; it currently resolves to the same database identity as DATABASE_URL.");
  }

  const sourceSql = await createMigrationClient({ DATABASE_URL: sourceDatabaseUrl });
  const targetSql = await createMigrationClient({ DATABASE_URL: targetDatabaseUrl });
  let recoveryRecorded = false;
  try {
    const sourceBackup = await fetchLatestBackupRun(sourceSql, expectedBackupFile);
    if (!sourceBackup) {
      throw new Error(`Source database does not contain backup_runs evidence for expected backup file ${expectedBackupFile}.`);
    }
    if (!["ok", "success"].includes(String(sourceBackup.status || "").toLowerCase())) {
      throw new Error(`Expected backup file ${expectedBackupFile} is not marked successful in source backup_runs.`);
    }

    const targetBackup = await fetchLatestBackupRun(targetSql, expectedBackupFile);
    if (!targetBackup) {
      throw new Error(`Recovery target does not contain expected backup file ${expectedBackupFile} in backup_runs.`);
    }
    if (!["ok", "success"].includes(String(targetBackup.status || "").toLowerCase())) {
      throw new Error(`Recovery target contains ${expectedBackupFile}, but not with a successful backup status.`);
    }

    const snapshot = await readRestoreVerificationSnapshot({ sql: targetSql });
    await assertRestoreVerificationReady({
      sql: targetSql,
      requireCurrentMigrations: true,
      getMigrationStatus,
    });

    if (snapshot.docsCount <= 0 || snapshot.shareTokensCount <= 0 || snapshot.immutableAuditCount <= 0) {
      throw new Error(`Recovery target snapshot is unexpectedly empty: ${JSON.stringify(snapshot)}`);
    }

    let targetHealth = null;
    if (targetBaseUrlRaw) {
      const targetBaseUrl = normalizeBaseUrl(targetBaseUrlRaw);
      const healthResponse = await fetchWithTimeout(`${targetBaseUrl}/api/health/ready`, {
        headers: { accept: "application/json" },
      });
      await expectStatus(healthResponse, [200], "GET recovery target /api/health/ready");
      targetHealth = await readJsonResponse(healthResponse, "GET recovery target /api/health/ready");
    }

    if (recordResult) {
      await recordRecoveryDrill({
        sql: targetSql,
        status: "success",
        notes: `live runtime proof verified restored backup ${expectedBackupFile}`,
        requireCurrentMigrations: true,
      });
      recoveryRecorded = true;
    }

    return {
      proof: "restore_recovery",
      expectedBackupFile,
      sourceBackupCreatedAt: sourceBackup.created_at || null,
      targetBackupCreatedAt: targetBackup.created_at || null,
      recoveryRecorded,
      targetHealth,
      snapshot,
    };
  } catch (error) {
    if (recordResult) {
      try {
        await recordRecoveryDrill({
          sql: targetSql,
          status: "failed",
          notes: `live runtime proof failed for restored backup ${expectedBackupFile}: ${summarizeError(error)}`.slice(0, 500),
          requireCurrentMigrations: true,
        });
      } catch {
        // keep the original restore-proof failure loud
      }
    }
    throw error;
  } finally {
    await Promise.allSettled([
      sourceSql.end({ timeout: 5 }),
      targetSql.end({ timeout: 5 }),
    ]);
  }
}

async function runStep(summary, label, fn) {
  const startedAt = Date.now();
  console.log(`\n==> [${label}]`);
  try {
    const result = await fn();
    const durationMs = Date.now() - startedAt;
    summary.steps.push({
      label,
      ok: true,
      durationMs,
      result,
    });
    console.log(`PASS ${label} (${formatDuration(durationMs)})`);
    return result;
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    summary.steps.push({
      label,
      ok: false,
      durationMs,
      error: summarizeError(error),
    });
    console.log(`FAIL ${label} (${formatDuration(durationMs)})`);
    throw error;
  }
}

function printSummary(summary) {
  const totalMs = summary.steps.reduce((sum, step) => sum + step.durationMs, 0);
  console.log(`\nLive runtime proof summary: ${summary.ok ? "PASSED" : "FAILED"}`);
  for (const step of summary.steps) {
    console.log(`- ${step.ok ? "PASS" : "FAIL"} ${step.label} (${formatDuration(step.durationMs)})`);
    if (!step.ok && step.error) {
      console.log(`  error: ${step.error}`);
    }
  }
  console.log(`- Total duration: ${formatDuration(totalMs)}`);
}

function writeSummary(summaryPath, summary) {
  if (!summaryPath) return;
  const resolvedPath = resolve(summaryPath);
  mkdirSync(dirname(resolvedPath), { recursive: true });
  writeFileSync(resolvedPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
}

export async function runLiveRuntimeProof({
  env = process.env,
  summaryPath = null,
} = {}) {
  const summary = {
    ok: false,
    baseUrl: resolveLiveRuntimeBaseUrl(env),
    steps: [],
  };

  let sourceSql = null;
  try {
    const baseUrl = summary.baseUrl;
    requireEnv("LIVE_SMOKE_EMAIL", env);
    requireEnv("LIVE_SMOKE_PASSWORD", env);

    sourceSql = await createMigrationClient({ DATABASE_URL: requireEnv("DATABASE_URL", env) });
    const auth = await runStep(summary, "Smoke user authentication", () =>
      signInSmokeUser({
        baseUrl,
        email: requireEnv("LIVE_SMOKE_EMAIL", env),
        password: requireEnv("LIVE_SMOKE_PASSWORD", env),
      })
    );

    await runStep(summary, "Upload -> R2 -> scanner live proof", () =>
      runUploadAndScannerProof({
        env,
        baseUrl,
        sql: sourceSql,
        auth,
      })
    );

    await runStep(summary, "Stripe delivery live proof", () =>
      runStripeDeliveryProof({
        env,
        sql: sourceSql,
      })
    );

    await runStep(summary, "Restore recovery live proof", () =>
      runRestoreRecoveryProof({ env })
    );

    summary.ok = true;
    printSummary(summary);
    writeSummary(summaryPath, summary);
    return summary;
  } catch (error) {
    summary.ok = false;
    summary.error = summarizeError(error);
    printSummary(summary);
    writeSummary(summaryPath, summary);
    throw error;
  } finally {
    if (sourceSql) {
      await sourceSql.end({ timeout: 5 });
    }
  }
}
