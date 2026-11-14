/**
 * What counts as an email address inside a free-text value: the one rule the
 * log and record redactor (`redact-sensitive-json.ts`) and the provider-fixture
 * privacy gate both apply (INV-SSOT). Neither pattern is global, so `.test`
 * keeps no state between calls.
 */
export const EMAIL_ADDRESS_VALUE_PATTERNS: readonly RegExp[] = [
  // Email addresses. The local part and the domain exclude `/` and `\` so that
  // a filesystem path is not read as an address. Without that exclusion
  // `node_modules/@sentry/nextjs/dist/index.js` matched — "…/node_modules/"
  // before the @, "sentry/nextjs/dist/index.js" after it — so EVERY server
  // stack trace naming a scoped package was replaced wholesale with
  // "[REDACTED]". A log that reports `stack: "[REDACTED]"` has thrown away the
  // only thing it was written to carry. Real addresses still match: the domain
  // needs a dot before any slash, which a scoped package path never has.
  /[^\s@/\\]+@[^\s@/\\]+\.[^\s@/\\]+/,
  // The same address after URL encoding, which is how one arrives inside a
  // query string (`jane%40example.test`). The bare pattern above cannot see it,
  // so an email in a URL survived byte-identical into Sentry.
  /[^\s@/\\%]+%40[^\s@/\\%]+\.[^\s@/\\%]+/i,
];
