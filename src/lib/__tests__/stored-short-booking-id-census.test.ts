import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { moduleImports } from "./support/static-import-graph";
import { stripComments } from "./support/strip-comments";
import { CENSUS_TIMEOUT_MS } from "@/test/census-timeout";

/**
 * #5407 item 36 (`INV-SSOT-001`, `INV-SSOT-002`): the short form of a booking id
 * that is written into Xero, the credit ledger and bank references is defined
 * once, by `storedShortBookingId` in `src/lib/booking-reference.ts`. About forty
 * places used to slice the id themselves. The strings are persisted and some
 * are matched later, so a writer and its reader drifting apart would leave
 * earlier records unmatched with no error anywhere.
 *
 * ## What it matches
 *
 * Every `.slice(0, 8)`, `.substring(0, 8)`, `.substr(0, 8)` and `.slice(-8)`,
 * and the same calls with `SHORT_BOOKING_ID_LENGTH` for the 8, in production
 * code under `src/`, `scripts/` and `prisma/`, keyed by `file :: receiver`. It
 * does not try to tell a booking id from any other id: it reports every match
 * (`INV-SSOT-004`: the broader instrument), and the list below names each one
 * that is reviewed. A new one anywhere, even a second one with a listed
 * receiver in a listed file, fails until it is reviewed here.
 *
 * A second leg reads the same files for SQL: no `left(<expression>, 8)`
 * anywhere. The AI Diagnostics packs build their booking reference with
 * `pg_catalog.left(<id>, ${SHORT_BOOKING_ID_LENGTH})`, so the length reaches
 * the SQL from the one constant as an integer, never as typed text.
 *
 * ## Why a census and not a type
 *
 * A branded `BookingId` type whose only short form is the helper was
 * considered and rejected (`INV-SSOT-001` prefers a structural remedy). Ids
 * reach this code as plain strings from Prisma rows, route parameters, JSON
 * payloads and fixtures, so the brand would have to be applied far beyond
 * these sites, and a plain `string` would still slice: the type would not stop
 * the drift this census exists to catch.
 *
 * ## It strips comments, not strings
 *
 * Docblocks describe the short form, so raw text would fire on them; the
 * tree's one stripper removes them. Strings stay, because most of these sites
 * sit inside a template literal's `${...}` and the SQL sits inside one.
 *
 * ## READS THE TREE FROM DISK
 *
 * `pnpm run test:related` cannot select it. Run it with `pnpm run test:named`.
 *
 * ## What it does not see
 *
 * - A short form spelled another way: a regular expression, a loop, a length
 *   held in some other variable, a swapped `id.substring(8, 0)` (which
 *   `substring` reorders to the same result), or a borrowed call such as
 *   `String.prototype.slice.call(id, 0, 8)`.
 * - Raw SQL spelled other than `left(..., 8)`: `substr(id, 1, 8)`,
 *   `substring(id from 1 for 8)` or a `LIKE` on a prefix.
 * - Anything under `e2e/` or in tests, which assert the stored text literally
 *   on purpose: an independent pin, not a second writer.
  */

const REPO_ROOT = path.resolve(__dirname, "../../..");
const HOME = "src/lib/booking-reference.ts";

/**
 * Every reviewed match, as `file :: receiver`. One entry per occurrence.
 */
const REVIEWED_SHORT_FORMS: string[] = [
  // The home: `storedShortBookingId`, which `formatBookingReference` and the
  // bank reference builders derive from.
  `${HOME} :: bookingId`,

  // NOT A BOOKING ID. Each is a different record's id, with its own meaning.
  // A member's id, in the placeholder address an anonymised member keeps.
  "src/app/api/admin/deletion-requests/[id]/route.ts :: member.id",
  // A membership cancellation participant's id, in its Xero reference.
  "src/lib/membership-cancellation-xero.ts :: params.participantId",
  // A member's id, in a warning.
  "src/lib/nomination.ts :: memberId",
  // A member credit's id, in its Xero credit-note reference.
  "src/lib/xero-admin-grant-credit-note.ts :: credit.id",
  // A Xero sync operation's id.
  "src/lib/xero-admin-failures.ts :: representativeOperationId",
  // An operation's local record: a Payment in the first, a Booking OR a
  // BookingModification in the second, so not always a booking id.
  "src/lib/xero-operation-retry.ts :: operation.localId",
  "src/lib/xero-operation-retry.ts :: operation.localId",
  // A booking change's id and a payment's id, in Xero refund documents.
  "src/lib/xero-refund-method.ts :: params.modificationId",
  "src/lib/xero-refund-method.ts :: params.paymentId",
  // Xero invoice ids, shown when Xero gave no invoice number.
  "src/app/(authenticated)/bookings/[id]/_components/booking-payment-cards.tsx :: internetBankingPayment.xeroInvoiceId",
  "src/app/(admin)/admin/finance/payments/page.tsx :: p.xeroInvoiceId",
  "src/app/(admin)/admin/finance/subscriptions/page.tsx :: sub.xeroInvoiceId",
  // A membership cancellation request's id.
  "src/app/(admin)/admin/membership/membership-cancellations/page.tsx :: request.id",
];

const SHORT_FORM =
  /\.\s*(?:slice|substring|substr)\(\s*(?:0\s*,\s*(?:8|SHORT_BOOKING_ID_LENGTH)|-\s*(?:8|SHORT_BOOKING_ID_LENGTH))\s*\)/g;
