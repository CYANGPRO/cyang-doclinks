import type { ErrorEvent } from "@sentry/nextjs";

const sentryPublicKeyPattern = /^[a-f0-9]{16,64}$/i;
const sentryIngestHostPattern = /^o[0-9]+\.ingest(?:\.[a-z0-9-]+)?\.sentry\.io$/i;

export function sentryDsnLooksValid(value: string | undefined) {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:"
      && sentryPublicKeyPattern.test(parsed.username)
      && !parsed.password
      && !parsed.port
      && sentryIngestHostPattern.test(parsed.hostname)
      && /^\/[0-9]+\/?$/.test(parsed.pathname)
      && !parsed.search
      && !parsed.hash;
  } catch {
    return false;
  }
}

export function sentryConfigLooksValid(env: NodeJS.ProcessEnv = process.env) {
  return env.LOCAL801_SENTRY_ENABLED === "1" && sentryDsnLooksValid(env.LOCAL801_SENTRY_DSN?.trim());
}

export function getSentryRuntimeConfig(env: NodeJS.ProcessEnv = process.env) {
  const configured = sentryConfigLooksValid(env);
  return Object.freeze({
    enabled: env.VERCEL_ENV === "production" && configured,
    dsn: configured ? env.LOCAL801_SENTRY_DSN?.trim() : undefined,
  });
}

function safeErrorType(value: string | undefined) {
  return value && /^[A-Za-z][A-Za-z0-9_.:-]{0,120}$/.test(value) ? value : "Error";
}

/**
 * Retain only source locations and coarse error types. Request data, identities,
 * breadcrumbs, dynamic transaction names, exception messages, frame variables,
 * and source context are removed before an event can leave the application.
 */
export function scrubSentryEvent(event: ErrorEvent): ErrorEvent {
  delete event.breadcrumbs;
  delete event.contexts;
  delete event.extra;
  delete event.fingerprint;
  delete event.logentry;
  delete event.logger;
  delete event.message;
  delete event.modules;
  delete event.request;
  delete event.server_name;
  delete event.tags;
  delete event.transaction;
  delete event.user;

  if (event.exception?.values) {
    event.exception.values = event.exception.values.map((exception) => ({
      type: safeErrorType(exception.type),
      value: "Redacted application error",
      stacktrace: exception.stacktrace?.frames ? {
        frames: exception.stacktrace.frames.map((frame) => ({
          filename: frame.filename,
          function: frame.function,
          lineno: frame.lineno,
          colno: frame.colno,
          in_app: frame.in_app,
        })),
      } : undefined,
    }));
  }

  return event;
}
