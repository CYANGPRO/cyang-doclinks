import { cookies, headers } from "next/headers";
import { sql } from "@/lib/db";
import { hmacSha256Hex, randomToken } from "@/lib/crypto";
import { readPreferredEnvBoolean } from "@/lib/envConfig";
import {
  hashPassword,
  hasUnsupportedPasswordChars,
  normalizeExactPasswordInput,
  passwordCharLength,
  verifyPassword,
} from "@/lib/password";

export const SIGNUP_TERMS_VERSION = "2026-03-01";
export const SIGNUP_CONSENT_COOKIE = "cy_signup_consent";

export type ManualSignupInput = {
  firstName: string;
  lastName: string;
  email: string;
  password: string;
  company: string;
  jobTitle: string;
  country: string;
};

const MAX_EMAIL_LEN = 320;
const MAX_COMPLEXITY_PASSWORD_LEN = 1024;
const MAX_SIGNUP_NAME_LEN = 120;
const MAX_SIGNUP_COMPANY_LEN = 200;
const MAX_SIGNUP_JOB_TITLE_LEN = 160;
const MAX_SIGNUP_COUNTRY_LEN = 120;
const MAX_ACCEPTANCE_SOURCE_LEN = 80;
const MAX_ACTIVATION_TOKEN_LEN = 512;
const MANUAL_PASSWORD_RESET_TTL_HOURS = 2;
const BASIC_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isSignupEnabled(): boolean {
  return readPreferredEnvBoolean(["SIGNUP_ENABLED", "NEXT_PUBLIC_SIGNUP_ENABLED"], true);
}

function normalizeEmail(emailRaw: string): string {
  const email = String(emailRaw || "").trim().toLowerCase();
  if (!email || email.length > MAX_EMAIL_LEN) return "";
  if (/[\r\n\0]/.test(email)) return "";
  if (!BASIC_EMAIL_RE.test(email)) return "";
  return email;
}

function normalizeTextField(valueRaw: string, maxLen: number): string {
  const value = String(valueRaw || "").trim();
  if (!value || value.length > maxLen) return "";
  if (/[\r\n\0]/.test(value)) return "";
  return value;
}

function normalizeOptionalTextField(valueRaw: string, maxLen: number): string {
  const value = String(valueRaw || "").trim();
  if (!value) return "";
  if (value.length > maxLen || /[\r\n\0]/.test(value)) return "";
  return value;
}

export function isTermsAccepted(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  const raw = String(value ?? "");
  if (!raw || /[\r\n\0]/.test(raw)) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

async function signupTablesReady(): Promise<boolean> {
  try {
    const rows = (await sql`select to_regclass('public.signup_accounts')::text as reg`) as unknown as Array<{ reg: string | null }>;
    return Boolean(rows?.[0]?.reg);
  } catch {
    return false;
  }
}

async function legalAcceptancesReady(): Promise<boolean> {
  try {
    const rows = (await sql`select to_regclass('public.legal_acceptances')::text as reg`) as unknown as Array<{ reg: string | null }>;
    return Boolean(rows?.[0]?.reg);
  } catch {
    return false;
  }
}

export function validatePasswordComplexity(password: string): string | null {
  const charLength = passwordCharLength(password);
  if (charLength > MAX_COMPLEXITY_PASSWORD_LEN) return "Password is too long.";
  if (hasUnsupportedPasswordChars(password)) return "Password contains unsupported characters.";
  if (charLength < 12) return "Password must be at least 12 characters.";
  if (!/[a-z]/.test(password)) return "Password must include a lowercase letter.";
  if (!/[A-Z]/.test(password)) return "Password must include an uppercase letter.";
  if (!/[0-9]/.test(password)) return "Password must include a number.";
  if (!/[^A-Za-z0-9]/.test(password)) return "Password must include a symbol.";
  return null;
}

export async function setSignupConsentCookie(): Promise<void> {
  const c = await cookies();
  c.set(SIGNUP_CONSENT_COOKIE, "1", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 15 * 60,
  });
}

export async function hasSignupConsentCookie(): Promise<boolean> {
  const c = await cookies();
  return c.get(SIGNUP_CONSENT_COOKIE)?.value === "1";
}

