/**
 * Escape a string for use as a literal inside a `RegExp` source. Import-free so
 * browser, edge and server bundles can all share it (INV-SSOT). Its scripts-side
 * counterpart, for `.mjs` tooling that cannot import from `src`, is `escapeRegex`
 * in `scripts/ci/escape-regex.mjs`; the two escape the same characters.
 */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