/** A SQL `left(<expression>, 8)`, in any case. */
const SQL_LEFT_EIGHT = /\bleft\(\s*[^,()]+,\s*8\s*\)/gi;
const RECEIVER = /([A-Za-z_$][\w$]*(?:\s*\??\.\s*[A-Za-z_$][\w$]*)*)\s*$/;

/**
 * `receiver` for each short form in already comment-stripped code. A receiver
 * that is not a plain name or property chain (a call, an index, a non-null
 * assertion, a parenthesised expression) is reported as `<expression>` and
 * can never match a reviewed entry.
 */
function shortFormReceivers(code: string): string[] {
  return [...code.matchAll(SHORT_FORM)].map((match) => {
    const before = code.slice(Math.max(0, match.index - 160), match.index);
    const chain = RECEIVER.exec(before);
    if (!chain) return "<expression>";
    const charBefore = before.slice(0, chain.index).trimEnd().slice(-1);
    if (charBefore && /[.)\]!?]/.test(charBefore)) return "<expression>";
    return chain[1].replace(/\s+/g, "");
  });
}

function productionFiles(): string[] {
  return execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "src", "scripts", "prisma"],
    { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  )
    .split("\n")
    .map((line) => line.trim())
    .filter((file) => /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(file))
    .filter((file) => !/\.d\.(ts|mts|cts)$/.test(file))
    .filter((file) => !/(^|\/)__tests__\//.test(file) && !/\.(test|spec)\./.test(file))
    .filter((file) => !file.startsWith("src/test/"))
    .filter((file) => existsSync(path.join(REPO_ROOT, file)));
}

describe("stored short booking id census (#5407 item 36)", { timeout: CENSUS_TIMEOUT_MS }, () => {
  const files = productionFiles();

  it("reads the production tree", () => {
    expect(files.length).toBeGreaterThan(500);
    expect(files).toContain(HOME);
    expect(files.some((file) => file.startsWith("scripts/"))).toBe(true);
    expect(files.some((file) => file.startsWith("prisma/"))).toBe(true);
  });

  it("finds a short form only at the reviewed sites", () => {
    const found = files.flatMap((file) =>
      shortFormReceivers(stripComments(readFileSync(path.join(REPO_ROOT, file), "utf8"))).map(
        (receiver) => `${file} :: ${receiver}`,
      ),
    );
    expect(
      found.sort(),
      "a booking id's short form is storedShortBookingId (stored or matched text) or formatBookingReference (display), both in src/lib/booking-reference.ts; any other id's short form is reviewed in this list",
    ).toEqual([...REVIEWED_SHORT_FORMS].sort());
  });

  it("finds no SQL left(<expression>, 8) anywhere", () => {
    const offenders = files.flatMap((file) =>
      [...stripComments(readFileSync(path.join(REPO_ROOT, file), "utf8")).matchAll(SQL_LEFT_EIGHT)].map(
        (match) => `${file} :: ${match[0]}`,
      ),
    );
    expect(offenders, "build a SQL short id with left(<id>, ${SHORT_BOOKING_ID_LENGTH}) from booking-reference.ts").toEqual([]);
  });

  it("keeps the home import-free, so browser code and leaf modules can import it", () => {
    const code = stripComments(readFileSync(path.join(REPO_ROOT, HOME), "utf8"));
    expect(moduleImports(HOME, code)).toEqual([]);
  });

  describe("the matcher", () => {
    it.each([
      ["bookingId.slice(0, 8)", ["bookingId"]],
      ["`Booking ${input.bookingId.slice(0,8)}`", ["input.bookingId"]],
      ["a.b?.c.substring( 0 , 8 )", ["a.b?.c"]],
      ["id.substr(0, 8)", ["id"]],
      ["id.slice(-8).toUpperCase()", ["id"]],
      ["record\n  .id\n  .slice(0, 8)", ["record.id"]],
      ["getId().slice(0, 8)", ["<expression>"]],
      ["rows[0].id.slice(0, 8)", ["<expression>"]],
      ["booking!.id.slice(0, 8)", ["<expression>"]],
      ["(a ?? b).slice(0, 8)", ["<expression>"]],
      ["bookingId.slice(0, SHORT_BOOKING_ID_LENGTH)", ["bookingId"]],
    ])("reports %j as %j", (code, expected) => {
      expect(shortFormReceivers(code)).toEqual(expected);
    });

    it.each([
      "id.slice(0, 12)",
      "id.slice(0, 80)",
      "id.slice(8)",
      "id.slice(-80)",
      "date.slice(0, 10)",
    ])("ignores %j", (code) => {
      expect(shortFormReceivers(code)).toEqual([]);
    });

    it.each([
      ['pg_catalog.left(b."id", 8)', 1],
      ["LEFT(p.\"bookingId\",8)", 1],
      ['pg_catalog.left(b."id", ${SHORT_BOOKING_ID_LENGTH})', 0],
      ['pg_catalog.left(b."id", 12)', 0],
    ])("counts SQL left-eight in %j as %i", (code, expected) => {
      expect([...code.matchAll(SQL_LEFT_EIGHT)]).toHaveLength(expected);
    });

    it("ignores a short form named only in a comment once comments are stripped", () => {
      expect(shortFormReceivers(stripComments("// was bookingId.slice(0, 8)\nconst x = 1;"))).toEqual([]);
    });
  });
});
