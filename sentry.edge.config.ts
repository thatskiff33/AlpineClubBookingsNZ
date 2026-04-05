import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.SENTRY_DSN || "",
  environment: process.env.NODE_ENV || "development",
  tracesSampleRate: process.env.NODE_ENV === "production" ? 0.2 : 1.0,

  beforeSend(event) {
    if (!process.env.SENTRY_DSN) return null;
    return event;
  },
});
