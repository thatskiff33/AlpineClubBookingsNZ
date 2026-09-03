import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { stripComments } from "@/lib/__tests__/support/strip-comments";
import {
  hasIssuedPrimaryXeroInvoice,
  isSettledBookingStatus,
} from "@/lib/booking-payment-state";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

/**
 * #3200 (epic #2797): "HAS THIS BOOKING'S MAIN XERO INVOICE ALREADY BEEN
 * RAISED?" IS ONE QUESTION WITH ONE ANSWER, AT EVERY EDIT DOOR.
 *
 * The answer decides whether an edit that increases the price is billed as a
 * supplementary invoice against an invoice the club has already sent, or is
 * treated as an edit to a booking that has never been invoiced at all. Get it
 * wrong in the second direction and the difference is simply never billed —
 * nothing fails, nothing is logged, and the shortfall lands on the club's
 * accounts rather than on the member.
 *
 * There are four doors into a booking edit, and until this issue they did not
 * all ask the same way:
 *
 *  - the batch edit      `PUT  /api/bookings/[id]/modify`
 *  - the date change     `PUT  /api/bookings/[id]/modify-dates`
 *  - the guest removal   `DELETE /api/bookings/[id]/guests/[guestId]`
 *  - the guest add       `POST /api/bookings/[id]/guests`
 *
 * The first three reach `hasIssuedPrimaryXeroInvoice` through
 * `applyPaymentAdjustments`. The fourth does its own settlement arithmetic and
 * re-stated the rule inline, with a status list copied from its own eligibility
 * gate — so it omitted `COMPLETED`, and a finished stay was answered "no
 * invoice" at that door and "invoice issued" at the other three.
 *
 * This suite pins both halves of the fix: the shared answer for `COMPLETED`,
 * and the structural fact that no door states the rule a second time.
 */

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

const read = (relative: string) => {
  const absolute = path.join(REPO_ROOT, relative);
  // Fail loudly on a moved file rather than passing over an empty string: a
  // census that cannot find its subject is a false green, not a pass.
  expect(fs.existsSync(absolute), `${relative} is missing`).toBe(true);
  return stripComments(fs.readFileSync(absolute, "utf8"));
};

/** The four edit doors, and the service each one settles through. */
const EDIT_DOORS = [
  {
    name: "batch edit (PUT /api/bookings/[id]/modify)",
    route: "src/app/api/bookings/[id]/modify/route.ts",
    settlesThrough: [
      "src/lib/booking-modify.ts",
      "src/lib/booking-batch-modification-service.ts",
    ],
  },
  {
    name: "date change (PUT /api/bookings/[id]/modify-dates)",
    route: "src/app/api/bookings/[id]/modify-dates/route.ts",
    settlesThrough: ["src/lib/booking-date-modification-service.ts"],
  },
  {
    name: "guest removal (DELETE /api/bookings/[id]/guests/[guestId])",
    route: "src/app/api/bookings/[id]/guests/[guestId]/route.ts",
    settlesThrough: ["src/lib/booking-guest-removal-service.ts"],
  },
  {
    name: "guest add (POST /api/bookings/[id]/guests)",
    route: "src/app/api/bookings/[id]/guests/route.ts",
    settlesThrough: [],
  },
] as const;

const GUEST_ADD_ROUTE = "src/app/api/bookings/[id]/guests/route.ts";
const SETTLEMENT_MODULE = "src/lib/booking-modify-settlement.ts";

describe("the one home answers COMPLETED", () => {
  const withInvoice = (status: string) => ({
    status,
    payment: { xeroInvoiceId: "INV-4021" },
  });

  it("says a COMPLETED booking's invoice HAS been raised", () => {
    // The exact case the guest-add door used to get wrong. A stay that has
    // finished has certainly been invoiced if it carries an invoice id.
    expect(hasIssuedPrimaryXeroInvoice(withInvoice("COMPLETED"))).toBe(true);
    expect(isSettledBookingStatus("COMPLETED")).toBe(true);
  });

  it("answers every settled status the same way", () => {
    for (const status of ["PAYMENT_PENDING", "CONFIRMED", "PAID", "COMPLETED"]) {
      expect(
        hasIssuedPrimaryXeroInvoice(withInvoice(status)),
        `${status} carries an invoice id`,
      ).toBe(true);
    }
  });

  it("still needs BOTH halves", () => {
    // A settled status with no invoice id, and an invoice id on a status whose
    // payment lifecycle was never entered, are both "no invoice raised".
    expect(
      hasIssuedPrimaryXeroInvoice({ status: "COMPLETED", payment: null }),
    ).toBe(false);
    expect(
      hasIssuedPrimaryXeroInvoice({
        status: "COMPLETED",
        payment: { xeroInvoiceId: null },
      }),
    ).toBe(false);
    expect(hasIssuedPrimaryXeroInvoice(withInvoice("PENDING"))).toBe(false);
    expect(hasIssuedPrimaryXeroInvoice(withInvoice("CANCELLED"))).toBe(false);
  });
});

