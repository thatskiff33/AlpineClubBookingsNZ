/**
 * The installed release's version (#4985). `next.config.ts` stamps the
 * `package.json` version into every bundle under this name at build time, so a
 * standalone `node server.js` needs no runtime variable. Every reader of "what
 * version is this" goes through `getAppVersion()`; a census test forbids the
 * old package-manager launcher variable under `src/`.
 */
export const APP_VERSION_ENV_VAR = "APP_VERSION";

/** The build's version, or "unknown" outside a Next build (dev tools, tests). */
export function getAppVersion(): string {
  // Keep a literal property read: Next substitutes it in every compiled bundle.
  return process.env.APP_VERSION?.trim() || "unknown";
}
