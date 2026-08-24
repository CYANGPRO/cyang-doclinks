import * as Sentry from "@sentry/nextjs";
import { getSentryRuntimeConfig, scrubSentryEvent } from "./lib/sentry-policy.ts";

const config = getSentryRuntimeConfig();

if (config.enabled) {
  Sentry.init({
    dsn: config.dsn,
    enabled: true,
    environment: "production",
    sendDefaultPii: false,
    maxBreadcrumbs: 0,
    tracesSampleRate: 0,
    attachStacktrace: true,
    beforeSend: scrubSentryEvent,
  });
}
