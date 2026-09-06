import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PaymentSource,
  PaymentStatus,
  PaymentTransactionKind,
  type Prisma,
} from "@prisma/client";
import type Stripe from "stripe";
import { stripeSdkError } from "./support/stripe-sdk-error";
import type { SavedCardChargeReason } from "../saved-card-charge-attempt";

// #3267 (INV-PAY-055) — one saved-card charge attempt is one durable ledger row
// with its own Stripe idempotency key. This file pins the attempt contract on
// its own, against an in-memory ledger that REALLY applies the `where` clauses
// the module writes (status guards, unique intent id), so a guard that stops
// discriminating fails here rather than being satisfied by a canned `vi.fn`.
// The three call sites' integration (claim ordering, release, #3268 ordering in
// the cron) is pinned in their own route/cron suites.

type LedgerRow = {
  id: string;
  paymentId: string;
  kind: PaymentTransactionKind;
  source: PaymentSource;
  stripePaymentIntentId: string | null;
  reference: string | null;
  amountCents: number;
  refundedAmountCents: number;
  status: PaymentStatus;
  paymentMethodId: string | null;
  reason: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type StatusWhere =
  | PaymentStatus
  | { in?: PaymentStatus[]; notIn?: PaymentStatus[] }
  | undefined;

function statusMatches(status: PaymentStatus, where: StatusWhere): boolean {
  if (where === undefined) return true;
  if (typeof where === "string") return status === where;
  if (where.in && !where.in.includes(status)) return false;
  if (where.notIn && where.notIn.includes(status)) return false;
  return true;
}

/** A P2002 the way `isPrismaUniqueConstraintError` reads it (structural `code`). */
function uniqueViolation(): Error & { code: string } {
  return Object.assign(new Error("Unique constraint failed on stripePaymentIntentId"), {
    code: "P2002",
  });
}

const HOUR_MS = 60 * 60 * 1000;

const { ledger, mocks } = vi.hoisted(() => {
  const rows: LedgerRow[] = [];
  let seq = 0;
  const ledger = {
    rows,
    reset() {
      rows.splice(0, rows.length);
      seq = 0;
    },
    seed(partial: Partial<LedgerRow> & { paymentId: string }): LedgerRow {
      seq += 1;
      // Recent by default (the frozen clock is "now"): a seeded attempt whose
      // first POST never answered must still be inside Stripe's replay window
      // unless a test says otherwise. Ascending by seed order.
      const createdAt =
        partial.createdAt ?? new Date(Date.now() - 60 * 60 * 1000 + seq * 1000);
      const row: LedgerRow = {
        id: partial.id ?? `txn_${seq}`,
        paymentId: partial.paymentId,
        kind: partial.kind ?? PaymentTransactionKind.PRIMARY,
        source: partial.source ?? PaymentSource.STRIPE,
        stripePaymentIntentId: partial.stripePaymentIntentId ?? null,
        reference: partial.reference ?? null,
        amountCents: partial.amountCents ?? 10000,
        refundedAmountCents: partial.refundedAmountCents ?? 0,
        status: partial.status ?? PaymentStatus.PENDING,
        paymentMethodId: partial.paymentMethodId ?? null,
        reason: partial.reason ?? null,
        createdAt,
        updatedAt: partial.updatedAt ?? createdAt,
      };
      rows.push(row);
      return row;
    },
    paymentTransaction: {
      findMany: vi.fn(
        async (args: {
          where: { paymentId: string; kind: PaymentTransactionKind; source: PaymentSource };
        }) =>
          rows
            .filter(
              (r) =>
                r.paymentId === args.where.paymentId &&
                r.kind === args.where.kind &&
                r.source === args.where.source
            )
            .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
            .map((r) => ({ ...r }))
      ),
      // The adoption lookup (`adoptSavedCardChargeAttemptForIntent`).
      findFirst: vi.fn(
        async (args: {
          where: {
            reference: string;
            kind: PaymentTransactionKind;
            source: PaymentSource;
            stripePaymentIntentId: null;
            status: StatusWhere;
          };
        }) => {
          const row = rows.find(
            (r) =>
              r.reference === args.where.reference &&
              r.kind === args.where.kind &&
              r.source === args.where.source &&
              r.stripePaymentIntentId === null &&
              statusMatches(r.status, args.where.status)
          );
          return row ? { id: row.id, paymentId: row.paymentId } : null;
        }
      ),
      create: vi.fn(async (args: { data: Omit<Partial<LedgerRow>, "id"> & { paymentId: string } }) => {
        const row = ledger.seed(args.data);
        return { id: row.id };
      }),
      update: vi.fn(async (args: { where: { id: string }; data: Partial<LedgerRow> }) => {
        const row = rows.find((r) => r.id === args.where.id);
        if (!row) throw new Error(`no row ${args.where.id}`);
        if (
          args.data.stripePaymentIntentId &&
          rows.some(
            (r) => r.id !== row.id && r.stripePaymentIntentId === args.data.stripePaymentIntentId
          )
        ) {
          throw uniqueViolation();
        }
        Object.assign(row, args.data);
        return { id: row.id, paymentId: row.paymentId };
      }),
      // A faithful compare-and-set: matches on `id` OR on the unique intent id,
      // applies the status guard, and refuses (P2002) to give two rows one
      // intent id — the settle module's own-row write now goes through here, so
      // a guard that stopped discriminating would show up as a wrong row state.
      updateMany: vi.fn(
        async (args: {
          where: { id?: string; stripePaymentIntentId?: string; status?: StatusWhere };
          data: Partial<LedgerRow>;
        }) => {
          const hits = rows.filter(
            (r) =>
              (args.where.id === undefined || r.id === args.where.id) &&
              (args.where.stripePaymentIntentId === undefined ||
                r.stripePaymentIntentId === args.where.stripePaymentIntentId) &&
              statusMatches(r.status, args.where.status)
          );
          for (const row of hits) {
            if (
              args.data.stripePaymentIntentId &&
              rows.some(
                (r) =>
                  r.id !== row.id && r.stripePaymentIntentId === args.data.stripePaymentIntentId
              )
            ) {
              throw uniqueViolation();
            }
            Object.assign(row, args.data);
          }
          return { count: hits.length };
        }
      ),
      findUnique: vi.fn(
        async (args: { where: { stripePaymentIntentId?: string; id?: string } }) => {
          const row = rows.find((r) =>
            args.where.id !== undefined
              ? r.id === args.where.id
              : r.stripePaymentIntentId === args.where.stripePaymentIntentId
          );
          return row ? { ...row } : null;
        }
      ),
      deleteMany: vi.fn(
        async (args: { where: { id: string; stripePaymentIntentId?: string | null } }) => {
          const before = rows.length;
          const keep = rows.filter(
            (r) =>
              !(
                r.id === args.where.id &&
                (args.where.stripePaymentIntentId === undefined ||
                  r.stripePaymentIntentId === args.where.stripePaymentIntentId)
              )
          );
          rows.splice(0, rows.length, ...keep);
          return { count: before - rows.length };
        }
      ),
    },
  };
  const mocks = {
    chargePaymentMethod: vi.fn(),
    getPaymentIntent: vi.fn(),
    cancelPaymentIntentIfCancellableWithResult: vi.fn(),
    reconcilePaymentAggregates: vi.fn(),
  };
  return { ledger, mocks };
});

vi.mock("../prisma", () => ({ prisma: ledger }));
vi.mock("../stripe", () => ({
  chargePaymentMethod: (...args: unknown[]) => mocks.chargePaymentMethod(...args),
  getPaymentIntent: (...args: unknown[]) => mocks.getPaymentIntent(...args),
  cancelPaymentIntentIfCancellableWithResult: (...args: unknown[]) =>
    mocks.cancelPaymentIntentIfCancellableWithResult(...args),
}));
vi.mock("../payment-transactions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../payment-transactions")>()),
  reconcilePaymentAggregates: (...args: unknown[]) =>
    mocks.reconcilePaymentAggregates(...args),
}));
vi.mock("../logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const {
  beginSavedCardChargeAttempt,
  buildSavedCardChargeMetadata,
  SAVED_CARD_CHARGE_KEY_PREFIX,
  SAVED_CARD_CHARGE_KEY_RESEND_WINDOW_MS,
  SAVED_CARD_CHARGE_REASON,
  savedCardChargeIdempotencyKey,
  SavedCardChargeRefusedError,
} = await import("../saved-card-charge-attempt");
// The contract is one thing in three files, split where the provider call is
// (the ledger decision under the claim's locks, the Stripe call with no lock
// held, recording the answer). It is exercised from this one suite because the
// scenarios that matter run across all three.
const { chargeSavedCardAttempt, isDefiniteSavedCardChargeFailure } =
  await import("../saved-card-charge-request");
