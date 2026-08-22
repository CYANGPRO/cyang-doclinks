import assert from "node:assert/strict";
import test from "node:test";
import { assertProductionInitializationRequest, parseProductionInitializationTarget } from "../scripts/lib/production-initializer-policy.mjs";

function target(overrides = {}) {
  return {
    LOCAL801_DATABASE_URL: "postgresql://cat:secret@cat-prod.db.example.test/local801_prod?sslmode=require",
    LOCAL801_PRODUCTION_DATABASE_HOST: "cat-prod.db.example.test",
    LOCAL801_PRODUCTION_DATABASE_NAME: "local801_prod",
    LOCAL801_DATABASE_ENVIRONMENT: "production",
    LOCAL801_ORGANIZATION_SLUG: "local801",
    LOCAL801_PRODUCTION_LAUNCH_ENABLED: "0",
    LOCAL801_ALLOW_SYNTHETIC_SEED: "0",
    ...overrides,
  };
}

test("production initializer requires exact CAT target identity and TLS", () => {
  assert.equal(parseProductionInitializationTarget(target()).databaseName, "local801_prod");
  assert.throws(() => parseProductionInitializationTarget(target({ LOCAL801_DATABASE_URL: "postgresql://cat:secret@other.db.example.test/local801_prod?sslmode=require" })), /does not match/);
  assert.throws(() => parseProductionInitializationTarget(target({ LOCAL801_DATABASE_URL: "postgresql://cat:secret@cat-prod.db.example.test/local801_prod" })), /requires database TLS/);
  assert.throws(() => parseProductionInitializationTarget(target({ LOCAL801_DATABASE_ENVIRONMENT: "preview" })), /explicitly production/);
  assert.throws(() => parseProductionInitializationTarget(target({ LOCAL801_PRODUCTION_DATABASE_NAME: "local801_sql_test", LOCAL801_DATABASE_URL: "postgresql://cat:secret@cat-prod.db.example.test/local801_sql_test?sslmode=require" })), /refuses Preview, test, or development/);
  assert.throws(() => parseProductionInitializationTarget(target({ LOCAL801_PRODUCTION_DATABASE_NAME: "cyang_doclinks", LOCAL801_DATABASE_URL: "postgresql://cat:secret@cat-prod.db.example.test/cyang_doclinks?sslmode=require" })), /DocLinks target/);
  assert.throws(() => parseProductionInitializationTarget(target({ DATABASE_URL: target().LOCAL801_DATABASE_URL })), /reused by the root application/);
  assert.throws(() => parseProductionInitializationTarget(target({ DATABASE_URL: "not-a-url" })), /cannot be proven separate/);
  assert.throws(() => parseProductionInitializationTarget(target({ LOCAL801_PRODUCTION_DATABASE_HOST: "localhost", LOCAL801_DATABASE_URL: "postgresql://cat:secret@localhost/local801_prod?sslmode=require" })), /ambiguous/);
  assert.throws(() => parseProductionInitializationTarget(target({ LOCAL801_DATABASE_URL: "https://cat-prod.db.example.test/local801_prod?sslmode=require" })), /not a PostgreSQL/);
});

test("production initializer requires launch disabled, explicit opt-in, and exact typed confirmation", () => {
  assert.throws(() => parseProductionInitializationTarget(target({ LOCAL801_PRODUCTION_LAUNCH_ENABLED: "1" })), /must remain disabled/);
  assert.throws(() => assertProductionInitializationRequest(target(), "initialize"), /opt-in is missing/);
  const configured = target({
    LOCAL801_PRODUCTION_INITIALIZE: "1",
    LOCAL801_PRODUCTION_INITIALIZATION_CONFIRMATION: "INITIALIZE LOCAL801 PRODUCTION cat-prod.db.example.test/local801_prod local801",
    LOCAL801_ORGANIZATION_NAME: "Local 801",
    LOCAL801_INITIAL_SYSTEM_OWNER_EMAIL: "owner@example.test",
    LOCAL801_INITIAL_SYSTEM_OWNER_DISPLAY_NAME: "Synthetic Owner",
  });
  const accepted = assertProductionInitializationRequest(configured, "initialize");
  assert.equal(accepted.ownerEmail, "owner@example.test");
  assert.throws(() => assertProductionInitializationRequest({ ...configured, LOCAL801_PRODUCTION_INITIALIZATION_CONFIRMATION: "INITIALIZE" }, "initialize"), /does not match/);
  assert.throws(() => assertProductionInitializationRequest({ ...configured, LOCAL801_INITIAL_SYSTEM_OWNER_EMAIL: "invalid" }, "initialize"), /input is invalid/);
  assert.throws(() => assertProductionInitializationRequest({ ...configured, LOCAL801_ORGANIZATION_NAME: "x".repeat(161) }, "initialize"), /input is invalid/);
  assert.throws(() => assertProductionInitializationRequest(configured, "dry-run"), /inspect or initialize/);
});

test("production initializer rejects every environment and slug ambiguity guard", () => {
  assert.throws(() => parseProductionInitializationTarget(target({ LOCAL801_DATABASE_ENVIRONMENT: "preview" })), /explicitly production/);
  assert.throws(() => parseProductionInitializationTarget(target({ LOCAL801_ORGANIZATION_SLUG: "local801-preview" })), /slug is invalid/);
  assert.throws(() => parseProductionInitializationTarget(target({ LOCAL801_ORGANIZATION_SLUG: "bad_slug" })), /slug is invalid/);
  assert.throws(() => parseProductionInitializationTarget(target({ LOCAL801_ALLOW_SYNTHETIC_SEED: "1" })), /seeding must remain disabled/);
  assert.throws(() => parseProductionInitializationTarget(target({ LOCAL801_PRODUCTION_LAUNCH_ENABLED: "1" })), /launch must remain disabled/);
});

test("initializer source verifies protected companions, blind index, role, constraints, and protected state transactionally", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) => readFile(new URL("../scripts/initialize-production.mjs", import.meta.url), "utf8"));
  for (const evidence of [
    "verifyProtectedOwner", "decryptPiiField", "createPiiBlindIndex", "pii_protected_mode_enabled",
    "set constraints all immediate", "workspace_user_roles", "production_initializations",
  ]) assert.match(source, new RegExp(evidence.replaceAll(" ", "\\s+"), "i"));
  assert.match(source, /entity: "user", recordId: ownerId, field: "email"/);
  assert.match(source, /entity: "user", recordId: ownerId, field: "display-name"/);
  assert.match(source, /Protected user \$\{ownerId\}/);
  assert.doesNotMatch(source, /console\.(?:log|error)\([^\n]*(?:ownerEmail|ownerDisplayName)/);
});

test("inspection mode does not require owner PII or initialization opt-in", () => {
  const inspected = assertProductionInitializationRequest(target(), "inspect");
  assert.equal(inspected.organizationSlug, "local801");
  assert.equal("ownerEmail" in inspected, false);
});