export async function recordTermsAcceptance(emailRaw: string, source: string): Promise<void> {
  const email = normalizeEmail(emailRaw);
  if (!email) return;
  const sourceValue = normalizeTextField(source, MAX_ACCEPTANCE_SOURCE_LEN);
  if (!sourceValue) return;
  if (!(await legalAcceptancesReady())) return;

  let userAgent: string | null = null;
  try {
    userAgent = (await headers()).get("user-agent");
  } catch {
    userAgent = null;
  }

  await sql`
    insert into public.legal_acceptances (
      email,
      terms_version,
      accepted_at,
      acceptance_source,
      user_agent
    )
    values (
      ${email},
      ${SIGNUP_TERMS_VERSION},
      now(),
      ${sourceValue},
      ${userAgent}
    )
    on conflict (email, terms_version) do update
      set accepted_at = excluded.accepted_at,
          acceptance_source = excluded.acceptance_source,
          user_agent = excluded.user_agent
  `;
}

export async function createOrRefreshManualSignup(input: ManualSignupInput): Promise<{ token: string }> {
  const email = normalizeEmail(input.email);
  const firstName = normalizeTextField(input.firstName, MAX_SIGNUP_NAME_LEN);
  const lastName = normalizeTextField(input.lastName, MAX_SIGNUP_NAME_LEN);
  const company = normalizeTextField(input.company, MAX_SIGNUP_COMPANY_LEN);
  const jobTitle = normalizeOptionalTextField(input.jobTitle, MAX_SIGNUP_JOB_TITLE_LEN);
  const country = normalizeTextField(input.country, MAX_SIGNUP_COUNTRY_LEN);
  const password = normalizeExactPasswordInput(input.password, MAX_COMPLEXITY_PASSWORD_LEN);
  if (!email || !firstName || !lastName || !company || !country || !password) {
    throw new Error("INVALID_SIGNUP_INPUT");
  }
  if (validatePasswordComplexity(password)) {
    throw new Error("INVALID_SIGNUP_INPUT");
  }

  if (!(await signupTablesReady())) {
    throw new Error("SIGNUP_TABLES_MISSING");
  }

  const token = randomToken(32);
  const tokenHash = hmacSha256Hex(token);
  const passwordHash = hashPassword(password);

  await sql`
    insert into public.signup_accounts (
      email,
      first_name,
      last_name,
      company,
      job_title,
      country,
      password_hash,
      terms_version,
      terms_accepted_at,
      activation_token_hash,
      activation_expires_at,
      activated_at
    )
    values (
      ${email},
      ${firstName},
      ${lastName},
      ${company || null},
      ${jobTitle || null},
      ${country || null},
      ${passwordHash},
      ${SIGNUP_TERMS_VERSION},
      now(),
      ${tokenHash},
      now() + interval '24 hours',
      null
    )
    on conflict (email) do update
      set first_name = excluded.first_name,
          last_name = excluded.last_name,
          company = excluded.company,
          job_title = excluded.job_title,
          country = excluded.country,
          password_hash = excluded.password_hash,
          terms_version = excluded.terms_version,
          terms_accepted_at = excluded.terms_accepted_at,
          activation_token_hash = excluded.activation_token_hash,
          activation_expires_at = excluded.activation_expires_at,
          activated_at = null,
          updated_at = now()
  `;

  return { token };
}

export async function activateManualSignup(emailRaw: string, tokenRaw: string): Promise<{ ok: true; email: string }> {
  const email = normalizeEmail(emailRaw);
  const token = String(tokenRaw || "");
  if (!email || !token || token.length > MAX_ACTIVATION_TOKEN_LEN || /[\r\n\0]/.test(token)) {
    throw new Error("INVALID_TOKEN");
  }

  if (!(await signupTablesReady())) {
    throw new Error("SIGNUP_TABLES_MISSING");
  }

  const tokenHash = hmacSha256Hex(token);

  const rows = (await sql`
    select
      email,
      first_name,
      last_name,
      terms_version,
      activation_token_hash,
      activation_expires_at::text as activation_expires_at,
      activated_at::text as activated_at
    from public.signup_accounts
    where email = ${email}
    limit 1
  `) as unknown as Array<{
    email: string;
    first_name: string;
    last_name: string;
    terms_version: string;
    activation_token_hash: string | null;
    activation_expires_at: string | null;
    activated_at: string | null;
  }>;

  const row = rows?.[0];
  if (!row) throw new Error("INVALID_TOKEN");
  if (row.activated_at) return { ok: true, email };
  if (!row.activation_token_hash || row.activation_token_hash !== tokenHash) throw new Error("INVALID_TOKEN");
  if (!row.activation_expires_at || new Date(row.activation_expires_at).getTime() <= Date.now()) {
    throw new Error("TOKEN_EXPIRED");
  }

  await sql`
    update public.signup_accounts
    set activated_at = now(),
        activation_token_hash = null,
        activation_expires_at = null,
        updated_at = now()
    where email = ${email}
  `;

  await sql`
    insert into public.users (email, role)
    values (${email}, 'viewer')
    on conflict (email) do update
      set role = case
        when public.users.role = 'owner' then 'owner'
        when public.users.role = 'admin' then 'admin'
        else public.users.role
      end
  `;

  await recordTermsAcceptance(email, "manual_signup");
  return { ok: true, email };
}

