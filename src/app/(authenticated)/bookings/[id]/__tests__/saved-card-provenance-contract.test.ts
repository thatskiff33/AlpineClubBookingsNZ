// #3269 / INV-PAY-053 — the admin "Confirm pending guests" button on the member
// booking page says whether confirming WILL CHARGE the member's saved card. That
// wording has to come from the same answer the confirm-pending-guests route
// charges on, or the page promises a charge the route will not make (or hides
// one it will).
//
// WHY THIS IS A SOURCE-TEXT CONTRACT AND NOT A RENDER TEST. Same reasoning as
// `issue-2779-draft-pickup-card.test.ts` beside it: the prop is computed inside
// an async React Server Component, and standing it up tests the mocks. What must
// be true is narrow and structural:
//
//  * the prop is derived by `savedPaymentMethodForBooking` — the one home for
//    "may this card be charged off-session" — and not by a truthiness check on
//    `stripePaymentMethodId`, which is what read a one-off checkout card (and a
//    laundered copy of one) as a saved card;
//  * the member's "Save Payment Method" card keys on the SAME named const
//    (epic #3270, composing #3266 with #3269): the form shows exactly when the
//    cron would find nothing to charge, so the page can never ask for a card
//    while promising a charge, or promise a charge while asking for a card;
//  * the query gives that function what it needs: the split parent's payment
//    row, including `stripeSetupIntentId`, without which a child charged on
//    its parent's genuinely saved card would read as "no card".
//
// #2958 SPLIT THE PAGE and each of those three now lives in the module that owns
// it: the derivation and the save-card gate in `_lib/booking-detail-payment.ts`,
// the button's wording in `_components/booking-admin-tools-section.tsx`, the
// query in `_lib/load-booking-detail.ts`. Nothing about the contract changed —
// but "exactly one derivation" and the two never-again clauses are now counted
// over the WHOLE ROUTE DIRECTORY rather than over one file, because after a
// split a second copy would land in a sibling module rather than in the page.
// The "same named const" half is what a split could quietly break, so it is
// pinned explicitly: the section destructures `savedCard` off the payment
// projection rather than deriving one of its own.
//
// Comments are stripped before matching, so the paragraph explaining a guard can
// never stand in for the guard.
import { readdirSync, readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

import { stripComments } from "@/lib/__tests__/support/strip-comments";

const ROUTE_DIR = "src/app/(authenticated)/bookings/[id]";
const PAYMENT_PROJECTION = "_lib/booking-detail-payment.ts";
const READ_MODEL = "_lib/load-booking-detail.ts";
const ADMIN_TOOLS_SECTION = "_components/booking-admin-tools-section.tsx";

function readRouteFile(relative: string): string {
  // Test helper: a fixed repo file under process.cwd(), not user input.
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
  return stripComments(
    readFileSync(path.resolve(process.cwd(), ROUTE_DIR, relative), "utf8"),
  );
}

/** Every production `.ts`/`.tsx` in the route directory, comments stripped. */
function routeSources(): Array<{ file: string; source: string }> {
  const root = path.resolve(process.cwd(), ROUTE_DIR);
  const out: Array<{ file: string; source: string }> = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "__tests__") walk(full);
      } else if (
        /\.tsx?$/.test(entry.name) &&
        !/\.test\.tsx?$/.test(entry.name)
      ) {
        // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
        out.push({
          file: path.relative(root, full),
          source: stripComments(readFileSync(full, "utf8")),
        });
      }
    }
  };
  walk(root);
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

describe("#3269 saved-card provenance on the member booking page (INV-PAY-053)", () => {
  const all = routeSources();
  const wholeRoute = all.map((entry) => entry.source).join("\n");

  it("finds the surface it is meant to police", () => {
    // Guards against a later move making every assertion below vacuous.
    expect(all.length, "route directory not found or empty").toBeGreaterThan(10);
    for (const relative of [PAYMENT_PROJECTION, READ_MODEL, ADMIN_TOOLS_SECTION]) {
      expect(
        all.some((entry) => entry.file.split(path.sep).join("/") === relative),
        `${relative} is not in the route directory any more`,
      ).toBe(true);
    }
  });

  it("derives ONE named answer from savedPaymentMethodForBooking, own row and parent row", () => {
    const source = readRouteFile(PAYMENT_PROJECTION);
    expect(source).toContain(
      'import { savedPaymentMethodForBooking } from "@/lib/saved-payment-method";',
    );
    expect(source).toMatch(
      /const savedCard = savedPaymentMethodForBooking\(\{\s*payment: booking\.payment,\s*parentBooking: booking\.parentBooking,\s*\}\);/,
    );
    // Exactly one call ANYWHERE in the route directory: a second derivation is a
    // second place the answer could drift, which is the defect this contract
    // exists to make unrepresentable.
    expect(
      wholeRoute.match(/savedPaymentMethodForBooking\(/g),
    ).toHaveLength(1);
  });

  it("the confirm button's will-charge wording reads that const", () => {
    const source = readRouteFile(ADMIN_TOOLS_SECTION);
    expect(source).toMatch(/hasSavedPaymentMethod=\{savedCard !== null\}/);
    // …and the const is the projection's, not a second one derived here. This
    // is what "the SAME named const" means once the two halves sit in different
    // files: the section reads the answer, it does not compute one.
    expect(source).toMatch(/const \{ savedCard \} = payment;/);
    expect(source).not.toMatch(/savedPaymentMethodForBooking/);
  });

  it("the member's Save Payment Method card shows exactly when that const finds no card (epic #3270)", () => {
    expect(readRouteFile(PAYMENT_PROJECTION)).toMatch(
      /const showSavePaymentMethodCard =\s*isBookingOwner &&\s*!isDeleted &&\s*!internetBankingPayment &&\s*booking\.status === "PENDING" &&\s*savedCard === null;/,
    );
    // Not the retired #3266 predicate over the card column alone, which hid the
    // form from a legacy split child carrying a copied, unchargeable card.
    expect(wholeRoute).not.toMatch(/needsSavedCardEntry/);
  });

  it("never falls back to the populated-fields check that read a one-off checkout card as saved", () => {
    expect(wholeRoute).not.toMatch(
      /hasSavedPaymentMethod=\{Boolean\(\s*booking\.payment\?\.stripePaymentMethodId/,
    );
  });

  it("loads the split parent's payment row with the SetupIntent column the predicate needs", () => {
    expect(readRouteFile(READ_MODEL)).toMatch(
      /parentBooking: \{\s*select: \{\s*id: true,\s*status: true,\s*finalPriceCents: true,\s*payment: \{\s*select: \{\s*stripeCustomerId: true,\s*stripePaymentMethodId: true,\s*stripeSetupIntentId: true,\s*\},\s*\},\s*\},\s*\}/,
    );
  });
});
