import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { stripComments } from "@/lib/__tests__/support/strip-comments";
import {
  hasIssuedPrimaryXeroInvoice,
  isSettledBookingStatus,
} from "@/lib/booking-payment-state";
// STATIC, not `await import(...)` inside the test (#3200 review). `vi.mock` is
// hoisted above every import, so the mocks below still apply; loading this
// module's graph lazily instead cost ~2.6s of the 5000ms `testTimeout` warm and
// failed at 5052ms cold, which is the profile of the two suites AGENTS.md
// records as timing out under parallel CI load.
import { applyPaymentAdjustments } from "@/lib/booking-modify-settlement";

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

/**
 * Every non-test source file under a tracked directory, by WALK rather than by
 * name (`INV-SSOT-004`: a population measured by name is not the population).
 * Naming the doors is what let the fourth one diverge; a fifth door added
 * tomorrow is in this list the moment its file exists.
 */
const sourceFilesUnder = (relativeRoot: string): string[] => {
  const root = path.join(REPO_ROOT, relativeRoot);
  expect(fs.existsSync(root), `${relativeRoot} is missing`).toBe(true);
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "__tests__") continue;
        walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) {
        continue;
      }
      found.push(path.relative(REPO_ROOT, full).split(path.sep).join("/"));
    }
  };
  walk(root);
  return found.sort();
};

/**
 * Files that mention `token` in CODE (comments stripped), cheaply: the raw text
 * is checked first because stripping a comment can only ever REMOVE a match,
 * never add one, so a raw miss is a certain miss.
 */
