import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.SENTRY_DSN || "",

  environment: process.env.NODE_ENV || "development",
  release: process.env.npm_package_version || "0.1.0",

  // OBS-10: Performance tracing
  tracesSampleRate: process.env.NODE_ENV === "production" ? 0.2 : 1.0,

  // Scrub sensitive data from Sentry payloads
  beforeSend(event) {
    if (!process.env.SENTRY_DSN) return null; // Don't send if no DSN configured

    // Scrub sensitive headers
    if (event.request?.headers) {
      const sensitiveHeaders = [
        "authorization",
        "cookie",
        "stripe-signature",
        "x-xero-signature",
      ];
      for (const header of sensitiveHeaders) {
        if (event.request.headers[header]) {
          event.request.headers[header] = "[REDACTED]";
        }
      }
    }

    // Scrub sensitive data from request body
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
        "stripeSecretKey",
        "secret",
      ];
      let scrubbed = dataStr;
      for (const field of sensitiveFields) {
        const regex = new RegExp(
          `("${field}"\\s*:\\s*)"[^"]*"`,
          "gi"
        );
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
  ],
});
