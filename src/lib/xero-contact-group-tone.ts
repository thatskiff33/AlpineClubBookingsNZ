import type { CategoricalScale } from "@/lib/chip-tones";

// A NON-EMPTY tuple type, so `XERO_GROUP_TONES[0]` is a tone rather than a
// maybe-tone: the modulo below then has a proven member of this very list to
// fall back on, instead of a colour invented at the call site (#2800).
const XERO_GROUP_TONES: readonly [CategoricalScale, ...CategoricalScale[]] = [
  "cat1",
  "cat2",
  "cat3",
  "cat4",
  "cat5",
  "cat6",
];

/**
 * Return one of the six categorical tones for a Xero contact group.
 *
 * A deterministic FNV-1a hash of the stable Xero group id supplies the modulo
 * seed. Catalog availability, filtering, and row order never participate, so
 * Members and Subscriptions cannot assign different tones while their cached
 * catalog-loading policies differ. Hash collisions are expected
 * presentation-only collisions; the visible group name remains authoritative.
 */
export function getXeroContactGroupTone(groupId: string): CategoricalScale {
  let hash = 0x811c9dc5;
  for (let index = 0; index < groupId.length; index += 1) {
    hash ^= groupId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  // The modulo is by this list's own length, so the position is always inside
  // it; `[0]` is the same list's first tone and is proven present by the type.
  return (
    XERO_GROUP_TONES[(hash >>> 0) % XERO_GROUP_TONES.length] ??
    XERO_GROUP_TONES[0]
  );
}
