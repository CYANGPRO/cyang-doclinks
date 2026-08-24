import "server-only";

import { z } from "zod";

const appSchema = z.object({
  LOCAL801_APP_URL: z.string().url().default("https://cat.cyang.io"),
  LOCAL801_APP_NAME: z.string().default("Engaging Local 801"),
  LOCAL801_APP_SHORT_NAME: z.string().default("801 Engage"),
  LOCAL801_THEME_COLOR: z.string().default("#134d8c"),
  SIGNUP_ENABLED: z.enum(["0", "1"]).default("0"),
  MFA_ENFORCE_ALL: z.enum(["0", "1"]).default("1"),
  LOCAL801_CAT_SESSION_SECONDS: z.coerce.number().int().positive().default(604800),
  LOCAL801_ADMIN_SESSION_SECONDS: z.coerce.number().int().positive().default(43200),
  LOCAL801_REAUTH_WINDOW_SECONDS: z.coerce.number().int().positive().default(900),
  LOCAL801_IMPORT_MAX_BYTES: z.coerce.number().int().positive().default(20971520),
  LOCAL801_IMPORT_MAX_ROWS: z.coerce.number().int().positive().default(25000),
  LOCAL801_EXPORT_MAX_ROWS: z.coerce.number().int().positive().default(5000),
  LOCAL801_SMALL_CELL_THRESHOLD: z.coerce.number().int().min(2).default(5),
  LOCAL801_SEARCH_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(10).max(600).default(60),
  LOCAL801_IMPORT_RATE_LIMIT_PER_HOUR: z.coerce.number().int().min(1).max(100).default(10),
  LOCAL801_EXPORT_RATE_LIMIT_PER_HOUR: z.coerce.number().int().min(1).max(200).default(20),
  LOCAL801_DOWNLOAD_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(200).default(20),
  LOCAL801_MUTATION_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(10).max(600).default(120),
  LOCAL801_PUSH_ENABLED: z.enum(["0", "1"]).default("0"),
  LOCAL801_PREVIEW_AUTH_ENABLED: z.enum(["0", "1"]).default("0"),
});

const databaseSchema = z.object({
  LOCAL801_DATABASE_URL: z
    .string({ error: "LOCAL801_DATABASE_URL is required for Local 801 database access." })
    .min(1, "LOCAL801_DATABASE_URL is required for Local 801 database access."),
});

const storageSchema = z.object({
  LOCAL801_R2_ACCOUNT_ID: z.string().min(1, "LOCAL801_R2_ACCOUNT_ID is required for Local 801 R2 storage."),
  LOCAL801_R2_ENDPOINT: z.string().url("LOCAL801_R2_ENDPOINT must be a valid URL."),
  LOCAL801_R2_BUCKET: z.string().min(1, "LOCAL801_R2_BUCKET is required for Local 801 storage."),
  LOCAL801_R2_ACCESS_KEY_ID: z.string().min(1, "LOCAL801_R2_ACCESS_KEY_ID is required for Local 801 storage."),
  LOCAL801_R2_SECRET_ACCESS_KEY: z.string().min(1, "LOCAL801_R2_SECRET_ACCESS_KEY is required for Local 801 storage."),
});

const encryptionEnvironmentSchema = z.object({
  LOCAL801_ENCRYPTION_MASTER_KEYS: z
    .string({ error: "LOCAL801_ENCRYPTION_MASTER_KEYS is required for Local 801 encryption." })
    .min(1, "LOCAL801_ENCRYPTION_MASTER_KEYS is required for Local 801 encryption."),
  LOCAL801_ACTIVE_ENCRYPTION_KEY_VERSION: z
    .string({ error: "LOCAL801_ACTIVE_ENCRYPTION_KEY_VERSION is required for Local 801 encryption." })
    .min(1, "LOCAL801_ACTIVE_ENCRYPTION_KEY_VERSION is required for Local 801 encryption."),
});

const keyVersionPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
const base64Pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export type EncryptionKeyring = {
  activeVersion: string;
  keys: Readonly<Record<string, Buffer>>;
};

function readJsonString(source: string, start: number) {
  if (source[start] !== '"') throw new Error("Expected a JSON string.");
  let escaped = false;
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      const raw = source.slice(start, index + 1);
      return { value: JSON.parse(raw) as string, next: index + 1 };
    }
  }
  throw new Error("Unterminated JSON string.");
}

function skipWhitespace(source: string, start: number) {
  let index = start;
  while (/\s/.test(source[index] ?? "")) index += 1;
  return index;
}

/** Parses the deliberately narrow {"version":"base64"} keyring format without accepting duplicate keys. */
function parseUniqueStringMap(source: string): Record<string, string> {
  let index = skipWhitespace(source, 0);
  if (source[index] !== "{") throw new Error("Keyring must be a JSON object.");
  index = skipWhitespace(source, index + 1);

  const values: Record<string, string> = Object.create(null) as Record<string, string>;
  if (source[index] === "}") {
    index = skipWhitespace(source, index + 1);
    if (index !== source.length) throw new Error("Unexpected content after keyring.");
    return values;
  }

  while (index < source.length) {
    const keyToken = readJsonString(source, index);
    const version = keyToken.value;
    if (Object.prototype.hasOwnProperty.call(values, version)) {
      throw new Error("LOCAL801_ENCRYPTION_MASTER_KEYS contains a duplicate key version.");
    }

    index = skipWhitespace(source, keyToken.next);
    if (source[index] !== ":") throw new Error("Expected ':' after key version.");
    index = skipWhitespace(source, index + 1);

    const valueToken = readJsonString(source, index);
    values[version] = valueToken.value;
    index = skipWhitespace(source, valueToken.next);

    if (source[index] === "}") {
      index = skipWhitespace(source, index + 1);
      if (index !== source.length) throw new Error("Unexpected content after keyring.");
      return values;
    }
    if (source[index] !== ",") throw new Error("Expected ',' between keyring entries.");
    index = skipWhitespace(source, index + 1);
  }

  throw new Error("Unterminated keyring object.");
}

