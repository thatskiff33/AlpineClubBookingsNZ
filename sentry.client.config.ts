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

  // Scrub sensitive data from Sentry payloads
  beforeSend(event) {
    if (!process.env.NEXT_PUBLIC_SENTRY_DSN) return null;

    // Scrub sensitive data from request body (e.g. password fields in form submissions)
    if (event.request?.data) {
      const dataStr =
        typeof event.request.data === "string"
          ? event.request.data
          : JSON.stringify(event.request.data);
      const sensitiveFields = [
        "password",
        "passwordHash",
        "token",
        "accessToken",
        "refreshToken",
        "secret",
      ];
      let scrubbed = dataStr;
      for (const field of sensitiveFields) {
        const regex = new RegExp(`("${field}"\\s*:\\s*)"[^"]*"`, "gi");
        scrubbed = scrubbed.replace(regex, `$1"[REDACTED]"`);
      }
      event.request.data = scrubbed;
    }

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
