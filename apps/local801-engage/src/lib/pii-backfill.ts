import "server-only";

import {
  createPiiBlindIndex,
  createPiiIntegrityHash,
  createPiiNameSearchTokens,
  encryptPiiField,
  normalizePiiContactValue,
  normalizePiiEmail,
  normalizePiiIdentifier,
  normalizePiiNameForSearch,
  PiiProtectionError,
  type PiiKeyConfiguration,
} from "./pii-protection.ts";

export const MAX_SYNTHETIC_BACKFILL_ROWS_PER_ENTITY = 25_000;
export const DIRECT_IMPORT_PII_FIELDS = Object.freeze([
  "first_name",
  "last_name",
  "preferred_name",
  "work_email",
  "employee_identifier",
  "member_identifier",
  "home_email",
  "work_phone",
  "cell_phone",
  "home_phone",
] as const);

export const DIRECT_IMPORT_PII_BITS = Object.freeze({
  first_name: 1,
  last_name: 2,
  preferred_name: 4,
  work_email: 8,
  employee_identifier: 16,
  member_identifier: 32,
  home_email: 64,
  work_phone: 128,
  cell_phone: 256,
  home_phone: 512,
} as const);

const IMPORT_MATCH_DOMAINS = Object.freeze({
  first_name: "person:first-name",
  last_name: "person:last-name",
  preferred_name: "person:preferred-name",
  work_email: "contact:work-email",
  employee_identifier: "identifier:employee-identifier",
  member_identifier: "identifier:member-identifier",
  home_email: "contact:personal-email",
  work_phone: "contact:work-phone",
  cell_phone: "contact:cell-phone",
  home_phone: "contact:home-phone",
} as const);

const PROVIDER_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

type SourceUser = { id: string; organization_id: string; email: string; display_name: string };
type SourceAuthIdentity = { id: string; organization_id: string; provider_id: string; provider_subject: string; linked_email: string };
type SourcePerson = { id: string; organization_id: string; first_name: string; last_name: string; preferred_name: string | null };
type SourceIdentifier = { id: string; organization_id: string; identifier_type: string; identifier_value: string };
type SourceContact = { id: string; organization_id: string; contact_type: string; contact_value: string };
type SourceCorrection = { id: string; organization_id: string; proposed_value: string };
type SourceImportFile = { id: string; organization_id: string; original_filename: string };
type SourceImportRow = { id: string; organization_id: string; normalized_json: Record<string, unknown> };
type SourcePush = { id: string; organization_id: string; subscription_json: unknown };

export type PiiBackfillSourceDataset = Readonly<{
  users: readonly SourceUser[];
  authIdentities: readonly SourceAuthIdentity[];
  people: readonly SourcePerson[];
  identifiers: readonly SourceIdentifier[];
  contacts: readonly SourceContact[];
  corrections: readonly SourceCorrection[];
  importFiles: readonly SourceImportFile[];
  importRows: readonly SourceImportRow[];
  pushSubscriptions: readonly SourcePush[];
}>;

export type PiiExactIndexPlanRow = Readonly<{
  organizationId: string;
  entityType: "user" | "auth_identity" | "person" | "person_identifier" | "person_contact_method" | "import_row" | "push_subscription";
  entityId: string;
  domain: string;
  keyVersion: string;
  hash: string;
}>;

export type PiiSearchTokenPlanRow = Readonly<{
  organizationId: string;
  personId: string;
  tokenDomain: "first_name" | "last_name" | "preferred_name" | "combined_name";
  tokenKind: "word" | "prefix";
  keyVersion: string;
  hash: string;
}>;

export type PiiBackfillPlan = Readonly<{
  users: readonly Record<string, unknown>[];
  authIdentities: readonly Record<string, unknown>[];
  people: readonly Record<string, unknown>[];
  identifiers: readonly Record<string, unknown>[];
  contacts: readonly Record<string, unknown>[];
  corrections: readonly Record<string, unknown>[];
  importFiles: readonly Record<string, unknown>[];
  importRows: readonly Record<string, unknown>[];
  pushSubscriptions: readonly Record<string, unknown>[];
  exactIndexes: readonly PiiExactIndexPlanRow[];
  searchTokens: readonly PiiSearchTokenPlanRow[];
  sourceCounts: Readonly<Record<string, number>>;
}>;

function requireSingleOrganization(dataset: PiiBackfillSourceDataset) {
  const ids = new Set<string>();
  for (const rows of Object.values(dataset)) {
    for (const row of rows as readonly { organization_id: string }[]) ids.add(row.organization_id);
  }
  if (ids.size !== 1) throw new Error("PII backfill dataset must contain exactly one organization.");
  return [...ids][0];
}