export function getAppConfig(env: NodeJS.ProcessEnv = process.env) {
  return appSchema.parse(env);
}

export function getDatabaseConfig(env: NodeJS.ProcessEnv = process.env) {
  return databaseSchema.parse({ LOCAL801_DATABASE_URL: env.LOCAL801_DATABASE_URL });
}

export function getStorageConfig(env: NodeJS.ProcessEnv = process.env) {
  const config = storageSchema.parse({
    LOCAL801_R2_ACCOUNT_ID: env.LOCAL801_R2_ACCOUNT_ID,
    LOCAL801_R2_ENDPOINT: env.LOCAL801_R2_ENDPOINT,
    LOCAL801_R2_BUCKET: env.LOCAL801_R2_BUCKET,
    LOCAL801_R2_ACCESS_KEY_ID: env.LOCAL801_R2_ACCESS_KEY_ID,
    LOCAL801_R2_SECRET_ACCESS_KEY: env.LOCAL801_R2_SECRET_ACCESS_KEY,
  });
  const endpoint = new URL(config.LOCAL801_R2_ENDPOINT);
  const hostname = endpoint.hostname.toLowerCase();
  const expectedPrefix = `${config.LOCAL801_R2_ACCOUNT_ID.toLowerCase()}.`;
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    (endpoint.pathname !== "" && endpoint.pathname !== "/") ||
    endpoint.search ||
    endpoint.hash ||
    !hostname.startsWith(expectedPrefix) ||
    !hostname.endsWith(".r2.cloudflarestorage.com")
  ) {
    throw new Error("LOCAL801_R2_ENDPOINT must be the private endpoint for LOCAL801_R2_ACCOUNT_ID.");
  }
  return config;
}

export function getEncryptionConfig(env: NodeJS.ProcessEnv = process.env): EncryptionKeyring {
  const config = encryptionEnvironmentSchema.parse({
    LOCAL801_ENCRYPTION_MASTER_KEYS: env.LOCAL801_ENCRYPTION_MASTER_KEYS,
    LOCAL801_ACTIVE_ENCRYPTION_KEY_VERSION: env.LOCAL801_ACTIVE_ENCRYPTION_KEY_VERSION,
  });

  let encodedKeys: Record<string, string>;
  try {
    encodedKeys = parseUniqueStringMap(config.LOCAL801_ENCRYPTION_MASTER_KEYS);
  } catch (error) {
    if (error instanceof Error && error.message.includes("duplicate key version")) throw error;
    throw new Error("LOCAL801_ENCRYPTION_MASTER_KEYS must be valid JSON in the documented keyring format.");
  }

  const entries = Object.entries(encodedKeys);
  if (entries.length === 0) throw new Error("LOCAL801_ENCRYPTION_MASTER_KEYS must contain at least one key.");

  const keys: Record<string, Buffer> = Object.create(null) as Record<string, Buffer>;
  for (const [version, encodedKey] of entries) {
    if (!keyVersionPattern.test(version)) {
      throw new Error("Encryption key versions must use 1-32 letters, numbers, dots, underscores, or hyphens.");
    }
    if (!base64Pattern.test(encodedKey)) {
      throw new Error(`Encryption key ${version} must be canonical base64.`);
    }
    const key = Buffer.from(encodedKey, "base64");
    if (key.byteLength !== 32 || key.toString("base64") !== encodedKey) {
      throw new Error(`Encryption key ${version} must decode to exactly 32 bytes.`);
    }
    keys[version] = key;
  }

  if (!Object.prototype.hasOwnProperty.call(keys, config.LOCAL801_ACTIVE_ENCRYPTION_KEY_VERSION)) {
    throw new Error("LOCAL801_ACTIVE_ENCRYPTION_KEY_VERSION must match an entry in LOCAL801_ENCRYPTION_MASTER_KEYS.");
  }

  return { activeVersion: config.LOCAL801_ACTIVE_ENCRYPTION_KEY_VERSION, keys };
}

export function assertLocal801Isolation(env: NodeJS.ProcessEnv = process.env) {
  const app = getAppConfig(env);
  const doclinksUrl = env.DATABASE_URL;
  const localUrl = env.LOCAL801_DATABASE_URL;
  const doclinksBucket = env.R2_BUCKET ?? env.R2_BUCKET_NAME;
  const localBucket = env.LOCAL801_R2_BUCKET;

  const databaseTarget = (value: string | undefined) => {
    if (!value) return null;
    try {
      const parsed = new URL(value);
      return `${parsed.protocol}//${parsed.hostname.toLowerCase()}:${parsed.port}/${parsed.pathname.replace(/^\//, "")}`;
    } catch {
      return null;
    }
  };
  const localDatabaseTarget = databaseTarget(localUrl);
  const doclinksDatabaseTarget = databaseTarget(doclinksUrl);

  return {
    separateDatabase: Boolean(
      localDatabaseTarget && (!doclinksDatabaseTarget || localDatabaseTarget !== doclinksDatabaseTarget),
    ),
    separateStorage: Boolean(localBucket && (!doclinksBucket || localBucket !== doclinksBucket)),
    signupDisabled: app.SIGNUP_ENABLED === "0",
    mfaRequired: app.MFA_ENFORCE_ALL === "1",
    pushDisabled: app.LOCAL801_PUSH_ENABLED === "0",
  };
}
