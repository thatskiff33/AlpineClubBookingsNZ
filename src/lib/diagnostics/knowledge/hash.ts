/**
 * Deterministic hashing + canonical JSON for the knowledge bundle (AID-3).
 *
 * DETERMINISM is a security property here, not a nicety: the bundle's integrity
 * digest, every content/excerpt hash, and citation verification all depend on
 * the SAME bytes being produced from the same input on every machine. Two things
 * make that true regardless of OS or object-construction order:
 *  - `normalizeContent` collapses CRLF/CR to LF and strips a leading BOM, so a
 *    Windows checkout and a Linux CI runner hash the same file identically.
 *  - `canonicalStringify` sorts object keys recursively and pins indentation, so
 *    object key order can never shift the bytes.
 */

import { sha256Hex, sortKeysDeep } from "@/lib/stable-digest";

/**
 * `INV-SSOT` (#3030, #3218): the recursive key sorter and the sha256-hex of a
 * string both live in `@/lib/stable-digest`, which is the one home shared with
 * the two derived-identity hashers (`booking-exception-requests.ts` and
 * `edit-financial-review-occurrence.ts`). They were duplicated here until #3030,
 * and that one home was itself two modules until #3218. Only the two things that
 * are genuinely specific to the knowledge bundle stay in this file: BOM/CRLF
 * normalization, and `canonicalStringify`'s pinned indentation.
 * `sha256Hex` is re-exported so every existing importer of this module keeps
 * working and there is still only one definition.
 */
export { sha256Hex };

/**
 * Normalize file/excerpt text before hashing or excerpting: LF-only newlines,
 * no leading UTF-8 BOM. Never trims content — line numbers must stay faithful.
 */
export function normalizeContent(raw: string): string {
  const withoutBom = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  return withoutBom.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/**
 * Canonical JSON: recursively key-sorted, 2-space indented, LF newlines, with a
 * single trailing newline. `serializeBundle` uses this so the ON-DISK bundle is
 * byte-identical for identical inputs; array ORDER is preserved (callers sort
 * arrays explicitly where order carries meaning).
 */
export function canonicalStringify(value: unknown): string {
  return `${JSON.stringify(sortKeysDeep(value), null, 2)}\n`;
}
