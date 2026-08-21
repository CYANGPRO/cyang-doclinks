import "server-only";

function record(value: Record<string, unknown>) { return value; }

export function serializeBackfillUser(raw: Record<string, unknown>) {
  return record({
    organization_id: raw.organizationId,
    user_id: raw.userId,
    email_encrypted_payload: raw.emailEncryptedPayload,
    email_encryption_key_version: raw.emailEncryptionKeyVersion,
    email_encryption_format_version: raw.emailEncryptionFormatVersion,
    display_name_encrypted_payload: raw.displayNameEncryptedPayload,
    display_name_encryption_key_version: raw.displayNameEncryptionKeyVersion,
    display_name_encryption_format_version: raw.displayNameEncryptionFormatVersion,
  });
}

export function serializeBackfillAuthIdentity(raw: Record<string, unknown>) {
  return record({
    organization_id: raw.organizationId,
    auth_identity_id: raw.authIdentityId,
    provider_subject_encrypted_payload: raw.providerSubjectEncryptedPayload,
    provider_subject_encryption_key_version: raw.providerSubjectEncryptionKeyVersion,
    provider_subject_encryption_format_version: raw.providerSubjectEncryptionFormatVersion,
    linked_email_encrypted_payload: raw.linkedEmailEncryptedPayload,
    linked_email_encryption_key_version: raw.linkedEmailEncryptionKeyVersion,
    linked_email_encryption_format_version: raw.linkedEmailEncryptionFormatVersion,
  });
}

export function serializeBackfillPerson(raw: Record<string, unknown>) {
  return record({
    organization_id: raw.organizationId,
    person_id: raw.personId,
    first_name_encrypted_payload: raw.firstNameEncryptedPayload,
    first_name_encryption_key_version: raw.firstNameEncryptionKeyVersion,
    first_name_encryption_format_version: raw.firstNameEncryptionFormatVersion,
    last_name_encrypted_payload: raw.lastNameEncryptedPayload,
    last_name_encryption_key_version: raw.lastNameEncryptionKeyVersion,
    last_name_encryption_format_version: raw.lastNameEncryptionFormatVersion,
    preferred_name_encrypted_payload: raw.preferredNameEncryptedPayload,
    preferred_name_encryption_key_version: raw.preferredNameEncryptionKeyVersion,
    preferred_name_encryption_format_version: raw.preferredNameEncryptionFormatVersion,
    name_sort_encrypted_payload: raw.nameSortEncryptedPayload,
    name_sort_encryption_key_version: raw.nameSortEncryptionKeyVersion,
    name_sort_encryption_format_version: raw.nameSortEncryptionFormatVersion,
  });
}

export function serializeBackfillSimple(raw: Record<string, unknown>, idKey: string) {
  return record({
    organization_id: raw.organizationId,
    entity_id: raw[idKey],
    encrypted_payload: raw.encryptedPayload,
    encryption_key_version: raw.encryptionKeyVersion,
    encryption_format_version: raw.encryptionFormatVersion,
  });
}

export function serializeBackfillImportRow(raw: Record<string, unknown>) {
  return record({
    organization_id: raw.organizationId,
    import_row_id: raw.importRowId,
    encrypted_payload: raw.encryptedPayload,
    encryption_key_version: raw.encryptionKeyVersion,
    encryption_format_version: raw.encryptionFormatVersion,
    field_set_version: raw.fieldSetVersion,
    presence_mask: raw.presenceMask,
    validity_mask: raw.validityMask,
    integrity_hash: raw.integrityHash,
    integrity_key_version: raw.integrityKeyVersion,
  });
}

export function serializeBackfillExactIndex(raw: Record<string, unknown>) {
  return record({
    organization_id: raw.organizationId,
    entity_type: raw.entityType,
    entity_id: raw.entityId,
    domain: raw.domain,
    key_version: raw.keyVersion,
    hash: raw.hash,
  });
}

export function serializeBackfillSearchToken(raw: Record<string, unknown>) {
  return record({
    organization_id: raw.organizationId,
    person_id: raw.personId,
    token_domain: raw.tokenDomain,
    token_kind: raw.tokenKind,
    key_version: raw.keyVersion,
    hash: raw.hash,
  });
}
