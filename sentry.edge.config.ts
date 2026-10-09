import * as Sentry from "@sentry/nextjs";
import {
  redactSensitiveJson,
  redactSensitiveQueryParams,
  redactSensitiveText,
} from "@/lib/redact-sensitive-json";
import { SENTRY_PRIVACY_INIT_OPTIONS } from "@/lib/sentry-privacy-options";

Sentry.init({
  // Sentry 11's dataCollection defaults collect IPs, cookies and bodies; keep v10's.
  ...SENTRY_PRIVACY_INIT_OPTIONS,
  dsn: process.env.SENTRY_DSN || "",
  environment: process.env.NODE_ENV || "development",
  tracesSampleRate: process.env.NODE_ENV === "production" ? 0.2 : 1.0,

  // Scrub sensitive data from Sentry payloads
  beforeSend(event) {
    if (!process.env.SENTRY_DSN) return null; // Don't send if no DSN configured

    if (event.message) {
      event.message = redactSensitiveText(event.message);
    }

    if (event.request?.url) {
      event.request.url = redactSensitiveText(event.request.url);
    }

    if (event.request?.query_string) {
      event.request.query_string = redactSensitiveQueryParams(
        event.request.query_string
      ) as typeof event.request.query_string;
    }

    if (event.request?.headers) {
      event.request.headers = redactSensitiveJson(
        event.request.headers
      ) as typeof event.request.headers;
    }

    if (event.request?.data) {
      event.request.data = redactSensitiveJson(event.request.data);
    }

    if (event.extra) {
      event.extra = redactSensitiveJson(event.extra) as typeof event.extra;
    }

    if (event.breadcrumbs) {
      event.breadcrumbs = redactSensitiveJson(
        event.breadcrumbs
      ) as typeof event.breadcrumbs;
    }

    if (event.exception?.values) {
      event.exception.values = redactSensitiveJson(
        event.exception.values
      ) as typeof event.exception.values;
    }

    return event;
  },

  beforeBreadcrumb(breadcrumb) {
    return redactSensitiveJson(breadcrumb) as typeof breadcrumb;
  },

  // Filter out noisy errors. `ignoreErrors` string patterns are SUBSTRING
  // matches against the event message, so these match the digest Next puts in
  // the thrown Error's message. `notFound()` throws
  // `NEXT_HTTP_ERROR_FALLBACK;404` (`HTTP_ERROR_FALLBACK_ERROR_CODE` in
  // `next/dist/client/components/http-access-fallback/http-access-fallback`),
  // NOT the pre-15 `NEXT_NOT_FOUND`; the prefix alone also covers `forbidden()`
  // /`unauthorized()` (`;403`/`;401`).
  ignoreErrors: [
    "NEXT_HTTP_ERROR_FALLBACK",
    "NEXT_REDIRECT",
  ],
});
