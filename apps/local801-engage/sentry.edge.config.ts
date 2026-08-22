import * as Sentry from "@sentry/nextjs";
import { local801SentryOptions } from "./src/lib/sentry-privacy";

Sentry.init(local801SentryOptions());
