import type { ErrorEvent, StackFrame, Stacktrace } from "@sentry/nextjs";

function scrubFrame(frame: StackFrame): StackFrame {
  return {
    filename: frame.filename,
    function: frame.function,
    module: frame.module,
    lineno: frame.lineno,
    colno: frame.colno,
    in_app: frame.in_app,
  };
}

function scrubStacktrace(stacktrace: Stacktrace | undefined): Stacktrace | undefined {
  if (!stacktrace?.frames) return undefined;
  return { frames: stacktrace.frames.map(scrubFrame) };
}

export function sanitizeLocal801SentryEvent(event: ErrorEvent): ErrorEvent {
  const exceptionValues = event.exception?.values?.map((value) => ({
    type: "Local801ApplicationError",
    value: "Redacted application error",
    stacktrace: scrubStacktrace(value.stacktrace),
  }));

  return {
    type: undefined,
    event_id: event.event_id,
    timestamp: event.timestamp,
    platform: event.platform,
    level: event.level,
    environment: event.environment,
    release: event.release,
    sdk: event.sdk,
    exception: exceptionValues?.length ? { values: exceptionValues } : undefined,
    message: event.message ? "[redacted]" : undefined,
    tags: { application: "local801-cat" },
  };
}

export function local801SentryOptions() {
  const dsn = process.env.LOCAL801_SENTRY_DSN?.trim();
  return {
    dsn: dsn || undefined,
    enabled: process.env.LOCAL801_SENTRY_ENABLED === "1" && Boolean(dsn),
    environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
    release: process.env.VERCEL_GIT_COMMIT_SHA,
    sendDefaultPii: false,
    tracesSampleRate: 0,
    maxBreadcrumbs: 0,
    beforeBreadcrumb: () => null,
    beforeSend: sanitizeLocal801SentryEvent,
  } as const;
}
