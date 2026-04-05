import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN || "",

  environment: process.env.NODE_ENV || "development",

  // OBS-10: Performance tracing for client
  tracesSampleRate: process.env.NODE_ENV === "production" ? 0.2 : 1.0,

  // Enable breadcrumbs for error context
  integrations: [
    Sentry.breadcrumbsIntegration({
      console: true,
      dom: true,
      fetch: true,
      history: true,
    }),
  ],

  // Don't send if no DSN configured
  beforeSend(event) {
    if (!process.env.NEXT_PUBLIC_SENTRY_DSN) return null;
    return event;
  },

  // Filter out noisy errors
  ignoreErrors: [
    "NEXT_NOT_FOUND",
    "NEXT_REDIRECT",
    "ResizeObserver loop",
    "Network request failed",
  ],
});
