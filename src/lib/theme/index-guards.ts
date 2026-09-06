/*
 * Shared explicit-guard helper for the `noUncheckedIndexedAccess` migration
 * (#2800, programme #2694) across the theme/* modules.
 *
 * Every lookup these modules make through `must` is one their OWN
 * construction already guarantees exists — a fixed 12-step scale, a named
 * Radix export, a de-duplicated candidate list known to hold at least two
 * entries. `must` turns a would-be silent `undefined` (a NaN hex, or a bare
 * "Cannot read properties of undefined") into a descriptive throw instead,
 * without inventing a fallback value for a case these modules never actually
 * reach. One home so every theme/* file that needs this reasons about the
 * same helper (INV-SSOT) rather than five near-identical copies drifting.
 */
export function must<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);
  return value;
}
