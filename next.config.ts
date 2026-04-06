import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

const nextConfig: NextConfig = {
  output: "standalone",
};

// Warn at build time if Sentry is partially configured
if (process.env.SENTRY_DSN && !process.env.SENTRY_AUTH_TOKEN) {
  console.warn(
    "\x1b[33m⚠ SENTRY_DSN is set but SENTRY_AUTH_TOKEN is missing — source maps will not be uploaded. Production stack traces will be unreadable.\x1b[0m"
  );
}

export default withSentryConfig(nextConfig, {
  silent: true,
  org: process.env.SENTRY_ORG || "",
  project: process.env.SENTRY_PROJECT || "",
});