function enforceBounds(dataset: PiiBackfillSourceDataset) {
  for (const [name, rows] of Object.entries(dataset)) {
    if (rows.length > MAX_SYNTHETIC_BACKFILL_ROWS_PER_ENTITY) {
      throw new Error(`PII backfill source ${name} exceeds the synthetic bounded-row limit.`);
    }
  }
}

function field(plaintext: string, organizationId: string, entity: string, recordId: string, fieldName: string, config: PiiKeyConfiguration) {
  return encryptPiiField(plaintext, { organizationId, entity, recordId, field: fieldName }, config);
}

function addExactIndex(
  target: PiiExactIndexPlanRow[],
  normalized: string,
  organizationId: string,
  entityType: PiiExactIndexPlanRow["entityType"],
  entityId: string,
  domain: string,
  config: PiiKeyConfiguration,
) {
  const index = createPiiBlindIndex(normalized, { organizationId, domain }, config);
  target.push(Object.freeze({
    organizationId,
    entityType,
    entityId,
    domain,
    keyVersion: index.blindIndexKeyVersion,
    hash: index.blindIndex,
  }));
}

function addNameTokens(
  target: PiiSearchTokenPlanRow[],
  value: string,
  organizationId: string,
  personId: string,
  tokenDomain: PiiSearchTokenPlanRow["tokenDomain"],
  hashDomain: string,
  config: PiiKeyConfiguration,
) {
  for (const token of createPiiNameSearchTokens(value, { organizationId, domain: hashDomain }, config)) {
    target.push(Object.freeze({
      organizationId,
      personId,
      tokenDomain,
      tokenKind: token.tokenKind,
      keyVersion: token.tokenKeyVersion,
      hash: token.tokenHash,
    }));
  }
}

function stableObjectJson(value: Record<string, string>) {
  return JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))));
}

function directImportPii(value: Record<string, unknown>) {
  const result: Record<string, string> = {};
  for (const key of DIRECT_IMPORT_PII_FIELDS) {
    const raw = value[key];
    if (typeof raw === "string" && raw.trim() !== "") result[key] = raw;
  }
  return result;
}

function authProviderSubjectDomain(providerId: string) {
  const provider = providerId.trim().toLowerCase();
  if (!PROVIDER_RE.test(provider)) throw new Error("PII backfill auth provider id is invalid.");
  return `auth:provider-subject:${provider}`;
}

function normalizeImportPii(name: keyof typeof DIRECT_IMPORT_PII_BITS, raw: string) {
  if (name === "work_email" || name === "home_email") return normalizePiiEmail(raw);
  if (name === "work_phone" || name === "cell_phone" || name === "home_phone") return normalizePiiContactValue("phone", raw);
  if (name === "first_name" || name === "last_name" || name === "preferred_name") return normalizePiiNameForSearch(raw);
  return normalizePiiIdentifier(raw);
}

function normalizedImportValue(name: keyof typeof DIRECT_IMPORT_PII_BITS, raw: string) {
  try {
    return normalizeImportPii(name, raw);
  } catch (error) {
    if (error instanceof PiiProtectionError && error.code === "NORMALIZATION_FAILED") return null;
    throw error;
  }
}

