import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";
import { ASSET_NOT_FOUND_REWRITES } from "./src/lib/asset-url-404";

const nextConfig: NextConfig = {
  images: {
    deviceSizes: [640, 750, 828, 1080, 1200, 1536, 1920, 2048, 3840],
  },
  output: "standalone",
  poweredByHeader: false,
  turbopack: {
    root: process.cwd(),
  },
  /**
   * Static-asset URLs nothing serves are answered with an empty 404 instead of
   * the club's full "page not found" document (#2404). The rules, and why the
   * `/api` namespace is deliberately excluded from them, are documented in
   * `src/lib/asset-url-404.ts`.
   *
   * `afterFiles` is the only stage that works here: Next checks `public/`,
   * `_next/static` and the non-dynamic routes BEFORE it consults these rules, so
   * a real asset is served exactly as before and never reaches them, while a
   * miss is terminated before the dynamic `(website)/[...slug]` catch-all can
   * turn it into a page render. `beforeFiles` would shadow every real asset;
   * `fallback` runs after the catch-all has already claimed the URL.
   *
   * Relative import, not the `@/` alias: this file is loaded by Next's own
   * config loader, which does not apply the tsconfig path mapping.
   */
  async rewrites() {
    return {
      beforeFiles: [],
      afterFiles: [...ASSET_NOT_FOUND_REWRITES],
      fallback: [],
    };
  },
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
