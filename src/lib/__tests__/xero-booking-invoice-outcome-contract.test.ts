import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { readXeroInvoiceOperationOutcome } from "@/lib/xero-booking-invoice-outcome";

/**
 * THE WRITER AND THE READER MUST NAME THE SAME KEYS (#3001, MAD epic #2725).
 *
 * `createXeroInvoiceForBooking` composes a booking-invoice operation's
 * completion payload, and `readXeroInvoiceOperationOutcome` reads it back for
 * two rules that both matter:
 *
 *  - the money fence in `xero-operation-retry.ts`, which decides whether an
 *    operator's "Retry" may record a payment against that invoice. If a key it
 *    reads stops being written, the fence stops refusing and a bank payment gets
 *    recorded against an invoice the member has not paid;
 *  - the officer-facing warning on the booking (#3001). If a key it reads stops
 *    being written, the warning goes QUIET and a failed invoice looks healthy.
 *
 * Both failure modes are SILENT. Nothing throws, no type breaks, and no existing
 * behavioural test notices, because both readers are asking about absence and
 * absence is what they would get. So this test reads the writer off disk and
 * asserts the key names are still the ones the reader looks for.
 *
 * Disk-scanning, so it has no import edge to the writer it inspects and
 * `npm run test:related` cannot select it. Like the other censuses in this
 * directory it is CI-caught by design; run it locally with `npm run test:named`.
 */

const WRITER = path.join(process.cwd(), "src/lib/xero-booking-invoices.ts");

/**
 * The six keys the reader depends on.
 *
 * Spelled out here rather than derived from the reader's own source, because a
 * test that derives both sides from the same place proves nothing: it would pass
 * against any rename applied consistently to the reader alone — which is exactly
 * the change that breaks it against the STORED rows already in the database.
 */
const REQUIRED_KEYS = [
  "paymentError",
  "paymentSkipped",
  "invoiceEmailError",
  "invoiceEmailWithheldByNoEmails",
  "invoiceEmailWithheldByCreationChoice",
  "invoiceEmailWithheldForEnvironment",
] as const;

describe("the booking-invoice completion payload contract", () => {
  const source = readFileSync(WRITER, "utf8");

  it.each(REQUIRED_KEYS)(
    "`%s` is still written by createXeroInvoiceForBooking",
    (key) => {
      // Matched as an object key at the start of a line, so a mention inside a
      // comment or a differently-named local cannot satisfy it.
      expect(source).toMatch(new RegExp(`^\\s*${key}(?::|,\\s*$)`, "m"));
    },
  );

  it("reads every written key back, so no reader silently sees a constant false", () => {
    const payload = Object.fromEntries(
      REQUIRED_KEYS.map((key) =>
        key.endsWith("Error") ? [key, { message: "boom" }] : [key, true],
      ),
    );

    expect(readXeroInvoiceOperationOutcome(payload)).toEqual({
      paymentFailed: true,
      paymentSkipped: true,
      invoiceEmailFailed: true,
      invoiceEmailWithheldByNoEmails: true,
      invoiceEmailWithheldByCreationChoice: true,
      invoiceEmailWithheldForEnvironment: true,
    });
  });

  it("reports a payload it was never given as absent, not as clean", () => {
    // The distinction the money fence is built on: "no outcome was recorded" is
    // a different answer from "recorded, and everything was fine".
    expect(readXeroInvoiceOperationOutcome(null)).toBeNull();
    expect(readXeroInvoiceOperationOutcome("not an object")).toBeNull();
    expect(readXeroInvoiceOperationOutcome([])).toBeNull();
  });

  it("keeps the three deliberate withholds apart from the one fault", () => {
    // #2258 / #2929 / #3035 are the club's own decisions, or no decision at all.
    // Only `invoiceEmailError` is a failure, and flattening them is how a
    // support call gets misdiagnosed.
    const withheldEveryDeliberateWay = readXeroInvoiceOperationOutcome({
      invoiceEmailWithheldByNoEmails: true,
      invoiceEmailWithheldByCreationChoice: true,
      invoiceEmailWithheldForEnvironment: true,
    });

    expect(withheldEveryDeliberateWay).toMatchObject({
      invoiceEmailFailed: false,
      invoiceEmailWithheldByNoEmails: true,
      invoiceEmailWithheldByCreationChoice: true,
      invoiceEmailWithheldForEnvironment: true,
    });
  });
});