const filesMentioning = (files: string[], token: RegExp): string[] => {
  // Rebuilt without `g`: `.test()` on a global regex carries `lastIndex` from
  // the previous call and would skip files at random.
  const probe = new RegExp(token.source, token.flags.replace("g", ""));
  return files.filter((file) => {
    const raw = fs.readFileSync(path.join(REPO_ROOT, file), "utf8");
    return probe.test(raw) && probe.test(stripComments(raw));
  });
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
const BOOKINGS_API_TREE = "src/app/api/bookings";

const XERO_INVOICE_ID = /\bxeroInvoiceId\b/;

/**
 * The only files under the bookings API tree allowed to name
 * `Payment.xeroInvoiceId`, each with the reason it is not a second answer to
 * "has the main invoice been raised?". Adding a line here is a deliberate act
 * with a reason attached; that is the point of an allowlist over a name list.
 */
const XERO_INVOICE_ID_ALLOWED: Record<string, string> = {
  "src/app/api/bookings/[id]/change-requests/route.ts":
    "displays the invoice id back to the member in a change-request snapshot " +
    "(a select and an echo). It decides nothing about whether the invoice was " +
    "raised, so it is a display of the value, not a second derivation of it.",
};

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
  it("NO route under the bookings API reads Payment.xeroInvoiceId", () => {
    // Measured over the WHOLE tree, not over the four doors by name (#3200
    // review). Naming the population is the defect INV-SSOT-004 describes: a
    // fifth edit route added next month is not on a name list, and the copy it
    // writes is exactly the copy this issue removed.
    const tree = sourceFilesUnder(BOOKINGS_API_TREE);
    // The walk really does reach all four known doors — a renamed route that
    // dropped out of the census would otherwise pass it vacuously.
    expect(tree).toEqual(
      expect.arrayContaining(EDIT_DOORS.map((door) => door.route)),
    );
    const offenders = filesMentioning(
      tree.filter((file) => !(file in XERO_INVOICE_ID_ALLOWED)),
      XERO_INVOICE_ID,
    );
    expect(
      offenders,
      `These routes read Payment.xeroInvoiceId directly. "Has the main ` +
        `invoice been raised?" has one home — hasIssuedPrimaryXeroInvoice in ` +
        `src/lib/booking-payment-state.ts (INV-SSOT-001). Ask it, or reach it ` +
        `through applyPaymentAdjustments; do not re-state its two predicates. ` +
        `A copy written from a route's own status list is how #3200's ` +
        `COMPLETED divergence happened. If the route only DISPLAYS the id and ` +
        `decides nothing, add it to XERO_INVOICE_ID_ALLOWED with its reason.`,
    ).toEqual([]);
  });

  it("keeps the allowlist honest", () => {
    // An allowlist entry that no longer matches is a rule quietly relaxed. Both
    // directions are checked: the file still exists, and it still needs the
    // exemption it was given.
    const stale = Object.keys(XERO_INVOICE_ID_ALLOWED).filter(
      (file) => !XERO_INVOICE_ID.test(read(file)),
    );
    expect(
      stale,
      `These files are exempted from the Payment.xeroInvoiceId ban but no ` +
        `longer read it. Delete the entry rather than leaving a standing ` +
        `exemption nothing needs.`,
    ).toEqual([]);
  });

  for (const door of EDIT_DOORS) {
    for (const file of door.settlesThrough) {
      it(`${door.name} settles without reading Payment.xeroInvoiceId (${file})`, () => {
        // The settlement services sit in src/lib, outside the tree census
        // above, so they are checked by name — and the "every reacher is
        // pinned" test below is what keeps that name list complete. Checked
        // PER FILE, not over the concatenation: joining them let one file's
        // clean text answer for its sibling (#3200 review).
        expect(
          read(file),
          `${file} reads Payment.xeroInvoiceId directly; ask ` +
            `hasIssuedPrimaryXeroInvoice instead (INV-SSOT-001, #3200).`,
        ).not.toMatch(XERO_INVOICE_ID);
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

  it("the guest-add door states no booking-status list of its own", () => {
    // The nit the xeroInvoiceId ban does not cover: the route now asks
    // `isSettledBookingStatus`, and nothing above would fail if a later edit
    // pasted ["PAYMENT_PENDING","CONFIRMED","PAID"] back in beside it — the
    // same defect one predicate over. The ONE status literal this file may
    // carry is its eligibility gate, pinned below.
    const ELIGIBILITY_GATE = '["PENDING","PAYMENT_PENDING","CONFIRMED","PAID"]';
    const literals = (
      read(GUEST_ADD_ROUTE).match(/\[[^[\]]*"CONFIRMED"[^[\]]*\]/g) ?? []
    ).map((literal) => literal.replace(/\s+/g, ""));
    expect(
      literals.filter((literal) => literal !== ELIGIBILITY_GATE),
      `The guest-add route states a booking-status list of its own. Which ` +
        `statuses count as "the payment lifecycle has been entered" is ` +
        `isSettledBookingStatus in src/lib/booking-payment-state.ts ` +
        `(INV-SSOT-001) — call it. #3200's bug was exactly this: a list ` +
        `copied here from the eligibility gate, missing COMPLETED.`,
    ).toEqual([]);
  });

  it("every file that reaches applyPaymentAdjustments is one of the doors above", () => {
    // The other half of "measure, do not name": if a fifth settlement path
    // appears, it shows up HERE even though the ban above only covers routes.
    const pinned = [
      ...new Set(EDIT_DOORS.flatMap((door) => door.settlesThrough)),
    ].sort();
    const reachers = filesMentioning(
      sourceFilesUnder("src").filter((file) => file !== SETTLEMENT_MODULE),
      /\bapplyPaymentAdjustments\b/,
    );
    expect(
      reachers,
      `The set of files reaching applyPaymentAdjustments has changed. If a ` +
        `new edit path settles through it, add it to that door's ` +
        `settlesThrough so the Payment.xeroInvoiceId ban covers it too — do ` +
        `not simply widen this list (#3200).`,
    ).toEqual(pinned);

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
    expect(
      read(GUEST_ADD_ROUTE),
      `The guest-add route's eligibility gate is no longer the literal this ` +
        `pin expects. TWO different changes land you here, and the fix is ` +
        `NOT the same:\n` +
        `  (a) You WIDENED the gate to admit COMPLETED. Expected signal, not ` +
        `a bug. The settlement now answers COMPLETED as "invoice issued", ` +
        `which is the correct answer — bill the difference as a supplementary ` +
        `invoice. Update this test to say so.\n` +
        `  (b) You converged this list onto the edit-policy module — #3245 ` +
        `names this exact call site as one of three copies to route through ` +
        `canModifyBookingStatusForRole. You widened NOTHING. Re-express this ` +
        `pin against that derivation (assert the route calls it, and that the ` +
        `derivation itself excludes COMPLETED). DO NOT DELETE IT: it is the ` +
        `only guard keeping a finished stay out of this door's settlement.`,
    ).toMatch(
      /!\["PENDING",\s*"PAYMENT_PENDING",\s*"CONFIRMED",\s*"PAID"\]\.includes\(booking\.status\)/,
    );
  });
});
