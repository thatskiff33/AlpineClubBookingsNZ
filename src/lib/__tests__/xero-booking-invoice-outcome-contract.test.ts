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
 * The seven keys the reader depends on.
 *
 * Spelled out here rather than derived from the reader's own source, because a
 * test that derives both sides from the same place proves nothing: it would pass
 * against any rename applied consistently to the reader alone — which is exactly
 * the change that breaks it against the STORED rows already in the database.
 *
 * NOT ALL SEVEN HAVE A PRODUCTION READER TODAY, and saying otherwise would make
 * this file's own rationale false. `invoiceEmailWithheldForEnvironment` is
 * written by three workflows and read by no rule — the environment suppression
 * needs no remedy, so no surface acts on it. It is pinned anyway, for the reason
 * this module exists: the payload's shape has ONE home, and a reader that
 * quietly dropped the key would be the way the third withhold reason gets folded
 * back into the other two. The other six are each read by the money fence in
 * `xero-operation-retry.ts`, the booking warning in
 * `booking-invoice-sync-status.ts`, or both.
 */
const REQUIRED_KEYS = [
  "paymentError",
  "paymentSkipped",
  "invoiceEmailError",
  "invoiceEmailFailureCause",
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
      REQUIRED_KEYS.map((key) => {
        if (key.endsWith("Error")) return [key, { message: "boom" }];
        if (key === "invoiceEmailFailureCause") return [key, "PROVIDER"];
        return [key, true];
      }),
    );

    expect(readXeroInvoiceOperationOutcome(payload)).toEqual({
      paymentFailed: true,
      paymentSkipped: true,
      invoiceEmailFailed: true,
      invoiceEmailFailureCause: "PROVIDER",
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

  it("reads a cause it does not recognise as unknown rather than passing it on", () => {
    /*
      #3001. The cause decides which remedy an officer is given, and one of the
      three — an unreadable "No emails" switch — must NOT be answered with "send
      it from Xero yourself". A stored value from outside the enum is a row this
      code does not understand, so it reads back as `null` and the surface says
      only what it knows. Rows written before #3001 carry nothing at all and land
      in the same place.
    */
    expect(
      readXeroInvoiceOperationOutcome({
        invoiceEmailError: { message: "stopped" },
        invoiceEmailFailureCause: "SOMETHING_ELSE",
      }),
    ).toMatchObject({ invoiceEmailFailed: true, invoiceEmailFailureCause: null });

    expect(
      readXeroInvoiceOperationOutcome({
        invoiceEmailError: { message: "stopped" },
      }),
    ).toMatchObject({ invoiceEmailFailed: true, invoiceEmailFailureCause: null });
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
