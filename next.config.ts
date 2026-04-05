import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

const nextConfig: NextConfig = {
  output: "standalone",
};

export default withSentryConfig(nextConfig, {
  // Suppresses source map uploading logs during build
  silent: true,

  // Only upload source maps if SENTRY_AUTH_TOKEN is set
  org: process.env.SENTRY_ORG || "",
  project: process.env.SENTRY_PROJECT || "",
});
