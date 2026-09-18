/*
 * Shared explicit-guard helper for the `noUncheckedIndexedAccess` migration
 * (programme #2694, stages #2799-#2802).
 *
 * Every call site that reaches for `must` is unwrapping a lookup its OWN
 * surrounding code already guarantees exists — an array position bounded by a
 * length check just above it, a fixed-size scale, a regex's mandatory capture
 * group, a map key populated by the same loop that later reads it. `must`
 * turns what would otherwise be a silent `undefined` flowing into later
 * arithmetic or a bare "Cannot read properties of undefined" into a
 * descriptive throw at the point the invariant is assumed, instead of
 * inventing a fallback value for a case the surrounding code never actually
 * reaches. One home so every module that needs this reasons about the same
 * helper (INV-SSOT) rather than near-identical copies drifting apart.
 */
export function must<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);
  return value;
}
