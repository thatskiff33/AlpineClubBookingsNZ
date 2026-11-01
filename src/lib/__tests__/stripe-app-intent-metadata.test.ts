import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type * as StripeModule from "@/lib/stripe";
import { relativeSource, sourceFiles } from "@/lib/__tests__/support/booking-guest-night-writer-scan";
import { stripCommentsAndStrings } from "@/lib/__tests__/support/strip-comments";
import { buildSavedCardChargeMetadata, savedCardChargeIdempotencyKey } from "@/lib/saved-card-charge-key";
import {
  GROUP_SETTLEMENT_INTENT_TYPE,
  appPaymentIntentRoute,
  assertAppPaymentIntentMetadata,
  isAppCreatedPaymentIntent,
  type AppPaymentIntentMetadata,
} from "@/lib/stripe-app-intent-metadata";

/**
 * #4532 (`INV-INT-032`): which succeeded PaymentIntents are the app's own. The
 * webhook records and alerts every other one, so a false "not ours" would
 * alert on a member's booking payment, and a false "ours" would let a Payment
 * Link donation complete silently again.
 */
describe("isAppCreatedPaymentIntent (#4532)", () => {
  it("recognises every metadata shape the app's call sites send", () => {
    const shapes: AppPaymentIntentMetadata[] = [
      // create-payment-intent route and the app's own /pay links
      { bookingId: "bk_1", memberId: "m_1" },
      { bookingId: "bk_1", organisationId: "org_1", paymentLinkId: "pl_1" },
      // additional asks: modification, ordinary, re-issued, currency re-issue
      { bookingId: "bk_1", type: "additional_modification", reason: "r", reissuedAskKey: "k" },
      // group organiser settlement
      { type: GROUP_SETTLEMENT_INTENT_TYPE, groupBookingId: "g_1", organiserMemberId: "m_1" },
      // saved-card off-session charges, from the real builder: a new attempt
      // names its row (#4646); one minted before #4646 re-sends its old body
      buildSavedCardChargeMetadata("bk_1", "m_1", { attemptRowId: "txn_1", idempotencyKey: savedCardChargeIdempotencyKey("bk_1", "txn_1") }),
      buildSavedCardChargeMetadata("bk_1", null, { attemptRowId: "txn_1", idempotencyKey: savedCardChargeIdempotencyKey("bk_1", "txn_1") }),
      buildSavedCardChargeMetadata("bk_1", "m_1", { attemptRowId: "txn_1", idempotencyKey: "pending_charge_bk_1_txn_1" }),
    ];
    for (const metadata of shapes) expect(isAppCreatedPaymentIntent(metadata), JSON.stringify(metadata)).toBe(true);
  });

  it("does not recognise a payment made outside the app, even one carrying keys the app also uses", () => {
    for (const metadata of [
      null,
      undefined,
      {},
      // A Payment Link or dashboard charge with the club's own metadata.
      { type: "donation" },
      { memberId: "m_1", campaign: "winter" },
      { paymentLinkId: "pl_1" },
      { bookingId: "" },
    ]) {
      expect(isAppCreatedPaymentIntent(metadata), JSON.stringify(metadata)).toBe(false);
    }
  });

  it("does not compile an app intent whose metadata names neither a booking nor a group settlement", () => {
    type CreateMetadata = Parameters<typeof StripeModule.createPaymentIntent>[0]["metadata"];
    type ChargeMetadata = Parameters<typeof StripeModule.chargePaymentMethod>[0]["metadata"];
    // @ts-expect-error - a booking intent must carry bookingId
    const create: CreateMetadata = { memberId: "m_1" };
    // @ts-expect-error - metadata is required, never defaulted to {}
    const charge: ChargeMetadata = undefined;
    // @ts-expect-error - the group type needs its group
    const group: CreateMetadata = { type: GROUP_SETTLEMENT_INTENT_TYPE };
    expect([create, charge, group]).toHaveLength(3);
  });

  // #4647: the dispatcher routes on this reading, so a recognised booking
  // intent always arrives with its booking id and none without one is possible.
  it("routes a recognised intent with the booking it names, a group settlement as such, and anything else nowhere", () => {
    expect(appPaymentIntentRoute({ bookingId: "bk_1", memberId: "m_1" })).toEqual({ kind: "booking", bookingId: "bk_1" });
    expect(appPaymentIntentRoute({ bookingId: "bk_1", type: "additional_modification" })).toEqual({
      kind: "booking",
      bookingId: "bk_1",
    });
    expect(appPaymentIntentRoute({ type: GROUP_SETTLEMENT_INTENT_TYPE, groupBookingId: "g_1" })).toEqual({
      kind: "group_settlement",
    });
    for (const metadata of [null, undefined, {}, { bookingId: "" }, { type: "donation" }, { memberId: "m_1" }]) {
      expect(appPaymentIntentRoute(metadata), JSON.stringify(metadata)).toBeNull();
      expect(isAppCreatedPaymentIntent(metadata), JSON.stringify(metadata)).toBe(false);
    }
  });

  it("refuses an empty bookingId before Stripe is called", () => {
    expect(() => assertAppPaymentIntentMetadata({ bookingId: "" })).toThrow(/non-empty/);
    expect(() => assertAppPaymentIntentMetadata({ bookingId: "bk_1" })).not.toThrow();
    expect(() =>
      assertAppPaymentIntentMetadata({ type: GROUP_SETTLEMENT_INTENT_TYPE, groupBookingId: "g_1" }),
    ).not.toThrow();
  });
});

/**
 * THE CENSUS: every Stripe object that takes money is created in `stripe.ts`,
 * by the two functions whose metadata is {@link AppPaymentIntentMetadata}. A new
 * `paymentIntents.create`, or the app's first Checkout session, Payment Link,
 * invoice, subscription or charge, fails here until it is classified: if it
 * carries no metadata the webhook recognises, its payments would be recorded as
 * ones the app did not create (or, for an invoice or subscription, Stripe makes
 * the PaymentIntent and the app's metadata is on the parent, not the intent).
 */
const MONEY_CREATE_CALL =
  /\.\s*(paymentIntents|checkout\s*\.\s*sessions|paymentLinks|invoices|invoiceItems|subscriptions|subscriptionSchedules|charges)\s*\.\s*create\s*\(/g;

describe("Stripe money-object creation census (#4532)", () => {
  it("finds exactly the two PaymentIntent creations in stripe.ts and nothing else", () => {
    const files = sourceFiles();
    // Vacuity guard: the walk reached the tree, including the file it must find.
    expect(files.map(relativeSource)).toContain("src/lib/stripe.ts");
    const found: string[] = [];
    for (const file of files) {
      const code = stripCommentsAndStrings(readFileSync(file, "utf8"));
      for (const match of code.matchAll(MONEY_CREATE_CALL)) {
        found.push(`${relativeSource(file)}: ${match[1]!.replace(/\s+/g, "")}`);
      }
    }
    expect(found.sort()).toEqual(["src/lib/stripe.ts: paymentIntents", "src/lib/stripe.ts: paymentIntents"]);
  });

  it("types the metadata of both stripe.ts creations as the app's", () => {
    const source = readFileSync("src/lib/stripe.ts", "utf8");
    for (const name of ["createPaymentIntent", "chargePaymentMethod"]) {
      const start = source.indexOf(`export async function ${name}(`);
      expect(start, name).toBeGreaterThanOrEqual(0);
      const signature = source.slice(start, source.indexOf("): Promise<Stripe.PaymentIntent>", start));
      expect(signature, name).toContain("metadata: AppPaymentIntentMetadata;");
    }
  });
});