export async function issueManualPasswordReset(emailRaw: string): Promise<{ email: string; token: string } | null> {
  const email = normalizeEmail(emailRaw);
  if (!email) return null;

  if (!(await signupTablesReady())) {
    throw new Error("SIGNUP_TABLES_MISSING");
  }

  const rows = (await sql`
    select
      email,
      activated_at::text as activated_at
    from public.signup_accounts
    where email = ${email}
    limit 1
  `) as unknown as Array<{
    email: string;
    activated_at: string | null;
  }>;

  const row = rows?.[0];
  if (!row?.activated_at) return null;

  const token = randomToken(32);
  const tokenHash = hmacSha256Hex(token);

  await sql`
    update public.signup_accounts
    set activation_token_hash = ${tokenHash},
        activation_expires_at = now() + (${MANUAL_PASSWORD_RESET_TTL_HOURS}::text || ' hours')::interval,
        updated_at = now()
    where email = ${email}
      and activated_at is not null
  `;

  return { email, token };
}

export async function resetManualPassword(args: {
  email: string;
  token: string;
  password: string;
}): Promise<{ ok: true; email: string }> {
  const email = normalizeEmail(args.email);
  const token = String(args.token || "");
  const password = normalizeExactPasswordInput(args.password, MAX_COMPLEXITY_PASSWORD_LEN);
  if (!email || !token || token.length > MAX_ACTIVATION_TOKEN_LEN || /[\r\n\0]/.test(token)) {
    throw new Error("INVALID_TOKEN");
  }
  if (!password || validatePasswordComplexity(password)) {
    throw new Error("INVALID_PASSWORD");
  }

  if (!(await signupTablesReady())) {
    throw new Error("SIGNUP_TABLES_MISSING");
  }

  const tokenHash = hmacSha256Hex(token);
  const rows = (await sql`
    select
      email,
      activation_token_hash,
      activation_expires_at::text as activation_expires_at,
      activated_at::text as activated_at
    from public.signup_accounts
    where email = ${email}
    limit 1
  `) as unknown as Array<{
    email: string;
    activation_token_hash: string | null;
    activation_expires_at: string | null;
    activated_at: string | null;
  }>;

  const row = rows?.[0];
  if (!row?.activated_at) throw new Error("INVALID_TOKEN");
  if (!row.activation_token_hash || row.activation_token_hash !== tokenHash) throw new Error("INVALID_TOKEN");
  if (!row.activation_expires_at || new Date(row.activation_expires_at).getTime() <= Date.now()) {
    throw new Error("TOKEN_EXPIRED");
  }

  const passwordHash = hashPassword(password);
  await sql`
    update public.signup_accounts
    set password_hash = ${passwordHash},
        activation_token_hash = null,
        activation_expires_at = null,
        updated_at = now()
    where email = ${email}
      and activated_at is not null
  `;

  return { ok: true, email };
}

export async function verifyManualCredentials(emailRaw: string, password: string): Promise<null | { email: string; name: string }> {
  if (!(await signupTablesReady())) return null;
  const email = normalizeEmail(emailRaw);
  const rawPassword = normalizeExactPasswordInput(password, 4096);
  if (!email || !rawPassword) return null;

  const rows = (await sql`
    select
      email,
      first_name,
      last_name,
      password_hash,
      activated_at::text as activated_at
    from public.signup_accounts
    where email = ${email}
    limit 1
  `) as unknown as Array<{
    email: string;
    first_name: string;
    last_name: string;
    password_hash: string;
    activated_at: string | null;
  }>;

  const row = rows?.[0];
  if (!row || !row.activated_at) return null;
  if (!verifyPassword(rawPassword, row.password_hash)) return null;
  return { email: row.email, name: `${row.first_name} ${row.last_name}`.trim() };
}
