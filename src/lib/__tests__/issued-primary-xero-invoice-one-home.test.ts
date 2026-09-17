import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { stripComments } from "@/lib/__tests__/support/strip-comments";
import { canModifyBookingInActiveLifecycle } from "@/lib/booking-edit-policy";
import {
  hasCapturedPayment,
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
 * #3244: a READ of an AGGREGATE `Payment.status` that decides something.
 *
 * ANCHORED ON THE RECEIVER, and that anchor is the whole difficulty. An earlier
 * draft matched any `status === "SUCCEEDED"`, which fired on a
 * `paymentTransaction.status` read in a route under this tree — a DIFFERENT
 * question. `booking-payment-state.ts` says in terms that the aggregate list and
 * `isCapturedTransactionStatus` must not be merged, and a census that cannot
 * tell them apart pushes whoever trips it toward exactly that merge. It did:
 * the first round of this PR converged that route onto the wrong home, and
 * review caught it. A guard that mis-identifies its subject is worse than no
 * guard, because it hands out a confident wrong instruction.
 *
 * So this matches `payment.status` / `payment?.status` / `booking.payment.status`
 * and the `PaymentStatus.X` spelling of the same, and deliberately does NOT
 * match a bare `status ===` on an unknown receiver. The transaction-side copies
 * are real and are filed as #3503; they are simply not this census's subject.
 *
 * WHAT IT CANNOT SEE, stated rather than implied (`INV-SSOT-004`): a loose
 * `==`, a status copied into a local first (`const s = payment.status`), and a
 * membership test against a list the caller builds itself
 * (`MY_STATUSES.includes(payment.status)`). None exists in the tree today —
 * measured, not assumed — and the failure message says so, because a guard that
 * claims more than it catches is the defect it exists to prevent.
 */
const PAYMENT_STATUS_READ =
  /\bpayment(?:\?)?\.status\s*(?:===|!==)\s*(?:"(?:SUCCEEDED|PARTIALLY_REFUNDED|REFUNDED)"|PaymentStatus\.(?:SUCCEEDED|PARTIALLY_REFUNDED|REFUNDED))/i;

/**
 * Routes allowed to compare `Payment.status`, each with the reason it is not a
 * second answer to "has money already moved through this card?".
 *
 * THE STRUCTURAL OPTION THAT WAS REJECTED, which `INV-SSOT-001` requires to be
 * named rather than left implied: making the column unreadable outside the
 * payment-state module — a branded status type, or a row type that omits
 * `status` at every query site. `hasIssuedPrimaryXeroInvoice` gets that for
 * free because it takes `xeroInvoiceId` as a REQUIRED parameter, so a caller
 * who has not loaded it fails to compile. `Payment.status` has no such lever:
 * it is a plain Prisma enum column that legitimate readers below genuinely
 * need, and branding it would touch every payment query in the tree. There is
 * no compile-time remedy available here, which is why this is a census.
 */
const PAYMENT_STATUS_ALLOWED: Record<string, string> = {
  "src/app/api/bookings/[id]/confirm-payment/route.ts":
    "asks two different questions. `payment.status === \"SUCCEEDED\" && " +
    "booking.status === \"PAID\"` is an IDEMPOTENCY short-circuit — this " +
    "confirmation already landed, so just re-queue the invoice — not 'has " +
    "money moved'. `refundedHistory` asks whether a refund has HAPPENED, " +
    "which is the opposite reading of the same column: `hasCapturedPayment` " +
    "answers true for a refunded payment, so calling it here would inv" +
    "ert the meaning.",
  "src/app/api/bookings/[id]/refund-request/route.ts":
    "asks 'has this booking already been refunded IN FULL?', to refuse a " +
    "second appeal. `hasCapturedPayment` answers true for a fully refunded " +
    "payment, so it is not the predicate this door wants.",
};

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
    // same defect one predicate over.
    //
    // #3245 removed the one exception this pin used to carry. The route's
    // eligibility gate WAS a status literal, allowed here because it was the
    // rule's own statement of itself at that door; it is now derived from
    // `canModifyBookingInActiveLifecycle`, so this file may hold NO status
    // list at all and the allowance is gone rather than merely unused.
    const literals = (
      read(GUEST_ADD_ROUTE).match(/\[[^[\]]*"CONFIRMED"[^[\]]*\]/g) ?? []
    ).map((literal) => literal.replace(/\s+/g, ""));
    expect(
      literals,
      `The guest-add route states a booking-status list of its own. Which ` +
        `statuses count as "the payment lifecycle has been entered" is ` +
        `isSettledBookingStatus in src/lib/booking-payment-state.ts, and which ` +
        `statuses are editable at all is canModifyBookingInActiveLifecycle in ` +
        `src/lib/booking-edit-policy.ts (INV-SSOT-001) — call them. #3200's ` +
        `bug was exactly this: a list copied here from the eligibility gate, ` +
        `missing COMPLETED. #3245 then removed the gate's own copy.`,
    ).toEqual([]);
  });

  it("the one home answers a part-refunded card as PAID, at every door", () => {
    // #3244's whole substance in one place. `hasCapturedPayment` is what the
    // other three doors reach through `applyPaymentAdjustments`, and it admits
    // the two refunded shapes because the money DID move through that card and
    // it is still the right instrument to collect from.
    const partRefunded = {
      status: "PARTIALLY_REFUNDED",
      amountCents: 10_000,
      refundedAmountCents: 2_500,
    };
    expect(hasCapturedPayment(partRefunded)).toBe(true);
    expect(hasCapturedPayment({ status: "REFUNDED", amountCents: 10_000 })).toBe(
      true,
    );
    expect(hasCapturedPayment({ status: "SUCCEEDED", amountCents: 10_000 })).toBe(
      true,
    );
    // And the guest-add door's own composite is the same shape the settlement
    // module applies: settled booking status AND a captured card.
    expect(
      isSettledBookingStatus("CONFIRMED") && hasCapturedPayment(partRefunded),
    ).toBe(true);
    // The narrowing half: a zero-amount capture is not a card to collect from.
    expect(hasCapturedPayment({ status: "SUCCEEDED", amountCents: 0 })).toBe(
      false,
    );
  });

  it("NO route under the bookings API reads Payment.status directly", () => {
    // #3244 extends #3200's ban to the SECOND field read at this door, which is
    // the acceptance criterion that issue carries. "Has money already moved
    // through this card?" is `hasCapturedPayment` in
    // `src/lib/booking-payment-state.ts`, and the guest-add door used to answer
    // it with `booking.payment?.status === "SUCCEEDED"` — the same shape as the
    // invoice defect #3200 fixed, one field over, and unlike that one it was
    // REACHABLE: a partly-refunded booking was answered "never paid" here and
    // "paid" at the other three doors, so the club collected nothing.
    //
    // Measured over the whole tree, not over the four doors by name
    // (`INV-SSOT-004`).
    const tree = sourceFilesUnder(BOOKINGS_API_TREE);
    expect(tree).toEqual(
      expect.arrayContaining(EDIT_DOORS.map((door) => door.route)),
    );
    const offenders = filesMentioning(
      tree.filter((file) => !(file in PAYMENT_STATUS_ALLOWED)),
      PAYMENT_STATUS_READ,
    );
    expect(
      offenders,
      `These routes decide something from Payment.status directly. "Has ` +
        `money already moved through this card?" has one home — ` +
        `hasCapturedPayment in src/lib/booking-payment-state.ts ` +
        `(INV-SSOT-001), which admits SUCCEEDED, PARTIALLY_REFUNDED and ` +
        `REFUNDED and requires a non-zero amount. Ask it. #3244's bug was ` +
        `exactly this read: a partly-refunded booking collected nothing at ` +
        `this door and the difference at the other three. If the route only ` +
        `DISPLAYS the status or writes it, add it to PAYMENT_STATUS_ALLOWED ` +
        `with its reason.\n` +
        `NOTE this ban matches a COMPARISON only. A loose \`==\`, a status ` +
        `copied into a local first, or a membership test against a list you ` +
        `built yourself are NOT caught. Passing it is not proof there is no ` +
        `second answer.`,
    ).toEqual([]);
  });

  it("keeps the Payment.status allowlist honest", () => {
    const stale = Object.keys(PAYMENT_STATUS_ALLOWED).filter(
      (file) => !PAYMENT_STATUS_READ.test(read(file)),
    );
    expect(
      stale,
      `These files are exempted from the Payment.status ban but no longer ` +
        `match it. Delete the entry rather than leaving a standing exemption ` +
        `nothing needs.`,
    ).toEqual([]);
  });

  it("the guest-add door reaches the captured-payment home directly", () => {
    // It asks the STATUS half, `isCapturedPaymentStatus`, not the whole of
    // `hasCapturedPayment` — deliberately, and this pin is where that is
    // recorded. The full predicate also requires `amountCents > 0`, and a
    // zero-dollar booking (credit, or a 100% promo) carries `amountCents: 0`
    // with a SUCCEEDED status. Using it here would stop asking that member for
    // an added guest's price, because the Xero arm cannot cover them when the
    // integration is off — a NEW under-collection at the very door this issue
    // exists to stop under-collecting at. Both #3244 reviews found it.
    const source = read(GUEST_ADD_ROUTE);
    expect(source).toMatch(
      /import\s*\{[^}]*\bisCapturedPaymentStatus\b[^}]*\}\s*from\s*"@\/lib\/booking-payment-state"/,
    );
    expect(source).toMatch(/isCapturedPaymentStatus\(booking\.payment\?\.status/);
    expect(
      source,
      `The guest-add door must not adopt the amount clause without a ` +
        `decision: it silently stops collecting from zero-dollar bookings.`,
    ).not.toMatch(/hasCapturedPayment\(/);
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
    // #3200, and the reason that fix was safe rather than merely different: the
    // guest-add route's own eligibility gate admits no finished stay, so the
    // status the inline copy got wrong never reached it.
    //
    // RE-EXPRESSED at #3245, which is outcome (b) the previous version of this
    // pin anticipated: the gate is no longer a literal in the route, it is a
    // call to a derivation. The guard is the same guard — a finished stay must
    // not reach this door's settlement — asserted in the two halves it now has.
    expect(
      read(GUEST_ADD_ROUTE),
      `The guest-add route no longer derives its eligibility gate from the ` +
        `edit policy. If you WIDENED the gate to admit COMPLETED, that is a ` +
        `real change and an expected signal, not a bug: the settlement ` +
        `answers COMPLETED as "invoice issued", which is the correct answer — ` +
        `bill the difference as a supplementary invoice. Update this test to ` +
        `say so. DO NOT DELETE IT: it is the only guard keeping a finished ` +
        `stay out of this door's settlement.`,
    ).toMatch(
      /activeLifecycleEditRefusal\(\s*booking\.status,\s*actorRole,?\s*\)/,
    );

    // And the derivation itself excludes COMPLETED, which is the half that
    // moved out of the route. Without this the pin above would pass on a
    // derivation that had quietly started admitting a finished stay.
    expect(canModifyBookingInActiveLifecycle("COMPLETED", "ADMIN")).toBe(false);
    expect(canModifyBookingInActiveLifecycle("COMPLETED", "MEMBER")).toBe(false);
    // The route passes no `includeFinishedStay`, so the override shape — which
    // DOES admit it — is not reachable from here. Pinned so that flipping the
    // default would fail rather than silently open the door.
    expect(
      canModifyBookingInActiveLifecycle("COMPLETED", "ADMIN", {
        includeFinishedStay: true,
      }),
    ).toBe(true);
    expect(read(GUEST_ADD_ROUTE)).not.toMatch(/includeFinishedStay/);
  });
});