const {
  adoptSavedCardChargeAttemptForIntent,
  describeUnsettledPaymentIntent,
  ledgerStatusForPaymentIntent,
  settleSavedCardChargeAttempt,
} = await import("../saved-card-charge-settle");

const tx = ledger as unknown as Prisma.TransactionClient;
const BOOKING = "bk_1";
const PAYMENT = "pay_1";
const MEMBER = "mem_1";
const CARD = { stripeCustomerId: "cus_1", stripePaymentMethodId: "pm_1" };
const NEW_CARD = { stripeCustomerId: "cus_1", stripePaymentMethodId: "pm_2" };

function begin(
  card = CARD,
  reason: SavedCardChargeReason = SAVED_CARD_CHARGE_REASON.cron
) {
  return beginSavedCardChargeAttempt(tx, {
    paymentId: PAYMENT,
    bookingId: BOOKING,
    amountCents: 10000,
    card,
    reason,
  });
}

function charge(attempt: Awaited<ReturnType<typeof begin>>, card = CARD) {
  return chargeSavedCardAttempt({ attempt, bookingId: BOOKING, memberId: MEMBER, amountCents: 10000, card });
}

function settle(
  attemptRowId: string,
  paymentIntent: Parameters<typeof settleSavedCardChargeAttempt>[0]["paymentIntent"],
  store?: Prisma.TransactionClient
) {
  return settleSavedCardChargeAttempt({ attemptRowId, paymentId: PAYMENT, paymentIntent, ...(store ? { store } : {}) });
}

/** Seed an attempt row exactly as `begin` would have left it. */
function seedAttempt(partial: Partial<LedgerRow> = {}): LedgerRow {
  const id = partial.id ?? `txn_seeded_${ledger.rows.length + 1}`;
  return ledger.seed({
    paymentId: PAYMENT,
    id,
    reference: savedCardChargeIdempotencyKey(BOOKING, id),
    paymentMethodId: CARD.stripePaymentMethodId,
    reason: SAVED_CARD_CHARGE_REASON.cron,
    ...partial,
  });
}

function row(id: string): LedgerRow {
  const found = ledger.rows.find((r) => r.id === id);
  if (!found) throw new Error(`row ${id} gone`);
  return found;
}

beforeEach(() => {
  vi.clearAllMocks();
  ledger.reset();
  mocks.reconcilePaymentAggregates.mockResolvedValue(null);
});

describe("the key and the metadata (INV-SSOT)", () => {
  it("builds every key from the one prefix the cron's sweep excludes on, with the row's own id last", () => {
    expect(savedCardChargeIdempotencyKey("bk", "txn")).toBe(`${SAVED_CARD_CHARGE_KEY_PREFIX}bk_txn`);
    expect(SAVED_CARD_CHARGE_KEY_PREFIX).toBe("pending_charge_");
  });

  it("sends exactly { bookingId, memberId } for every path — no per-path `source`", () => {
    expect(buildSavedCardChargeMetadata("bk", "mem")).toEqual({ bookingId: "bk", memberId: "mem" });
    expect(Object.keys(buildSavedCardChargeMetadata("bk", "mem"))).not.toContain("source");
  });

  it("gives each path its own ledger reason, the cron's and charge-saved-method's unchanged from before #3267", () => {
    expect(SAVED_CARD_CHARGE_REASON.cron).toBe("pending_hold_auto_charge");
    expect(SAVED_CARD_CHARGE_REASON.chargeSavedMethodRoute).toBe("pending_saved_method_charge");
    expect(new Set(Object.values(SAVED_CARD_CHARGE_REASON)).size).toBe(3);
  });

  it("re-sends a key only inside Stripe's 24-hour window, with an hour of margin", () => {
    expect(SAVED_CARD_CHARGE_KEY_RESEND_WINDOW_MS).toBe(23 * HOUR_MS);
  });
});

