/**
 * Deterministic JSON, for anything that HASHES a structure.
 *
 * `JSON.stringify` is insertion-ordered, so two objects carrying the same fields
 * in a different order serialise differently and therefore hash differently.
 * Every derived-identity digest in this codebase depends on that not happening:
 * a booking-exception proposal hash (`booking-exception-requests.ts`) proves a
 * stored row was not tampered with, and an `EDIT_FINANCIAL_REVIEW` occurrence key
 * (`edit-financial-review.ts`, #3030) is what stops one unpriceable booking edit
 * raising two review tasks. In both cases a key that shifts with field order is
 * not an identity at all.
 *
 * `INV-SSOT`: this module exists because a SECOND caller needed the helper.
 * It was private to `booking-exception-requests.ts` until #3030; moving it here
 * rather than copying it is the rule ("if two places need it, move it to one
 * module and import it"), and it matters more than usual for a hash — two
 * copies that drift produce two different identities for the same object, and
 * nothing fails loudly when they do.
 */

/** Deterministic JSON with recursively sorted object keys. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      out[key] = sortKeysDeep(record[key]);
    }
    return out;
  }
  return value;
}
