/**
 * THE one rule by which a Xero contact NAME is compared with anything
 * (`INV-SSOT`, `INV-INT-020`).
 *
 * It lives in a module of its own, with no imports, for one reason: the rule is
 * needed both by the Xero client code that SEARCHES for a contact by name and
 * by `school-organisations.ts`, which has to decide whether a school's own
 * history names the school a contact was matched for. Leaving it inside
 * `xero-contacts.ts` — which imports `xero-node` and, through
 * `xero-contact-home.ts`, the school module itself — would mean either an import
 * cycle or a second copy of the rule, and a second copy is exactly the defect
 * described below.
 *
 * ## A PROOF MAY NEVER BE STRICTER THAN THE MATCH THAT PRODUCED ITS CANDIDATE
 *
 * This normalisation is deliberately coarse: it folds case, decomposes
 * compatibility forms, strips diacritics, and turns every run of
 * non-alphanumeric characters into a single space. So Xero's exact-name search
 * treats `St. Peter's College`, `St Peter's College` and `ST  PETER'S COLLEGE` as
 * one name, and hands back the same contact for any of them.
 *
 * Anything that then has to PROVE that contact belongs where the search said it
 * did must use this same rule. A stricter comparison — whitespace and case only,
 * say — refuses the very rows the search accepted, and for a school population
 * full of apostrophes and full stops that is not an edge case: it is the common
 * one. This module exists so that the search and the proof cannot drift apart.
 */

/**
 * Fold a contact name (or any free text compared against one) to the value the
 * name search matches on.
 */
export function normalizeXeroContactMatchValue(
  value: string | null | undefined
): string {
  return (
    value
      ?.trim()
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim() ?? ""
  );
}