describe("beginSavedCardChargeAttempt", () => {
  it("fresh: creates a PENDING PRIMARY Stripe row carrying the card and the path's reason, then stamps its reference with the key built from ITS OWN id", async () => {
    const attempt = await begin(CARD, SAVED_CARD_CHARGE_REASON.adminConfirmPendingGuests);

    expect(attempt.kind).toBe("fresh");
    const created = row(attempt.attemptRowId);
    expect(created).toMatchObject({
      paymentId: PAYMENT,
      kind: PaymentTransactionKind.PRIMARY,
      source: PaymentSource.STRIPE,
      status: PaymentStatus.PENDING,
      amountCents: 10000,
      paymentMethodId: "pm_1",
      reason: "admin_confirm_pending_guests_charge",
      stripePaymentIntentId: null,
    });
    expect(created.reference).toBe(savedCardChargeIdempotencyKey(BOOKING, created.id));
    expect(attempt.idempotencyKey).toBe(created.reference);
    expect(attempt.staleIntentIdsToCancel).toEqual([]);
    // Two statements, one transaction: the create cannot know its own id.
    expect(ledger.paymentTransaction.create).toHaveBeenCalledTimes(1);
    expect(ledger.paymentTransaction.update).toHaveBeenCalledWith({
      where: { id: created.id },
      data: { reference: created.reference },
    });
    // The aggregate is not re-derived here; the claim's upsert just set it.
    expect(mocks.reconcilePaymentAggregates).not.toHaveBeenCalled();
  });

  it("replay: an unresolved attempt on the SAME card is returned with its own key and its intent, and no row is created", async () => {
    const earlier = seedAttempt({
      status: PaymentStatus.PROCESSING,
      stripePaymentIntentId: "pi_earlier",
    });

    const attempt = await begin(CARD, SAVED_CARD_CHARGE_REASON.adminConfirmPendingGuests);

    expect(attempt).toEqual({
      kind: "replay",
      attemptRowId: earlier.id,
      idempotencyKey: earlier.reference,
      paymentIntentId: "pi_earlier",
      staleIntentIdsToCancel: [],
    });
    expect(ledger.paymentTransaction.create).not.toHaveBeenCalled();
    expect(ledger.rows).toHaveLength(1);
  });

  it("replay: a PENDING attempt whose first POST never answered (no intent) is replayed too, and so is one whose card #3268 nulled while it had no intent", async () => {
    const noAnswer = seedAttempt({ status: PaymentStatus.PENDING });
    expect((await begin()).attemptRowId).toBe(noAnswer.id);

    ledger.reset();
    const nulledCard = seedAttempt({ status: PaymentStatus.PENDING, paymentMethodId: null });
    const attempt = await begin(NEW_CARD);
    expect(attempt).toMatchObject({ kind: "replay", attemptRowId: nulledCard.id, paymentIntentId: null });
  });

  describe("a key is re-sent only inside Stripe's replay window (attempt_key_expired)", () => {
    it("a PENDING no-intent attempt 22 hours old is replayed; one 23 hours and a second old REFUSES, naming the row and when its key expired", async () => {
      const fresh = seedAttempt({
        status: PaymentStatus.PENDING,
        createdAt: new Date(Date.now() - 22 * HOUR_MS),
      });
      expect(await begin()).toMatchObject({ kind: "replay", attemptRowId: fresh.id });

      ledger.reset();
      const stale = seedAttempt({
        status: PaymentStatus.PENDING,
        createdAt: new Date(Date.now() - SAVED_CARD_CHARGE_KEY_RESEND_WINDOW_MS - 1000),
      });

      await expect(begin()).rejects.toMatchObject({
        name: "SavedCardChargeRefusedError",
        why: "attempt_key_expired",
        bookingId: BOOKING,
        attemptRowId: stale.id,
        paymentIntentId: null,
        since: new Date(stale.createdAt.getTime() + SAVED_CARD_CHARGE_KEY_RESEND_WINDOW_MS),
      });
      // Nothing minted, nothing ended: the claim rolls back around this throw.
      expect(ledger.paymentTransaction.create).not.toHaveBeenCalled();
      expect(row(stale.id).status).toBe(PaymentStatus.PENDING);
    });

    it("the window applies only to a row with NO intent: an old PROCESSING row that names its intent is retrieved, not re-sent, and has no deadline", async () => {
      const old = seedAttempt({
        status: PaymentStatus.PROCESSING,
        stripePaymentIntentId: "pi_old_but_known",
        createdAt: new Date(Date.now() - 3 * 24 * HOUR_MS),
      });

      await expect(begin()).resolves.toMatchObject({
        kind: "replay",
        attemptRowId: old.id,
        paymentIntentId: "pi_old_but_known",
      });
    });

    it("says, in the message, what an administrator does about it", async () => {
      seedAttempt({
        status: PaymentStatus.PENDING,
        createdAt: new Date(Date.now() - 2 * SAVED_CARD_CHARGE_KEY_RESEND_WINDOW_MS),
      });
      const err = await begin().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SavedCardChargeRefusedError);
      expect((err as Error).message).toContain("more than 23 hours ago");
      expect((err as Error).message).toContain("payment_intent.succeeded");
      expect((err as Error).message).toContain("save their card again");
    });
  });

  it("different card: the unresolved attempt on the OLD card is marked FAILED with its reason suffixed, its intent is queued for cancel, and a fresh row is minted under a NEW key", async () => {
    const old = seedAttempt({
      status: PaymentStatus.PROCESSING,
      stripePaymentIntentId: "pi_old_card",
    });

    const attempt = await begin(NEW_CARD);

    expect(attempt.kind).toBe("fresh");
    expect(attempt.attemptRowId).not.toBe(old.id);
    expect(attempt.idempotencyKey).not.toBe(old.reference);
    expect(attempt.staleIntentIdsToCancel).toEqual(["pi_old_card"]);
    expect(row(old.id)).toMatchObject({
      status: PaymentStatus.FAILED,
      reason: "pending_hold_auto_charge:superseded_by_new_card",
    });
    expect(row(attempt.attemptRowId).paymentMethodId).toBe("pm_2");
  });

  it("different card: a PROCESSING row whose card #3268 nulled but whose intent still exists is ended and cancelled, not replayed", async () => {
    const nulled = seedAttempt({
      status: PaymentStatus.PROCESSING,
      paymentMethodId: null,
      stripePaymentIntentId: "pi_nulled",
    });

    const attempt = await begin(NEW_CARD);

    expect(attempt.kind).toBe("fresh");
    expect(attempt.staleIntentIdsToCancel).toEqual(["pi_nulled"]);
    expect(row(nulled.id).status).toBe(PaymentStatus.FAILED);
  });

  it("ending a superseded row is status-guarded: a row a webhook has since settled is left alone and its intent is NOT queued for cancel", async () => {
    const old = seedAttempt({
      status: PaymentStatus.PROCESSING,
      stripePaymentIntentId: "pi_old",
    });
    // Simulate the webhook landing between the findMany and the updateMany.
    ledger.paymentTransaction.findMany.mockImplementationOnce(async () => {
      const snapshot = ledger.rows.map((r) => ({ ...r }));
      row(old.id).status = PaymentStatus.FAILED;
      return snapshot;
    });

    const attempt = await begin(NEW_CARD);

    expect(attempt.kind).toBe("fresh");
    expect(attempt.staleIntentIdsToCancel).toEqual([]);
    expect(row(old.id).reason).toBe("pending_hold_auto_charge");
  });

  it("refuse: a PRIMARY row still holding net captured cash THROWS SavedCardChargeRefusedError naming the intent and when the row was last written — whoever minted the row", async () => {
    const capturedAt = new Date(Date.now() - 5 * HOUR_MS);
    ledger.seed({
      paymentId: PAYMENT,
      status: PaymentStatus.SUCCEEDED,
      stripePaymentIntentId: "pi_captured",
      // Not an attempt row: a legacy shared-key row or a link intent.
      reference: null,
      updatedAt: capturedAt,
    });

    await expect(begin()).rejects.toMatchObject({
      name: "SavedCardChargeRefusedError",
      why: "captured_primary_exists",
      bookingId: BOOKING,
      paymentIntentId: "pi_captured",
      since: capturedAt,
    });
    expect(ledger.paymentTransaction.create).not.toHaveBeenCalled();
  });

  it("refuse: PARTIALLY_REFUNDED still holds cash and refuses; a fully REFUNDED row is #1765 history and a fresh attempt proceeds", async () => {
    ledger.seed({
      paymentId: PAYMENT,
      status: PaymentStatus.PARTIALLY_REFUNDED,
      amountCents: 10000,
      refundedAmountCents: 4000,
      stripePaymentIntentId: "pi_partial",
    });
    await expect(begin()).rejects.toBeInstanceOf(SavedCardChargeRefusedError);

    ledger.reset();
    ledger.seed({
      paymentId: PAYMENT,
      status: PaymentStatus.REFUNDED,
      amountCents: 10000,
      refundedAmountCents: 10000,
      stripePaymentIntentId: "pi_refunded",
    });
    await expect(begin()).resolves.toMatchObject({ kind: "fresh" });
  });

  describe("rows that are not attempt rows", () => {
    it("a legacy shared-key row (reason set, no reference) unresolved on the SAME card with an intent is REPLAYED by retrieve — deploy-transition safety, so a processing legacy intent is waited on rather than charged beside", async () => {
      const legacy = ledger.seed({
        paymentId: PAYMENT,
        status: PaymentStatus.PROCESSING,
        stripePaymentIntentId: "pi_legacy_shared_key",
        reference: null,
        reason: "pending_hold_auto_charge",
        paymentMethodId: "pm_1",
      });

      const attempt = await begin();

      expect(attempt).toMatchObject({
        kind: "replay",
        attemptRowId: legacy.id,
        paymentIntentId: "pi_legacy_shared_key",
        staleIntentIdsToCancel: [],
      });
      expect(ledger.paymentTransaction.create).not.toHaveBeenCalled();
      mocks.getPaymentIntent.mockResolvedValue({ id: "pi_legacy_shared_key", status: "processing", amount: 10000, payment_method: "pm_1" });
      await charge(attempt);
      expect(mocks.getPaymentIntent).toHaveBeenCalledWith("pi_legacy_shared_key");
      expect(mocks.chargePaymentMethod).not.toHaveBeenCalled();
    });

    it("a same-card /pay link intent the member is mid-way through paying is likewise this booking's money in flight and is replayed, not charged beside", async () => {
      const link = ledger.seed({
        paymentId: PAYMENT,
        status: PaymentStatus.PROCESSING,
        stripePaymentIntentId: "pi_link_same_card",
        reference: null,
        reason: null,
        paymentMethodId: "pm_1",
      });

      expect(await begin()).toMatchObject({ kind: "replay", attemptRowId: link.id, paymentIntentId: "pi_link_same_card" });
    });

    it("leaves alone a link intent with no card yet: neither replayed nor ended — the cron's sweep owns it", async () => {
      const link = ledger.seed({
        paymentId: PAYMENT,
        status: PaymentStatus.PROCESSING,
        stripePaymentIntentId: "pi_link",
        reference: null,
        reason: null,
      });

      const attempt = await begin();

      expect(attempt.kind).toBe("fresh");
      expect(attempt.staleIntentIdsToCancel).toEqual([]);
      expect(row(link.id).status).toBe(PaymentStatus.PROCESSING);
    });

    // The deploy cutover. Before #3267 the shared key stopped a second charge
    // beside one of these rows; after it, nothing does — the #1992 sweep
    // excludes attempt rows by the key prefix, which a reference-less legacy
    // row does not carry, and the sweep is cron-only. So the claim takes the
    // row over on whatever card it names.
    it.each([
      ["the cron's", SAVED_CARD_CHARGE_REASON.cron],
      ["charge-saved-method's", SAVED_CARD_CHARGE_REASON.chargeSavedMethodRoute],
    ])(
      "a legacy shared-key row (%s reason, no reference) on ANOTHER card is ENDED and its intent named for cancellation, not left for the cron's cancel-only sweep",
      async (_label, reason) => {
        const legacyOtherCard = ledger.seed({
          paymentId: PAYMENT,
          status: PaymentStatus.PROCESSING,
          stripePaymentIntentId: "pi_legacy_other_card",
          reference: null,
          reason,
          paymentMethodId: "pm_retired",
        });

        const attempt = await begin();

        expect(attempt.kind).toBe("fresh");
        expect(attempt.staleIntentIdsToCancel).toEqual(["pi_legacy_other_card"]);
        expect(row(legacyOtherCard.id)).toMatchObject({
          status: PaymentStatus.FAILED,
          reason: `${reason}:superseded_by_new_card`,
        });
      }
    );

    it("a legacy row on another card whose intent is still PROCESSING is WAITED on, not charged beside: the intent is the answer, its row is revived and the fresh attempt row is dropped", async () => {
      const legacy = ledger.seed({
        paymentId: PAYMENT,
        status: PaymentStatus.PROCESSING,
        stripePaymentIntentId: "pi_legacy_live",
        reference: null,
        reason: SAVED_CARD_CHARGE_REASON.cron,
        paymentMethodId: "pm_retired",
      });
      const attempt = await begin(NEW_CARD);
      const live = { id: "pi_legacy_live", status: "processing" as const, amount: 10000, payment_method: "pm_retired" };
      // Stripe refuses to cancel a `processing` card payment.
      mocks.cancelPaymentIntentIfCancellableWithResult.mockRejectedValue(
        stripeSdkError({ type: "invalid_request_error", code: "payment_intent_unexpected_state" })
      );
      mocks.getPaymentIntent.mockResolvedValue(live);

      const intent = await charge(attempt, NEW_CARD);

      expect(intent).toBe(live);
      expect(mocks.chargePaymentMethod).not.toHaveBeenCalled();
      expect(row(legacy.id).status).toBe(PaymentStatus.PROCESSING);

      const settled = await settle(attempt.attemptRowId, live);
      expect(settled).toMatchObject({ transactionId: legacy.id, ledgerStatus: PaymentStatus.PROCESSING, keptExistingRow: true });
      expect(ledger.rows.find((r) => r.id === attempt.attemptRowId)).toBeUndefined();
    });

    it("a legacy row on the SAME card still replays by retrieve rather than being ended", async () => {
      const legacy = ledger.seed({
        paymentId: PAYMENT,
        status: PaymentStatus.PROCESSING,
        stripePaymentIntentId: "pi_legacy_same_card",
        reference: null,
        reason: SAVED_CARD_CHARGE_REASON.cron,
        paymentMethodId: CARD.stripePaymentMethodId,
      });

      const attempt = await begin();

      expect(attempt).toMatchObject({
        kind: "replay",
        attemptRowId: legacy.id,
        paymentIntentId: "pi_legacy_same_card",
        staleIntentIdsToCancel: [],
      });
      expect(row(legacy.id).status).toBe(PaymentStatus.PROCESSING);
      expect(ledger.paymentTransaction.create).not.toHaveBeenCalled();
    });

    it("a reference-less row with no charge reason is a link intent, not a legacy attempt: on another card it is still left to the sweep", async () => {
      const link = ledger.seed({
        paymentId: PAYMENT,
        status: PaymentStatus.PROCESSING,
        stripePaymentIntentId: "pi_link_other_card",
        reference: null,
        reason: null,
        paymentMethodId: "pm_someone_elses",
      });

      const attempt = await begin();

      expect(attempt.kind).toBe("fresh");
      expect(attempt.staleIntentIdsToCancel).toEqual([]);
      expect(row(link.id).status).toBe(PaymentStatus.PROCESSING);
    });

    it("a legacy row with a charge reason but NO intent is never replayed: its key was never sent, so re-sending one built from its id would be a brand-new charge", async () => {
      const orphan = ledger.seed({
        paymentId: PAYMENT,
        status: PaymentStatus.PENDING,
        stripePaymentIntentId: null,
        reference: null,
        reason: SAVED_CARD_CHARGE_REASON.cron,
        paymentMethodId: "pm_retired",
      });

      const attempt = await begin();

      expect(attempt.kind).toBe("fresh");
      expect(attempt.staleIntentIdsToCancel).toEqual([]);
      expect(row(orphan.id).status).toBe(PaymentStatus.PENDING);
    });

    it("a row carrying another row's key is not an attempt row (the key must be built from the row's OWN id) — but on the same card with an intent it is still in flight and replayed", async () => {
      ledger.seed({
        paymentId: PAYMENT,
        id: "txn_a",
        status: PaymentStatus.PROCESSING,
        stripePaymentIntentId: "pi_a",
        reference: savedCardChargeIdempotencyKey(BOOKING, "txn_somebody_else"),
        paymentMethodId: "pm_other",
      });

      expect((await begin()).kind).toBe("fresh");
    });
  });
});

