/**
 * Escape a string for use as a literal inside a `RegExp` source. Import-free so
 * browser, edge and server bundles can all share it (INV-SSOT).
 */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