export function buildSyntheticPiiBackfillPlan(dataset: PiiBackfillSourceDataset, config: PiiKeyConfiguration): PiiBackfillPlan {
  enforceBounds(dataset);
  const organizationId = requireSingleOrganization(dataset);
  const exactIndexes: PiiExactIndexPlanRow[] = [];
  const searchTokens: PiiSearchTokenPlanRow[] = [];

  const users = dataset.users.map((row) => {
    const email = field(row.email, organizationId, "user", row.id, "email", config);
    const displayName = field(row.display_name, organizationId, "user", row.id, "display-name", config);
    addExactIndex(exactIndexes, normalizePiiEmail(row.email), organizationId, "user", row.id, "user:email", config);
    return Object.freeze({
      organizationId, userId: row.id,
      emailEncryptedPayload: email.encryptedPayload,
      emailEncryptionKeyVersion: email.encryptionKeyVersion,
      emailEncryptionFormatVersion: email.encryptionFormatVersion,
      displayNameEncryptedPayload: displayName.encryptedPayload,
      displayNameEncryptionKeyVersion: displayName.encryptionKeyVersion,
      displayNameEncryptionFormatVersion: displayName.encryptionFormatVersion,
    });
  });

  const authIdentities = dataset.authIdentities.map((row) => {
    const subject = field(row.provider_subject, organizationId, "auth-identity", row.id, "provider-subject", config);
    const email = field(row.linked_email, organizationId, "auth-identity", row.id, "linked-email", config);
    addExactIndex(exactIndexes, normalizePiiIdentifier(row.provider_subject), organizationId, "auth_identity", row.id, authProviderSubjectDomain(row.provider_id), config);
    addExactIndex(exactIndexes, normalizePiiEmail(row.linked_email), organizationId, "auth_identity", row.id, "auth:linked-email", config);
    return Object.freeze({
      organizationId, authIdentityId: row.id,
      providerSubjectEncryptedPayload: subject.encryptedPayload,
      providerSubjectEncryptionKeyVersion: subject.encryptionKeyVersion,
      providerSubjectEncryptionFormatVersion: subject.encryptionFormatVersion,
      linkedEmailEncryptedPayload: email.encryptedPayload,
      linkedEmailEncryptionKeyVersion: email.encryptionKeyVersion,
      linkedEmailEncryptionFormatVersion: email.encryptionFormatVersion,
    });
  });

  const people = dataset.people.map((row) => {
    const first = field(row.first_name, organizationId, "person", row.id, "first-name", config);
    const last = field(row.last_name, organizationId, "person", row.id, "last-name", config);
    const preferred = row.preferred_name ? field(row.preferred_name, organizationId, "person", row.id, "preferred-name", config) : null;
    const normalizedSort = normalizePiiNameForSearch(`${row.last_name} ${row.first_name}${row.preferred_name ? ` ${row.preferred_name}` : ""}`);
    const sort = field(normalizedSort, organizationId, "person", row.id, "name-sort", config);
    addExactIndex(exactIndexes, normalizePiiNameForSearch(row.first_name), organizationId, "person", row.id, "person:first-name", config);
    addExactIndex(exactIndexes, normalizePiiNameForSearch(row.last_name), organizationId, "person", row.id, "person:last-name", config);
    addNameTokens(searchTokens, row.first_name, organizationId, row.id, "first_name", "first-name", config);
    addNameTokens(searchTokens, row.last_name, organizationId, row.id, "last_name", "last-name", config);
    if (row.preferred_name) {
      addExactIndex(exactIndexes, normalizePiiNameForSearch(row.preferred_name), organizationId, "person", row.id, "person:preferred-name", config);
      addNameTokens(searchTokens, row.preferred_name, organizationId, row.id, "preferred_name", "preferred-name", config);
    }
    addNameTokens(searchTokens, `${row.first_name} ${row.last_name}${row.preferred_name ? ` ${row.preferred_name}` : ""}`, organizationId, row.id, "combined_name", "combined-name", config);
    return Object.freeze({
      organizationId, personId: row.id,
      firstNameEncryptedPayload: first.encryptedPayload,
      firstNameEncryptionKeyVersion: first.encryptionKeyVersion,
      firstNameEncryptionFormatVersion: first.encryptionFormatVersion,
      lastNameEncryptedPayload: last.encryptedPayload,
      lastNameEncryptionKeyVersion: last.encryptionKeyVersion,
      lastNameEncryptionFormatVersion: last.encryptionFormatVersion,
      preferredNameEncryptedPayload: preferred?.encryptedPayload ?? null,
      preferredNameEncryptionKeyVersion: preferred?.encryptionKeyVersion ?? null,
      preferredNameEncryptionFormatVersion: preferred?.encryptionFormatVersion ?? null,
      nameSortEncryptedPayload: sort.encryptedPayload,
      nameSortEncryptionKeyVersion: sort.encryptionKeyVersion,
      nameSortEncryptionFormatVersion: sort.encryptionFormatVersion,
    });
  });

  const identifiers = dataset.identifiers.map((row) => {
    const protectedValue = field(row.identifier_value, organizationId, "person-identifier", row.id, "identifier-value", config);
    addExactIndex(exactIndexes, normalizePiiIdentifier(row.identifier_value), organizationId, "person_identifier", row.id, `identifier:${row.identifier_type.toLowerCase().replace(/[^a-z0-9.-]/g, "-")}`, config);
    return Object.freeze({ organizationId, personIdentifierId: row.id, encryptedPayload: protectedValue.encryptedPayload, encryptionKeyVersion: protectedValue.encryptionKeyVersion, encryptionFormatVersion: protectedValue.encryptionFormatVersion });
  });

  const contacts = dataset.contacts.map((row) => {
    const protectedValue = field(row.contact_value, organizationId, "person-contact", row.id, "contact-value", config);
    addExactIndex(exactIndexes, normalizePiiContactValue(row.contact_type, row.contact_value), organizationId, "person_contact_method", row.id, `contact:${row.contact_type.toLowerCase().replace(/[^a-z0-9.-]/g, "-")}`, config);
    return Object.freeze({ organizationId, contactMethodId: row.id, encryptedPayload: protectedValue.encryptedPayload, encryptionKeyVersion: protectedValue.encryptionKeyVersion, encryptionFormatVersion: protectedValue.encryptionFormatVersion });
  });

  const corrections = dataset.corrections.map((row) => {
    const protectedValue = field(row.proposed_value, organizationId, "correction-request", row.id, "proposed-value", config);
    return Object.freeze({ organizationId, correctionRequestId: row.id, encryptedPayload: protectedValue.encryptedPayload, encryptionKeyVersion: protectedValue.encryptionKeyVersion, encryptionFormatVersion: protectedValue.encryptionFormatVersion });
  });

  const importFiles = dataset.importFiles.map((row) => {
    const protectedValue = field(row.original_filename, organizationId, "import-file", row.id, "original-filename", config);
    return Object.freeze({ organizationId, importFileId: row.id, encryptedPayload: protectedValue.encryptedPayload, encryptionKeyVersion: protectedValue.encryptionKeyVersion, encryptionFormatVersion: protectedValue.encryptionFormatVersion });
  });

  const importRows = dataset.importRows.map((row) => {
    const bundle = directImportPii(row.normalized_json);
    const canonical = stableObjectJson(bundle);
    const protectedValue = field(canonical, organizationId, "import-row", row.id, "direct-pii", config);
    const integrity = createPiiIntegrityHash(canonical, { organizationId, domain: "import-row" }, config);
    let presenceMask = 0;
    let validityMask = 0;
    for (const [name, raw] of Object.entries(bundle) as [keyof typeof DIRECT_IMPORT_PII_BITS, string][]) {
      const bit = DIRECT_IMPORT_PII_BITS[name];
      presenceMask |= bit;
      const normalized = normalizedImportValue(name, raw);
      if (normalized === null) continue;
      validityMask |= bit;
      addExactIndex(exactIndexes, normalized, organizationId, "import_row", row.id, `import:${name.replaceAll("_", "-")}`, config);
      addExactIndex(exactIndexes, normalized, organizationId, "import_row", row.id, IMPORT_MATCH_DOMAINS[name], config);
    }
    return Object.freeze({
      organizationId,
      importRowId: row.id,
      encryptedPayload: protectedValue.encryptedPayload,
      encryptionKeyVersion: protectedValue.encryptionKeyVersion,
      encryptionFormatVersion: protectedValue.encryptionFormatVersion,
      fieldSetVersion: 3,
      presenceMask,
      validityMask,
      integrityHash: integrity.blindIndex,
      integrityKeyVersion: integrity.blindIndexKeyVersion,
    });
  });

  const pushSubscriptions = dataset.pushSubscriptions.map((row) => {
    const serialized = JSON.stringify(row.subscription_json);
    const protectedValue = field(serialized, organizationId, "push-subscription", row.id, "subscription", config);
    const endpoint = row.subscription_json && typeof row.subscription_json === "object" && !Array.isArray(row.subscription_json)
      ? (row.subscription_json as Record<string, unknown>).endpoint : null;
    if (typeof endpoint === "string" && endpoint.trim()) {
      addExactIndex(exactIndexes, normalizePiiIdentifier(endpoint), organizationId, "push_subscription", row.id, "push:endpoint", config);
    }
    return Object.freeze({ organizationId, pushSubscriptionId: row.id, encryptedPayload: protectedValue.encryptedPayload, encryptionKeyVersion: protectedValue.encryptionKeyVersion, encryptionFormatVersion: protectedValue.encryptionFormatVersion });
  });

  return Object.freeze({
    users, authIdentities, people, identifiers, contacts, corrections, importFiles, importRows, pushSubscriptions,
    exactIndexes: Object.freeze(exactIndexes),
    searchTokens: Object.freeze(searchTokens),
    sourceCounts: Object.freeze({
      users: dataset.users.length,
      authIdentities: dataset.authIdentities.length,
      people: dataset.people.length,
      identifiers: dataset.identifiers.length,
      contacts: dataset.contacts.length,
      corrections: dataset.corrections.length,
      importFiles: dataset.importFiles.length,
      importRows: dataset.importRows.length,
      pushSubscriptions: dataset.pushSubscriptions.length,
    }),
  });
}