describe("chargeSavedCardAttempt", () => {
  const succeeded = { id: "pi_new", status: "succeeded", amount: 10000, payment_method: "pm_1" };

  it("fresh: charges under the row's key with the shared metadata, and nothing else", async () => {
    const attempt = await begin();
    mocks.chargePaymentMethod.mockResolvedValue(succeeded);

    const intent = await charge(attempt);

    expect(intent).toBe(succeeded);
    expect(mocks.chargePaymentMethod).toHaveBeenCalledWith({
      amountCents: 10000,
      customerId: "cus_1",
      paymentMethodId: "pm_1",
      metadata: { bookingId: BOOKING, memberId: MEMBER },
      idempotencyKey: attempt.idempotencyKey,
    });
    expect(mocks.getPaymentIntent).not.toHaveBeenCalled();
    expect(mocks.cancelPaymentIntentIfCancellableWithResult).not.toHaveBeenCalled();
  });

  it("replay with a known intent: RETRIEVES the intent's current state instead of re-sending the key (a replayed key answers the first response for ever)", async () => {
    seedAttempt({ status: PaymentStatus.PROCESSING, stripePaymentIntentId: "pi_earlier" });
    const attempt = await begin();
    mocks.getPaymentIntent.mockResolvedValue({ ...succeeded, id: "pi_earlier" });

    const intent = await charge(attempt);

    expect(intent.id).toBe("pi_earlier");
    expect(mocks.getPaymentIntent).toHaveBeenCalledWith("pi_earlier");
    expect(mocks.chargePaymentMethod).not.toHaveBeenCalled();
  });

  it("replay without an intent: re-sends the SAME key the earlier attempt stored, so Stripe replays or executes it exactly once", async () => {
    const earlier = seedAttempt({ status: PaymentStatus.PENDING });
    const attempt = await begin();
    mocks.chargePaymentMethod.mockResolvedValue(succeeded);

    await charge(attempt);

    expect(mocks.chargePaymentMethod).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: earlier.reference })
    );
  });

  it("cancels the superseded attempt's intent best-effort BEFORE charging, and charges when the cancel lands", async () => {
    seedAttempt({ status: PaymentStatus.PROCESSING, stripePaymentIntentId: "pi_old" });
    const attempt = await begin(NEW_CARD);
    mocks.cancelPaymentIntentIfCancellableWithResult.mockResolvedValue({
      canceled: true,
      paymentIntent: { id: "pi_old", status: "canceled" },
    });
    mocks.chargePaymentMethod.mockResolvedValue(succeeded);

    await charge(attempt, NEW_CARD);

    expect(mocks.cancelPaymentIntentIfCancellableWithResult).toHaveBeenCalledWith("pi_old");
    expect(mocks.cancelPaymentIntentIfCancellableWithResult.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.chargePaymentMethod.mock.invocationCallOrder[0]!
    );
    expect(mocks.chargePaymentMethod).toHaveBeenCalledWith(
      expect.objectContaining({ paymentMethodId: "pm_2", idempotencyKey: attempt.idempotencyKey })
    );
  });

  it("a superseded intent found already SUCCEEDED is the answer: no second charge, and settle moves the old row to SUCCEEDED and removes the fresh attempt row", async () => {
    const old = seedAttempt({ status: PaymentStatus.PROCESSING, stripePaymentIntentId: "pi_old" });
    const attempt = await begin(NEW_CARD);
    expect(row(old.id).status).toBe(PaymentStatus.FAILED);
    const capturedOld = { id: "pi_old", status: "succeeded" as const, amount: 10000, payment_method: "pm_1" };
    mocks.cancelPaymentIntentIfCancellableWithResult.mockResolvedValue({
      canceled: false,
      paymentIntent: capturedOld,
    });

    const intent = await charge(attempt, NEW_CARD);
    expect(intent).toBe(capturedOld);
    expect(mocks.chargePaymentMethod).not.toHaveBeenCalled();

    const settled = await settle(attempt.attemptRowId, capturedOld);

    expect(settled).toEqual({ transactionId: old.id, ledgerStatus: PaymentStatus.SUCCEEDED, keptExistingRow: true, moved: true });
    expect(row(old.id)).toMatchObject({ status: PaymentStatus.SUCCEEDED, stripePaymentIntentId: "pi_old" });
    expect(ledger.rows.find((r) => r.id === attempt.attemptRowId)).toBeUndefined();
    expect(mocks.reconcilePaymentAggregates).toHaveBeenCalledWith({ paymentId: PAYMENT, store: ledger });
  });

  describe("a superseded intent found still PROCESSING is live: wait on it, never compete (#3267 fix round)", () => {
    const processingOld = { id: "pi_old", status: "processing" as const, amount: 10000, payment_method: "pm_1" };

    it("when the SDK reports it not cancellable: it is the answer, no charge is made, and its row is put back to PROCESSING so the next run sees a live attempt", async () => {
      const old = seedAttempt({ status: PaymentStatus.PROCESSING, stripePaymentIntentId: "pi_old" });
      const attempt = await begin(NEW_CARD);
      expect(row(old.id).status).toBe(PaymentStatus.FAILED);
      mocks.cancelPaymentIntentIfCancellableWithResult.mockResolvedValue({
        canceled: false,
        paymentIntent: processingOld,
      });

      const intent = await charge(attempt, NEW_CARD);

      expect(intent).toBe(processingOld);
      expect(mocks.chargePaymentMethod).not.toHaveBeenCalled();
      expect(row(old.id)).toMatchObject({
        status: PaymentStatus.PROCESSING,
        reason: "pending_hold_auto_charge:superseded_by_new_card",
      });
    });

    it("when Stripe REFUSES the cancel (a processing card payment cannot be cancelled; the SDK throws): the intent is retrieved, found processing, and the same waiting happens", async () => {
      seedAttempt({ status: PaymentStatus.PROCESSING, stripePaymentIntentId: "pi_old" });
      const attempt = await begin(NEW_CARD);
      mocks.cancelPaymentIntentIfCancellableWithResult.mockRejectedValue(
        stripeSdkError({ type: "invalid_request_error", message: "You cannot cancel this PaymentIntent because it has a status of processing." })
      );
      mocks.getPaymentIntent.mockResolvedValue(processingOld);

      const intent = await charge(attempt, NEW_CARD);

      expect(intent).toBe(processingOld);
      expect(mocks.getPaymentIntent).toHaveBeenCalledWith("pi_old");
      expect(mocks.chargePaymentMethod).not.toHaveBeenCalled();
    });

    it("settle then keeps the live row (PROCESSING, its amount), removes the fresh attempt row, and the NEXT begin on the new card ends it again and queues its cancel again — the loop that waits until Stripe decides", async () => {
      const old = seedAttempt({ status: PaymentStatus.PROCESSING, stripePaymentIntentId: "pi_old" });
      const attempt = await begin(NEW_CARD);
      mocks.cancelPaymentIntentIfCancellableWithResult.mockResolvedValue({ canceled: false, paymentIntent: processingOld });
      const intent = await charge(attempt, NEW_CARD);

      const settled = await settle(attempt.attemptRowId, intent);

      expect(settled).toEqual({ transactionId: old.id, ledgerStatus: PaymentStatus.PROCESSING, keptExistingRow: true, moved: true });
      expect(ledger.rows.map((r) => r.id)).toEqual([old.id]);
      expect(row(old.id).status).toBe(PaymentStatus.PROCESSING);

      const next = await begin(NEW_CARD);
      expect(next).toMatchObject({ kind: "fresh", staleIntentIdsToCancel: ["pi_old"] });
      // The suffix is applied once, however many runs end the same row.
      expect(row(old.id).reason).toBe("pending_hold_auto_charge:superseded_by_new_card");
    });

    it("a capture outranks a live intent, and EVERY stale intent is visited before answering — a cancellable one is still cancelled after a capture has been found", async () => {
      seedAttempt({ status: PaymentStatus.PROCESSING, stripePaymentIntentId: "pi_captured" });
      seedAttempt({ status: PaymentStatus.PROCESSING, stripePaymentIntentId: "pi_processing" });
      seedAttempt({ status: PaymentStatus.PROCESSING, stripePaymentIntentId: "pi_3ds" });
      const attempt = await begin(NEW_CARD);
      expect(attempt.staleIntentIdsToCancel).toEqual(["pi_captured", "pi_processing", "pi_3ds"]);
      const capturedOld = { id: "pi_captured", status: "succeeded" as const, amount: 10000, payment_method: "pm_1" };
      mocks.cancelPaymentIntentIfCancellableWithResult
        .mockResolvedValueOnce({ canceled: false, paymentIntent: capturedOld })
        .mockResolvedValueOnce({ canceled: false, paymentIntent: { ...processingOld, id: "pi_processing" } })
        .mockResolvedValueOnce({ canceled: true, paymentIntent: { id: "pi_3ds", status: "canceled" } });

      const intent = await charge(attempt, NEW_CARD);

      expect(intent).toBe(capturedOld);
      expect(mocks.cancelPaymentIntentIfCancellableWithResult).toHaveBeenCalledTimes(3);
      expect(mocks.cancelPaymentIntentIfCancellableWithResult).toHaveBeenLastCalledWith("pi_3ds");
      expect(mocks.chargePaymentMethod).not.toHaveBeenCalled();
    });
  });

  it("a cancel that errors AND cannot be read back, or finds the intent terminal without a capture, is logged and the charge proceeds", async () => {
    seedAttempt({ status: PaymentStatus.PROCESSING, stripePaymentIntentId: "pi_a" });
    seedAttempt({ status: PaymentStatus.PROCESSING, stripePaymentIntentId: "pi_b" });
    const attempt = await begin(NEW_CARD);
    expect(attempt.staleIntentIdsToCancel).toEqual(["pi_a", "pi_b"]);
    mocks.cancelPaymentIntentIfCancellableWithResult
      .mockRejectedValueOnce(new Error("Stripe cancel raced a parallel confirm"))
      .mockResolvedValueOnce({ canceled: false, paymentIntent: { id: "pi_b", status: "canceled" } });
    mocks.getPaymentIntent.mockRejectedValueOnce(new Error("and the retrieve timed out"));
    mocks.chargePaymentMethod.mockResolvedValue(succeeded);

    await expect(charge(attempt, NEW_CARD)).resolves.toBe(succeeded);
    expect(mocks.getPaymentIntent).toHaveBeenCalledWith("pi_a");
    expect(mocks.chargePaymentMethod).toHaveBeenCalledTimes(1);
  });

  describe("a thrown failure is partitioned into definite and ambiguous", () => {
    it.each([
      ["card_error", stripeSdkError({ type: "card_error", code: "card_declined", decline_code: "insufficient_funds" })],
      ["invalid_request_error", stripeSdkError({ type: "invalid_request_error", message: "The provided PaymentMethod ... may not be used again." })],
      ["idempotency_error", stripeSdkError({ type: "idempotency_error", message: "Keys for idempotent requests can only be used with the same parameters" })],
      ["authentication_error", stripeSdkError({ type: "authentication_error" })],
    ])("DEFINITE (%s): the row is FAILED before the ORIGINAL error reaches the caller, so the next attempt is fresh", async (_label, err) => {
      const attempt = await begin();
      let statusWhenCaught: PaymentStatus | null = null;
      mocks.chargePaymentMethod.mockRejectedValue(err);

      await expect(
        charge(attempt).catch((caught: unknown) => {
          statusWhenCaught = row(attempt.attemptRowId).status;
          throw caught;
        })
      ).rejects.toBe(err);

      expect(statusWhenCaught).toBe(PaymentStatus.FAILED);
      expect(isDefiniteSavedCardChargeFailure(err)).toBe(true);

      // The next attempt on the same card is fresh: a new row, a new key.
      const next = await begin();
      expect(next.kind).toBe("fresh");
      expect(next.attemptRowId).not.toBe(attempt.attemptRowId);
      expect(next.idempotencyKey).not.toBe(attempt.idempotencyKey);
    });

    it.each([
      ["api_error (5xx)", stripeSdkError({ type: "api_error", message: "Stripe is having a moment" })],
      ["rate_limit_error", stripeSdkError({ type: "rate_limit_error" })],
      ["connection error (no API type)", Object.assign(new Error("socket hang up"), { type: "StripeConnectionError" })],
      ["plain Error", new Error("network down")],
    ])("AMBIGUOUS (%s): the row stays PENDING and the next attempt replays THIS one's key", async (_label, err) => {
      const attempt = await begin();
      mocks.chargePaymentMethod.mockRejectedValue(err);

      await expect(charge(attempt)).rejects.toBe(err);

      expect(row(attempt.attemptRowId).status).toBe(PaymentStatus.PENDING);
      expect(isDefiniteSavedCardChargeFailure(err)).toBe(false);

      const next = await begin();
      expect(next).toMatchObject({ kind: "replay", attemptRowId: attempt.attemptRowId, idempotencyKey: attempt.idempotencyKey });
    });

    describe("on a RETRIEVE (a replay that names its intent) the partition is different: only resource_missing is definite", () => {
      it.each([
        ["authentication_error", stripeSdkError({ type: "authentication_error" })],
        ["invalid_request_error (not resource_missing)", stripeSdkError({ type: "invalid_request_error", message: "Rate-limited or malformed" })],
        ["api_error", stripeSdkError({ type: "api_error" })],
      ])("%s on a GET says nothing about an intent that may be processing: the row stays PROCESSING and is asked about again", async (_label, err) => {
        const earlier = seedAttempt({ status: PaymentStatus.PROCESSING, stripePaymentIntentId: "pi_earlier" });
        const attempt = await begin();
        mocks.getPaymentIntent.mockRejectedValue(err);

        await expect(charge(attempt)).rejects.toBe(err);

        expect(row(earlier.id).status).toBe(PaymentStatus.PROCESSING);
        // The same error on a POST would have been definite — the partition is the request's, not the error's.
        expect(isDefiniteSavedCardChargeFailure(err)).toBe(_label === "api_error" ? false : true);
        expect((await begin()).attemptRowId).toBe(earlier.id);
      });

      it("resource_missing on a GET means the intent is gone: the row is FAILED and the next attempt is fresh", async () => {
        const earlier = seedAttempt({ status: PaymentStatus.PROCESSING, stripePaymentIntentId: "pi_gone" });
        const attempt = await begin();
        mocks.getPaymentIntent.mockRejectedValue(
          stripeSdkError({ type: "invalid_request_error", code: "resource_missing", message: "No such payment_intent: 'pi_gone'" })
        );

        await expect(charge(attempt)).rejects.toBeDefined();

        expect(row(earlier.id).status).toBe(PaymentStatus.FAILED);
        expect((await begin()).kind).toBe("fresh");
      });
    });

    it("the FAILED mark is status-guarded: a row a webhook settled meanwhile is not regressed", async () => {
      const attempt = await begin();
      row(attempt.attemptRowId).status = PaymentStatus.SUCCEEDED;
      mocks.chargePaymentMethod.mockRejectedValue(stripeSdkError({ type: "card_error", code: "card_declined" }));

      await expect(charge(attempt)).rejects.toBeDefined();

      expect(row(attempt.attemptRowId).status).toBe(PaymentStatus.SUCCEEDED);
    });

    it("if the FAILED mark itself throws, the Stripe error is still what the caller sees", async () => {
      const attempt = await begin();
      const stripeErr = stripeSdkError({ type: "card_error", code: "card_declined" });
      mocks.chargePaymentMethod.mockRejectedValue(stripeErr);
      ledger.paymentTransaction.updateMany.mockRejectedValueOnce(new Error("db gone"));

      await expect(charge(attempt)).rejects.toBe(stripeErr);
    });
  });

  it("#3268 ordering: after a definite failure the retire path nulls the row's card, and the next attempt on a re-saved card is FRESH — never a replay of a key whose body names the retired card", async () => {
    const attempt = await begin();
    mocks.chargePaymentMethod.mockRejectedValue(
      stripeSdkError({ type: "invalid_request_error", message: "The provided PaymentMethod ... may not be used again." })
    );
    await expect(charge(attempt)).rejects.toBeDefined();
    // What retireUnusableSavedCard does to every ledger row carrying the pm.
    for (const r of ledger.rows) if (r.paymentMethodId === "pm_1") r.paymentMethodId = null;
    expect(row(attempt.attemptRowId)).toMatchObject({ status: PaymentStatus.FAILED, paymentMethodId: null });

    const next = await begin(NEW_CARD);

    expect(next.kind).toBe("fresh");
    expect(next.attemptRowId).not.toBe(attempt.attemptRowId);
  });
});

