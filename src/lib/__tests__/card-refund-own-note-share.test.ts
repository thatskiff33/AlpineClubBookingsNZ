/**
 * #4312 (`INV-ADDPAY-047`): the pure rules behind a card refund's own Xero note
 * on a bank-transfer payment - which refunds a note of their own may answer
 * (made since the cutover), which door made a refund, and how a late
 * capture's ask splits between its newer refunds and the one note its older
 * refunds always had. The writers and the database are proven on real
 * PostgreSQL by `xero-bt-card-refund-notes.realdb.test.ts`.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import { cardRefundNoteKeyTag, cardRefundNoteRowsWhere } from "@/lib/card-refund-paid-another-way-cash";
import {
  cardRefundDoorOf,
  cardRefundIdOfNoteRow,
  cardRefundNoteKey,
  cardRefundNoteCutoverSeconds,
  madeSinceCardRefundNoteCutover,
  planLateCaptureCardNotes,
} from "@/lib/card-refund-own-note-share";
import { buildRefundRequestRefundMetadata } from "@/lib/payment-recovery-keys";

const CUTOVER = Date.UTC(2026, 9, 25, 0, 0, 0) / 1000;

describe("madeSinceCardRefundNoteCutover (#4312)", () => {
  const at = (iso: string) => new Date(iso);

  it("reads Stripe's own creation time, in whole seconds, against the marker", () => {
    expect(madeSinceCardRefundNoteCutover({ stripeCreatedAt: at("2026-10-25T00:00:00.000Z"), createdAt: at("2026-10-24T00:00:00.000Z") }, CUTOVER)).toBe(true);
    expect(madeSinceCardRefundNoteCutover({ stripeCreatedAt: at("2026-10-25T00:00:00.999Z"), createdAt: at("2026-10-26T00:00:00.000Z") }, CUTOVER)).toBe(true);
    expect(madeSinceCardRefundNoteCutover({ stripeCreatedAt: at("2026-10-24T23:59:59.999Z"), createdAt: at("2026-10-26T00:00:00.000Z") }, CUTOVER)).toBe(false);
  });

  it("falls back to when the ledger recorded it only when Stripe gave no time", () => {
    expect(madeSinceCardRefundNoteCutover({ stripeCreatedAt: null, createdAt: at("2026-10-26T00:00:00.000Z") }, CUTOVER)).toBe(true);
    expect(madeSinceCardRefundNoteCutover({ stripeCreatedAt: null, createdAt: at("2026-10-24T00:00:00.000Z") }, CUTOVER)).toBe(false);
  });

  it("a database with no migration history (null) counts every refund; an unfinished marker (Infinity) none", () => {
    const old = { stripeCreatedAt: at("2020-01-01T00:00:00.000Z"), createdAt: at("2020-01-01T00:00:00.000Z") };
    expect(madeSinceCardRefundNoteCutover(old, null)).toBe(true);
    expect(madeSinceCardRefundNoteCutover({ stripeCreatedAt: at("2099-01-01T00:00:00.000Z"), createdAt: at("2099-01-01T00:00:00.000Z") }, Number.POSITIVE_INFINITY)).toBe(false);
  });
});

describe("cardRefundNoteCutoverSeconds (#4312)", () => {
  function store(rows: unknown[][]) {
    const queryRaw = vi.fn();
    for (const answer of rows) queryRaw.mockResolvedValueOnce(answer);
    return { $queryRaw: queryRaw } as never;
  }

  it("is the marker migration's first finish, in whole seconds", async () => {
    expect(await cardRefundNoteCutoverSeconds(store([[{ present: true }], [{ finished_at: new Date("2026-10-25T00:00:00.700Z") }]]))).toBe(CUTOVER);
  });

  it("fails safe when the history has no finished marker: no refund qualifies", async () => {
    expect(await cardRefundNoteCutoverSeconds(store([[{ present: true }], []]))).toBe(Number.POSITIVE_INFINITY);
  });

  it("is null with no migration history at all", async () => {
    expect(await cardRefundNoteCutoverSeconds(store([[{ present: false }]]))).toBeNull();
  });
});

describe("cardRefundDoorOf (#4312)", () => {
  it("an approved refund request's refund, by the metadata its one builder stamps", () => {
    expect(cardRefundDoorOf(buildRefundRequestRefundMetadata("booking-1", "request-1"))).toBe("refund-request");
  });

  it("any other app door's refund carries a reason", () => {
    expect(cardRefundDoorOf({ bookingId: "booking-1", reason: "cancellation" })).toBe("app");
    expect(cardRefundDoorOf({ bookingId: "booking-1", reason: "edit_financial_review" })).toBe("app");
  });

  it("a refund made in the Stripe dashboard carries none", () => {
    expect(cardRefundDoorOf({})).toBe("outside-app");
    expect(cardRefundDoorOf(null)).toBe("outside-app");
    expect(cardRefundDoorOf(undefined)).toBe("outside-app");
    expect(cardRefundDoorOf({ reason: "  " })).toBe("outside-app");
  });
});

describe("planLateCaptureCardNotes (#4312)", () => {
  it("with no refund since the cutover, the one note for the capture asks for everything, as before", () => {
    expect(planLateCaptureCardNotes({ own: [], legacyRefundedCents: 5_000, legacyNotedCents: 2_000 })).toEqual({ own: [], legacyAskCents: 3_000 });
  });

  it("each newer refund is asked for on its own record, oldest first, at what its own notes do not cover", () => {
    expect(
      planLateCaptureCardNotes({
        own: [
          { stripeRefundId: "re_a", amountCents: 1_000, ownNotedCents: 1_000 },
          { stripeRefundId: "re_b", amountCents: 2_500, ownNotedCents: 500 },
          { stripeRefundId: "re_c", amountCents: 700, ownNotedCents: 0 },
        ],
        legacyRefundedCents: 0,
        legacyNotedCents: 0,
      }),
    ).toEqual({ own: [{ stripeRefundId: "re_b", askCents: 2_000 }, { stripeRefundId: "re_c", askCents: 700 }], legacyAskCents: 0 });
  });

  it("older refunds keep their one note beside the newer refunds' own", () => {
    expect(
      planLateCaptureCardNotes({ own: [{ stripeRefundId: "re_new", amountCents: 1_500, ownNotedCents: 0 }], legacyRefundedCents: 4_000, legacyNotedCents: 4_000 }),
    ).toEqual({ own: [{ stripeRefundId: "re_new", askCents: 1_500 }], legacyAskCents: 0 });
    expect(
      planLateCaptureCardNotes({ own: [{ stripeRefundId: "re_new", amountCents: 1_500, ownNotedCents: 0 }], legacyRefundedCents: 4_000, legacyNotedCents: 1_000 }),
    ).toEqual({ own: [{ stripeRefundId: "re_new", askCents: 1_500 }], legacyAskCents: 3_000 });
  });

  it("a capture-wide note that already answers a newer refund takes it off that refund's own ask: never noted twice", () => {
    // An older release noted the capture for $25 when its newer $15 refund was its only one and $10 more.
    expect(
      planLateCaptureCardNotes({ own: [{ stripeRefundId: "re_new", amountCents: 1_500, ownNotedCents: 0 }], legacyRefundedCents: 1_000, legacyNotedCents: 2_500 }),
    ).toEqual({ own: [], legacyAskCents: 0 });
    expect(
      planLateCaptureCardNotes({ own: [{ stripeRefundId: "re_new", amountCents: 1_500, ownNotedCents: 0 }], legacyRefundedCents: 1_000, legacyNotedCents: 2_000 }),
    ).toEqual({ own: [{ stripeRefundId: "re_new", askCents: 500 }], legacyAskCents: 0 });
  });

  it("the whole never asks for more than the capture's refunds less every note naming it", () => {
    const input = {
      own: [
        { stripeRefundId: "re_x", amountCents: 3_000, ownNotedCents: 0 },
        { stripeRefundId: "re_y", amountCents: 2_000, ownNotedCents: 2_500 },
      ],
      legacyRefundedCents: 4_000,
      legacyNotedCents: 1_000,
    };
    const plan = planLateCaptureCardNotes(input);
    const askCents = 4_000 + 3_000 + 2_000 - 1_000 - 2_500;
    expect(plan.legacyAskCents + plan.own.reduce((sum, ask) => sum + ask.askCents, 0)).toBeLessThanOrEqual(askCents);
    expect(plan).toEqual({ own: [{ stripeRefundId: "re_x", askCents: 2_500 }], legacyAskCents: 3_000 });
  });
});

describe("a card refund's own note row is found by its payload or by its key (#4312 review)", () => {
  const noLinks = { xeroObjectLink: { findMany: async () => [] }, xeroSyncOperation: { findMany: async () => [] } } as never;

  it("the key names the refund in the part the row finder and the reader match", async () => {
    const key = await cardRefundNoteKey("payment-1", "re_1AbC", 0, noLinks);
    expect(key).toContain(cardRefundNoteKeyTag("re_1AbC"));
    // Matched literally (`INV-SSOT-006`): the id's `_` is no LIKE wildcard.
    expect(cardRefundNoteRowsWhere("payment-1", "re_1AbC").OR).toContainEqual({ correlationKey: { contains: cardRefundNoteKeyTag("re\\_1AbC") } });
    // A previous release's worker rewrites the payload without the field: the key still answers.
    expect(cardRefundIdOfNoteRow({ requestPayload: { creditNotes: [], allocation: { amount: 12 } }, correlationKey: key })).toBe("re_1AbC");
  });

  it("INV-SSOT: the key is read back by the tag's own spelling, and the id stops at the tag's closing part", () => {
    for (const id of ["re_1AbC", "re_3Qx.y+z", "pyr_(9)"]) {
      expect(cardRefundIdOfNoteRow({ requestPayload: null, correlationKey: `payment:p:refund-credit-note${cardRefundNoteKeyTag(id)}2500:v3:void:cn_1` })).toBe(id);
    }
  });

  it("the payload answers first, read the one way a note row's fields are", () => {
    expect(cardRefundIdOfNoteRow({ requestPayload: { queueType: "REFUND_CREDIT_NOTE", refundAmountCents: 100, cardRefundId: "re_payload" }, correlationKey: null })).toBe("re_payload");
  });

  it("a row naming no card refund answers null", () => {
    expect(cardRefundIdOfNoteRow({ requestPayload: { queueType: "REFUND_CREDIT_NOTE", refundAmountCents: 100 }, correlationKey: "payment:p:refund-credit-note:100:v1" })).toBeNull();
  });
});