describe("the settlement the first three doors share", () => {
  it("bills a price increase on a COMPLETED booking as a supplementary invoice", async () => {
    const { applyPaymentAdjustments } = await import(
      "@/lib/booking-modify-settlement"
    );

    const result = await applyPaymentAdjustments(
      // No write happens on this shape: the invoice is issued but unpaid, so
      // the captured-payment branch (the only one that touches `tx`) is not
      // entered and the change fee is zero.
      {} as never,
      {
        booking: {
          status: "COMPLETED",
          payment: {
            id: "pay-1",
            status: "PENDING",
            source: "INTERNET_BANKING",
            amountCents: 0,
            refundedAmountCents: 0,
            xeroInvoiceId: "INV-4021",
          },
        } as never,
        priceDiffCents: 12_500,
        changeFeeCents: 0,
      },
    );

    expect(result.hasIssuedXeroInvoice).toBe(true);
    // The whole point: the difference is billed. Before #3200 the guest-add
    // door answered `false` on this same booking and left 0 here.
    expect(result.xeroAdditionalAmountCents).toBe(12_500);
    expect(result.additionalAmountCents).toBe(12_500);
  });
});

describe("no edit door states the rule a second time", () => {
  for (const door of EDIT_DOORS) {
    for (const file of [door.route, ...door.settlesThrough]) {
      it(`${door.name} does not read Payment.xeroInvoiceId itself (${file})`, () => {
        expect(
          read(file),
          `${file} reads Payment.xeroInvoiceId directly. "Has the main invoice ` +
            `been raised?" has one home — hasIssuedPrimaryXeroInvoice in ` +
            `src/lib/booking-payment-state.ts (INV-SSOT-001). Ask it, or reach ` +
            `it through applyPaymentAdjustments; do not re-state its two ` +
            `predicates here. A copy written from a route's own status list is ` +
            `how #3200's COMPLETED divergence happened.`,
        ).not.toMatch(/\bxeroInvoiceId\b/);
      });
    }
  }

  it("the guest-add door reaches the one home directly", () => {
    const source = read(GUEST_ADD_ROUTE);
    expect(source).toMatch(
      /import\s*\{[^}]*\bhasIssuedPrimaryXeroInvoice\b[^}]*\}\s*from\s*"@\/lib\/booking-payment-state"/,
    );
    expect(source).toMatch(/hasIssuedPrimaryXeroInvoice\(booking\)/);
  });

  it("the other three doors reach it through applyPaymentAdjustments", () => {
    for (const door of EDIT_DOORS) {
      if (door.settlesThrough.length === 0) continue;
      const sources = door.settlesThrough.map(read).join("\n");
      expect(sources, `${door.name} no longer settles through applyPaymentAdjustments`).toMatch(
        /\bapplyPaymentAdjustments\b/,
      );
    }
    // And that function is itself a reader of the one home rather than a second
    // definition of it, which is what makes the line above meaningful.
    expect(read(SETTLEMENT_MODULE)).toMatch(
      /hasIssuedXeroInvoice\s*=\s*hasIssuedPrimaryXeroInvoice\(booking\)/,
    );
  });
});

describe("why the guest-add correction changes no behaviour today", () => {
  it("the guest-add door refuses a COMPLETED booking before it settles anything", () => {
    // #3200, and the reason this fix is safe rather than merely different: the
    // guest-add route's own eligibility gate admits no finished stay, so the
    // status the inline copy got wrong never reached it.
    //
    // IF YOU ARE WIDENING THAT GATE: this pin failing is the expected signal,
    // not a bug. The settlement below now answers COMPLETED as "invoice
    // issued", which is the correct answer — bill the difference as a
    // supplementary invoice. Update this test to say so.
    expect(read(GUEST_ADD_ROUTE)).toMatch(
      /!\["PENDING",\s*"PAYMENT_PENDING",\s*"CONFIRMED",\s*"PAID"\]\.includes\(booking\.status\)/,
    );
  });
});