describe("cross-path scenarios (the property the owner chose)", () => {
  it("cron attempt left PROCESSING -> the admin click REPLAYS it: the key equals the row's reference, Stripe is asked about the same intent, no second charge", async () => {
    const cron = await begin(CARD, SAVED_CARD_CHARGE_REASON.cron);
    mocks.chargePaymentMethod.mockResolvedValue({ id: "pi_cron", status: "requires_action", amount: 10000, payment_method: "pm_1" });
    const first = await charge(cron);
    await settle(cron.attemptRowId, first);
    expect(row(cron.attemptRowId)).toMatchObject({ status: PaymentStatus.PROCESSING, stripePaymentIntentId: "pi_cron" });

    const admin = await begin(CARD, SAVED_CARD_CHARGE_REASON.adminConfirmPendingGuests);
    expect(admin).toMatchObject({ kind: "replay", attemptRowId: cron.attemptRowId, paymentIntentId: "pi_cron" });
    expect(admin.idempotencyKey).toBe(row(cron.attemptRowId).reference);
    mocks.getPaymentIntent.mockResolvedValue({ id: "pi_cron", status: "succeeded", amount: 10000, payment_method: "pm_1" });

    const second = await charge(admin);

    expect(second.id).toBe("pi_cron");
    expect(mocks.chargePaymentMethod).toHaveBeenCalledTimes(1);
    await settle(admin.attemptRowId, second);
    expect(ledger.rows).toHaveLength(1);
    expect(row(cron.attemptRowId).status).toBe(PaymentStatus.SUCCEEDED);
  });

  it("cron attempt definitely refused -> the admin click mints a NEW key and Stripe sees a fresh request (the admin button is no longer dead for 24h)", async () => {
    const cron = await begin(CARD, SAVED_CARD_CHARGE_REASON.cron);
    mocks.chargePaymentMethod.mockRejectedValueOnce(stripeSdkError({ type: "card_error", code: "card_declined" }));
    await expect(charge(cron)).rejects.toBeDefined();

    const admin = await begin(CARD, SAVED_CARD_CHARGE_REASON.adminConfirmPendingGuests);
    expect(admin.kind).toBe("fresh");
    expect(admin.idempotencyKey).not.toBe(cron.idempotencyKey);
    mocks.chargePaymentMethod.mockResolvedValueOnce({ id: "pi_admin", status: "succeeded", amount: 10000, payment_method: "pm_1" });

    await charge(admin);

    expect(mocks.chargePaymentMethod).toHaveBeenLastCalledWith(
      expect.objectContaining({ idempotencyKey: admin.idempotencyKey, metadata: { bookingId: BOOKING, memberId: MEMBER } })
    );
    expect(ledger.rows.map((r) => r.status)).toEqual([PaymentStatus.FAILED, PaymentStatus.PENDING]);
  });

  it("the member re-saves a card while the cron's attempt on the old card is unresolved: the old attempt is ended and its intent cancelled, the new card is charged at once", async () => {
    const cron = await begin(CARD);
    mocks.chargePaymentMethod.mockResolvedValueOnce({ id: "pi_old", status: "requires_action", amount: 10000, payment_method: "pm_1" });
    const first = await charge(cron);
    await settle(cron.attemptRowId, first);

    const next = await begin(NEW_CARD);
    expect(next).toMatchObject({ kind: "fresh", staleIntentIdsToCancel: ["pi_old"] });
    mocks.cancelPaymentIntentIfCancellableWithResult.mockResolvedValue({ canceled: true, paymentIntent: { id: "pi_old", status: "canceled" } });
    mocks.chargePaymentMethod.mockResolvedValueOnce({ id: "pi_new", status: "succeeded", amount: 10000, payment_method: "pm_2" });

    await charge(next, NEW_CARD);

    expect(mocks.cancelPaymentIntentIfCancellableWithResult).toHaveBeenCalledWith("pi_old");
    expect(mocks.chargePaymentMethod).toHaveBeenLastCalledWith(expect.objectContaining({ paymentMethodId: "pm_2" }));
  });
});

