/**
 * RENDER AN AUDIT ROW'S METADATA SO AN AMOUNT READS AS AN AMOUNT (#3533).
 *
 * Audit metadata stores money as integer cents and must keep doing so
 * (`INV-MONEY-003`; `INV-OPS-012` — a written row never moves). What was wrong
 * was the SCREEN: `/admin/audit-log` printed the metadata as raw JSON, so an
 * officer reconstructing a booking's money read `"refundAmountCents": 2275`
 * and converted it in their head, where a factor-of-a-hundred misread is easy.
 *
 * This is a DISPLAY TRANSFORM and nothing else. It takes the stored value,
 * leaves every number exactly as stored, and annotates each `…Cents` key with
 * what that number is in dollars — so the raw figure the repair and census
 * tooling reads is still on the screen, beside the amount a person reads.
 *
 * The suffix is this repository's own money convention (`INV-MONEY-001`), the
 * same one the lint arms key on: nothing stores a percentage in a `…Cents`
 * key. A key that carries something else — a count, an id — is not annotated
 * because it does not carry the suffix.
 */
import { formatCents } from "@/lib/utils";

/** A cents key holds a whole number of cents; anything else is left alone. */
function isWholeCents(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function keyIsCents(key: string): boolean {
  return /[Cc]ents$/.test(key);
}

/**
 * The metadata as JSON, with `"…Cents": <n>` lines annotated `// $n.nn`.
 *
 * Post-processing the stringified text rather than transforming the object is
 * deliberate: the JSON on the screen stays byte-identical to what is stored,
 * which is what makes the annotation obviously an annotation rather than a
 * value somebody might copy back into a repair script.
 */
export function formatAuditMetadataJson(metadata: unknown): string {
  const json = JSON.stringify(metadata, null, 2);
  if (json === undefined) return "";
  return json
    .split("\n")
    .map((line) => {
      const match = /^(\s*)"([^"]+)":\s(-?\d+)(,?)$/.exec(line);
      if (!match) return line;
      const [, indent = "", key = "", digits = "", comma = ""] = match;
      if (!keyIsCents(key)) return line;
      const value = Number(digits);
      if (!isWholeCents(value)) return line;
      return `${indent}"${key}": ${digits}${comma}  // ${formatCents(value)}`;
    })
    .join("\n");
}