describe("settleSavedCardChargeAttempt", () => {
  it("records the intent id, mapped status, amount and card on the attempt row through a status-guarded updateMany, then re-derives the Payment aggregate", async () => {
    const attempt = await begin();

    const settled = await settle(attempt.attemptRowId, {
      id: "pi_x",
      status: "succeeded",
      amount: 9900,
      // The expanded-object shape of a Stripe reference (#3266's fold).
      payment_method: { id: "pm_expanded" } as unknown as Stripe.PaymentMethod,
    });

    expect(settled).toEqual({ transactionId: attempt.attemptRowId, ledgerStatus: PaymentStatus.SUCCEEDED, keptExistingRow: false, moved: true });
    expect(row(attempt.attemptRowId)).toMatchObject({
      stripePaymentIntentId: "pi_x",
      status: PaymentStatus.SUCCEEDED,
      amountCents: 9900,
      paymentMethodId: "pm_expanded",
    });
    // Forward only: a capture is written over anything but refund history.
    expect(ledger.paymentTransaction.updateMany).toHaveBeenCalledWith({
      where: {
        id: attempt.attemptRowId,
        status: { notIn: [PaymentStatus.REFUNDED, PaymentStatus.PARTIALLY_REFUNDED] },
      },
      data: { stripePaymentIntentId: "pi_x", status: PaymentStatus.SUCCEEDED, amountCents: 9900, paymentMethodId: "pm_expanded" },
    });
    expect(mocks.reconcilePaymentAggregates).toHaveBeenCalledWith({ paymentId: PAYMENT, store: ledger });
  });

  it("a non-captured answer is written only over an unresolved row, and a null card from Stripe never nulls the card the row carries", async () => {
    const attempt = await begin();

    await settle(attempt.attemptRowId, { id: "pi_x", status: "requires_action", amount: 10000, payment_method: null });

    expect(ledger.paymentTransaction.updateMany).toHaveBeenCalledWith({
      where: { id: attempt.attemptRowId, status: { in: [PaymentStatus.PENDING, PaymentStatus.PROCESSING] } },
      data: { stripePaymentIntentId: "pi_x", status: PaymentStatus.PROCESSING, amountCents: 10000 },
    });
    expect(row(attempt.attemptRowId).paymentMethodId).toBe("pm_1");
  });

  it("uses the caller's transaction client when given one (the locked release records inside its own tx)", async () => {
    const attempt = await begin();
    const store = ledger as unknown as Prisma.TransactionClient;

    await settle(attempt.attemptRowId, { id: "pi_x", status: "processing", amount: 10000, payment_method: null }, store);

    expect(mocks.reconcilePaymentAggregates).toHaveBeenCalledWith({ paymentId: PAYMENT, store });
    expect(row(attempt.attemptRowId).status).toBe(PaymentStatus.PROCESSING);
  });

  describe("the attempt's OWN row is forward only (the webhook may have won between the retrieve and the release's locks)", () => {
    it("a stale `processing` answer never regresses a row the webhook has moved to SUCCEEDED: nothing is written, no reconcile runs, and the row's real status is reported", async () => {
      const attempt = await begin();
      // The webhook adopted the row by key and settled it — booking PAID.
      Object.assign(row(attempt.attemptRowId), { status: PaymentStatus.SUCCEEDED, stripePaymentIntentId: "pi_x" });

      const settled = await settle(attempt.attemptRowId, { id: "pi_x", status: "processing", amount: 10000, payment_method: "pm_1" });

      expect(settled).toEqual({ transactionId: attempt.attemptRowId, ledgerStatus: PaymentStatus.SUCCEEDED, keptExistingRow: false, moved: false });
      expect(row(attempt.attemptRowId).status).toBe(PaymentStatus.SUCCEEDED);
      expect(mocks.reconcilePaymentAggregates).not.toHaveBeenCalled();
    });

    it("a stale `processing` answer never revives a row the webhook has FAILED", async () => {
      const attempt = await begin();
      Object.assign(row(attempt.attemptRowId), { status: PaymentStatus.FAILED, stripePaymentIntentId: "pi_x" });

      const settled = await settle(attempt.attemptRowId, { id: "pi_x", status: "requires_action", amount: 10000, payment_method: "pm_1" });

      expect(settled).toMatchObject({ ledgerStatus: PaymentStatus.FAILED, moved: false });
      expect(row(attempt.attemptRowId).status).toBe(PaymentStatus.FAILED);
    });

    it("a captured answer IS written over a row the webhook left FAILED or PROCESSING (money is money), but never over refund history", async () => {
      const attempt = await begin();
      Object.assign(row(attempt.attemptRowId), { status: PaymentStatus.FAILED, stripePaymentIntentId: "pi_x" });
      expect(await settle(attempt.attemptRowId, { id: "pi_x", status: "succeeded", amount: 10000, payment_method: "pm_1" })).toMatchObject({ ledgerStatus: PaymentStatus.SUCCEEDED, moved: true });

      Object.assign(row(attempt.attemptRowId), { status: PaymentStatus.REFUNDED, refundedAmountCents: 10000 });
      expect(await settle(attempt.attemptRowId, { id: "pi_x", status: "succeeded", amount: 10000, payment_method: "pm_1" })).toMatchObject({ ledgerStatus: PaymentStatus.REFUNDED, moved: false });
      expect(row(attempt.attemptRowId).status).toBe(PaymentStatus.REFUNDED);
    });
  });

  it("a row for the intent already exists (webhook first): the attempt row is deleted, the existing row kept, and a captured status is never regressed by a stale non-captured answer", async () => {
    const attempt = await begin();
    const webhookRow = ledger.seed({
      paymentId: PAYMENT,
      status: PaymentStatus.SUCCEEDED,
      stripePaymentIntentId: "pi_hook",
      amountCents: 10000,
    });

    const settled = await settle(attempt.attemptRowId, { id: "pi_hook", status: "processing", amount: 10000, payment_method: null });

    expect(settled).toEqual({ transactionId: webhookRow.id, ledgerStatus: PaymentStatus.SUCCEEDED, keptExistingRow: true, moved: false });
    expect(row(webhookRow.id).status).toBe(PaymentStatus.SUCCEEDED);
    expect(ledger.rows.find((r) => r.id === attempt.attemptRowId)).toBeUndefined();
    expect(mocks.reconcilePaymentAggregates).toHaveBeenCalledWith({ paymentId: PAYMENT, store: ledger });
  });

  it("P2002 race: the unique violation on the intent id takes the keep-existing branch instead of throwing on a path that has just captured money", async () => {
    const attempt = await begin();
    // Not visible to the pre-check, present by the time the write runs.
    const winner = { id: "txn_hook", paymentId: PAYMENT } as unknown as LedgerRow;
    ledger.paymentTransaction.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(winner);
    ledger.paymentTransaction.updateMany.mockRejectedValueOnce(uniqueViolation());

    const settled = await settle(attempt.attemptRowId, { id: "pi_hook", status: "succeeded", amount: 10000, payment_method: "pm_1" });

    expect(settled).toMatchObject({ transactionId: "txn_hook", keptExistingRow: true });
    expect(ledger.paymentTransaction.deleteMany).toHaveBeenCalledWith({
      where: { id: attempt.attemptRowId, stripePaymentIntentId: null },
    });
  });

  it("any other error from the row write propagates untouched", async () => {
    const attempt = await begin();
    ledger.paymentTransaction.updateMany.mockRejectedValueOnce(new Error("db gone"));

    await expect(
      settle(attempt.attemptRowId, { id: "pi_x", status: "succeeded", amount: 10000, payment_method: "pm_1" })
    ).rejects.toThrow("db gone");
  });
});

describe("adoptSavedCardChargeAttemptForIntent (a webhook for an intent the ledger does not know — the lost-response recovery)", () => {
  const capture = { id: "pi_lost", status: "succeeded" as const, amount: 10000, payment_method: "pm_1" };

  it("adopts the PENDING no-intent attempt row whose key the event carries: stamps the intent and SUCCEEDED, reconciles, and reports the row", async () => {
    const attempt = await begin();

    const adopted = await adoptSavedCardChargeAttemptForIntent({
      paymentIntent: capture,
      bookingId: BOOKING,
      idempotencyKey: attempt.idempotencyKey,
    });

    expect(adopted).toEqual({ transactionId: attempt.attemptRowId, ledgerStatus: PaymentStatus.SUCCEEDED, keptExistingRow: false, moved: true });
    expect(row(attempt.attemptRowId)).toMatchObject({ stripePaymentIntentId: "pi_lost", status: PaymentStatus.SUCCEEDED });
    expect(mocks.reconcilePaymentAggregates).toHaveBeenCalledWith({ paymentId: PAYMENT, store: ledger });
    // And the next attempt refuses: the money is on the ledger now.
    await expect(begin()).rejects.toMatchObject({ why: "captured_primary_exists", paymentIntentId: "pi_lost" });
  });

  it("adopts a FAILED answer too, so a lost-response decline ends the attempt instead of leaving it to expire", async () => {
    const attempt = await begin();

    const adopted = await adoptSavedCardChargeAttemptForIntent({
      paymentIntent: { ...capture, status: "requires_payment_method" },
      bookingId: BOOKING,
      idempotencyKey: attempt.idempotencyKey,
    });

    expect(adopted).toMatchObject({ ledgerStatus: PaymentStatus.FAILED, moved: true });
    expect((await begin()).kind).toBe("fresh");
  });

  it.each([
    ["no key on the event", undefined],
    ["a key that is not ours", "late_cancel_refund_bk_1_pi_x"],
    ["a key built from ANOTHER row's id", savedCardChargeIdempotencyKey(BOOKING, "txn_somebody_else")],
    ["a key for another booking", savedCardChargeIdempotencyKey("bk_other", "txn_seeded_1")],
  ])("returns null and touches nothing for %s", async (_label, key) => {
    const attempt = await begin();

    expect(await adoptSavedCardChargeAttemptForIntent({ paymentIntent: capture, bookingId: BOOKING, idempotencyKey: key })).toBeNull();
    expect(row(attempt.attemptRowId)).toMatchObject({ status: PaymentStatus.PENDING, stripePaymentIntentId: null });
  });

  it("adopts only a row that still has NO intent: a row already settled by the charging code is found by intent id, not by key", async () => {
    const attempt = await begin();
    await settle(attempt.attemptRowId, capture);

    expect(await adoptSavedCardChargeAttemptForIntent({ paymentIntent: capture, bookingId: BOOKING, idempotencyKey: attempt.idempotencyKey })).toBeNull();
  });
});

describe("ledgerStatusForPaymentIntent / describeUnsettledPaymentIntent", () => {
  it.each([
    ["succeeded", PaymentStatus.SUCCEEDED],
    ["canceled", PaymentStatus.FAILED],
    ["requires_payment_method", PaymentStatus.FAILED],
    ["requires_action", PaymentStatus.PROCESSING],
    ["processing", PaymentStatus.PROCESSING],
    ["requires_confirmation", PaymentStatus.PROCESSING],
    ["requires_capture", PaymentStatus.PROCESSING],
  ] as const)("%s -> %s", (status, expected) => {
    expect(ledgerStatusForPaymentIntent(status)).toBe(expected);
  });

  it("describes each non-captured status in plain English, naming the status it does not know", () => {
    expect(describeUnsettledPaymentIntent("requires_action")).toContain("3D Secure");
    expect(describeUnsettledPaymentIntent("processing")).toContain("still being processed");
    expect(describeUnsettledPaymentIntent("canceled")).toContain("cancelled");
    expect(describeUnsettledPaymentIntent("requires_payment_method")).toContain("failed at the card issuer");
    expect(describeUnsettledPaymentIntent("requires_capture")).toContain('"requires_capture"');
  });
});
