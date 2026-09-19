/**
 * AID-6C's authoritative booking-finance calculation (#2377).
 *
 * The other finance entries return stored rows, and a contract test is enough for
 * them. This one COMPUTES, so what has to be proved is the arithmetic and the
 * classification — in integer cents, across the money shapes #2377 enumerates:
 * zero, partial, over, under, refunds, credits, cent-level differences and the
 * exact reconciliation identity.
 *
 * `@/lib/member-credit` is deliberately NOT mocked. `deriveBookingAppliedCreditCents`
 * and `getMemberCreditBalance` are the authoritative credit functions every write
 * path validates against, and the whole argument for making this a `server_owned`
 * entry is that it reuses them rather than re-deriving credit. Stubbing them would
 * test a copy of the thing under test, so the Prisma client beneath them is what is
 * stubbed and the real functions run.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// THE HARNESS HAS TO SEE A READ THAT ESCAPES THE TRANSACTION (#2786).
//
// Since this source runs inside the shared read-only seam, "every read went
// through `tx`" is a property worth proving — and it is one an ordinary mock
// cannot prove. Handing the callback the global client would make every
// `toBe(txMock)` assertion vacuous; handing it a shallow copy makes identity
// assertions real for the collaborators this file MOCKS, but the two credit
// helpers are deliberately NOT mocked (see the docblock above), so no argument
// assertion can reach them at all. Each of them falls back to the global client
// when it is handed nothing — silently, and with every behavioural expectation
// in this file still satisfied.
//
// So the global client RECORDS which properties are reached on it while the
// transaction is open. A read that escaped names its model there, whether it was
// written in this pack or inside a helper three modules away, and the recorder
// discriminates by construction rather than by anyone remembering to assert on a
// new collaborator. Recording is scoped to the callback so the fixture wiring in
// `setup`, which legitimately reaches through the same object, is not counted.
// ---------------------------------------------------------------------------

const { prismaMock, txMock, globalClientReads, recordingWindow } = vi.hoisted(
  () => {
    const models = {
      booking: { findUnique: vi.fn() },
      payment: { findUnique: vi.fn() },
      memberCredit: { findMany: vi.fn(), aggregate: vi.fn() },
      xeroSyncOperation: { findMany: vi.fn() },
      xeroObjectLink: { findFirst: vi.fn() },
      paymentRecoveryOperation: { findMany: vi.fn() },
      manualRefundTask: { count: vi.fn() },
      refundRequest: { count: vi.fn() },
    };
    /**
     * A DISTINCT OBJECT HOLDING THE SAME DOUBLES, and no `$transaction`.
     *
     * The same shape #2376 established for the booking pack: every
     * `prismaMock.payment.findUnique` assertion in this file keeps working because
     * the functions are shared, while the object identities differ — so a read that
     * reached the global client instead is visible rather than indistinguishable.
     * `$transaction` is absent because a `Prisma.TransactionClient` does not have
     * one, so a nested interactive transaction throws here instead of quietly
     * taking a second pool connection. `$executeRaw` IS present because the seam's
     * two control statements run on the transaction client, which is the only place
     * raw execution belongs on this path.
     */
    const txMock = { ...models, $executeRaw: vi.fn().mockResolvedValue(0) };
    const globalClientReads: string[] = [];
    const recordingWindow = { open: false };
    const base = { ...models, $transaction: vi.fn() };
    const prismaMock = new Proxy(base, {
      get(target, property, receiver) {
        if (recordingWindow.open && typeof property === "string") {
          globalClientReads.push(property);
        }
        return Reflect.get(target, property, receiver);
      },
    }) as typeof base;
    return { prismaMock, txMock, globalClientReads, recordingWindow };
  },
);

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));

import { prisma } from "@/lib/prisma";

import {
  DIAGNOSTICS_READ_ONLY_STATEMENT_TIMEOUT_MS,
  DIAGNOSTICS_READ_ONLY_TRANSACTION_TIMEOUT_MS,
} from "../../read-only-transaction";
import { readBookingFinanceStateEvidence } from "../finance-evidence";

const BOOKING_ID = "clzbooking0000000000000001";
const PAYMENT_ID = "clzpayment0000000000000001";
const MEMBER_ID = "clzmember00000000000000001";

interface Scenario {
  booking?: {
    id?: string;
    memberId?: string;
    status?: string;
    finalPriceCents?: number;
  } | null;
  payment?: {
    id?: string;
    status?: string;
    source?: string;
    amountCents?: number;
    refundedAmountCents?: number;
    creditAppliedCents?: number;
    additionalAmountCents?: number;
    additionalPaymentStatus?: string | null;
    xeroInvoiceId?: string | null;
    manuallyMarkedPaidAt?: Date | null;
  } | null;
  /** Signed `MemberCredit` rows the ledger aggregate should report for the booking. */
  appliedCreditLedgerCents?: number;
  memberCreditBalanceCents?: number;
  cancellationCredits?: {
    amountCents: number;
    description: string;
    type?: string;
  }[];
  xeroOperations?: { id: string; status: string; createdAt: Date }[];
  /** An ACTIVE PRIMARY_INVOICE `XeroObjectLink` exists for the payment. */
  primaryInvoiceLink?: boolean;
  recoveryOperations?: { status: string; attempts: number }[];
  openManualRefundTasks?: number;
  pendingRefundAppeals?: number;
}

function setup(scenario: Scenario): void {
  const booking =
    scenario.booking === null
      ? null
      : {
          id: scenario.booking?.id ?? BOOKING_ID,
          memberId: scenario.booking?.memberId ?? MEMBER_ID,
          status: scenario.booking?.status ?? "CONFIRMED",
          finalPriceCents: scenario.booking?.finalPriceCents ?? 10_000,
        };

  const payment =
    scenario.payment === null
      ? null
      : {
          id: scenario.payment?.id ?? PAYMENT_ID,
          status: scenario.payment?.status ?? "SUCCEEDED",
          source: scenario.payment?.source ?? "STRIPE",
          amountCents: scenario.payment?.amountCents ?? 10_000,
          refundedAmountCents: scenario.payment?.refundedAmountCents ?? 0,
          creditAppliedCents: scenario.payment?.creditAppliedCents ?? 0,
          additionalAmountCents: scenario.payment?.additionalAmountCents ?? 0,
          additionalPaymentStatus:
            scenario.payment?.additionalPaymentStatus ?? null,
          xeroInvoiceId:
            scenario.payment?.xeroInvoiceId === undefined
              ? "xero-invoice-1"
              : scenario.payment.xeroInvoiceId,
          manuallyMarkedPaidAt: scenario.payment?.manuallyMarkedPaidAt ?? null,
        };

  vi.mocked(prisma.booking.findUnique).mockResolvedValue(
    booking as never,
  );
  vi.mocked(prisma.payment.findUnique).mockResolvedValue(payment as never);

  // The two authoritative credit reads share one Prisma call, so the stub branches
  // on the `where` each of them builds — which is also what pins that this module
  // really is calling both of them.
  vi.mocked(prisma.memberCredit.aggregate).mockImplementation((async (
    args: { where?: Record<string, unknown> },
  ) => {
    if (args?.where && "appliedToBookingId" in args.where) {
      // `deriveBookingAppliedCreditCents` negates and floors this sum.
      return {
        _sum: { amountCents: -(scenario.appliedCreditLedgerCents ?? 0) },
      };
    }
    return {
      _sum: { amountCents: scenario.memberCreditBalanceCents ?? 0 },
    };
  }) as never);

  vi.mocked(prisma.memberCredit.findMany).mockResolvedValue(
    (scenario.cancellationCredits ?? []).map((credit) => ({
      ...credit,
      type: credit.type ?? "CANCELLATION_REFUND",
    })) as never,
  );
  // `buildXeroActivityByRecord` keys on `localModel:localId`, so the fixture rows
  // have to carry the same two columns the screen's query selects.
  vi.mocked(prisma.xeroSyncOperation.findMany).mockResolvedValue(
    (scenario.xeroOperations ?? []).map((operation) => ({
      ...operation,
      localModel: "Payment",
      localId: payment?.id ?? PAYMENT_ID,
    })) as never,
  );
  vi.mocked(prisma.xeroObjectLink.findFirst).mockResolvedValue(
    (scenario.primaryInvoiceLink ? { id: "link-1" } : null) as never,
  );
  vi.mocked(prisma.paymentRecoveryOperation.findMany).mockResolvedValue(
    (scenario.recoveryOperations ?? []) as never,
  );
  vi.mocked(prisma.manualRefundTask.count).mockResolvedValue(
    (scenario.openManualRefundTasks ?? 0) as never,
  );
  vi.mocked(prisma.refundRequest.count).mockResolvedValue(
    (scenario.pendingRefundAppeals ?? 0) as never,
  );
}

async function readRow(): Promise<Record<string, unknown>> {
  const rows = await readBookingFinanceStateEvidence({ bookingId: BOOKING_ID });
  expect(rows).toHaveLength(1);
  return rows[0] as Record<string, unknown>;
}

function blockers(row: Record<string, unknown>): string[] {
  const codes = String(row.blocker_codes);
  return codes === "none" ? [] : codes.split(",");
}

beforeEach(() => {
  vi.clearAllMocks();
  globalClientReads.length = 0;
  recordingWindow.open = false;
  // The seam's transaction, doubled: the callback receives `txMock`, and the window
  // in which a global-client access counts as an escape is exactly the callback's
  // lifetime. `finally` closes it even when the source rejects, so a refusal test
  // does not leave the recorder on for the next one.
  prismaMock.$transaction.mockImplementation(
    async (callback: (tx: typeof txMock) => Promise<unknown>) => {
      recordingWindow.open = true;
      try {
        return await callback(txMock);
      } finally {
        recordingWindow.open = false;
      }
    },
  );
});

describe("booking finance state: absence and shape (#2377)", () => {
  it("returns NO rows for a booking that does not exist", async () => {
    // Zero rows is what the executor reports as `not_found` — "we looked and there
    // is nothing" — which is a different answer from a row full of zeroes.
    setup({ booking: null });
    await expect(
      readBookingFinanceStateEvidence({ bookingId: BOOKING_ID }),
    ).resolves.toEqual([]);
  });

  it("returns one row for a booking with NO payment, and says so", async () => {
    setup({ booking: {}, payment: null });
    const row = await readRow();
    expect(row.payment_ref).toBeNull();
    expect(row.payment_status).toBeNull();
    expect(blockers(row)).toContain("payment_record_missing");
    // Nothing was captured, so the whole price is outstanding.
    expect(row.amount_due_cents).toBe(10_000);
    expect(row.amount_paid_cents).toBe(0);
    expect(row.outstanding_cents).toBe(10_000);
  });

  it("rejects rather than returning a partial row when a read fails", async () => {
    // The executor turns a rejection into `evidence_unavailable` and no rows. A
    // finance state assembled from some of its inputs would read as authoritative.
    setup({ booking: {} });
    vi.mocked(prisma.xeroSyncOperation.findMany).mockRejectedValue(
      new Error("database unreachable"),
    );
    await expect(
      readBookingFinanceStateEvidence({ bookingId: BOOKING_ID }),
    ).rejects.toThrow();
  });
});

describe("booking finance state: integer-cent arithmetic (#2377)", () => {
  it("is exact on a fully paid booking with no credit", async () => {
    setup({
      booking: { finalPriceCents: 10_000 },
      payment: { amountCents: 10_000, status: "SUCCEEDED" },
    });
    const row = await readRow();
    expect(row.amount_due_cents).toBe(10_000);
    expect(row.amount_paid_cents).toBe(10_000);
    expect(row.credit_applied_cents).toBe(0);
    expect(row.outstanding_cents).toBe(0);
    expect(row.ledger_variance_cents).toBe(0);
    expect(row.credit_ledger_variance_cents).toBe(0);
    expect(blockers(row)).toEqual([]);
    expect(row.blocker_codes).toBe("none");
  });

  it("nets applied credit from the LEDGER, not the copy on the payment", async () => {
    // 10,000 due, 3,000 of member credit applied, 7,000 charged. Nothing outstanding.
    setup({
      booking: { finalPriceCents: 10_000 },
      payment: { amountCents: 7_000, creditAppliedCents: 3_000 },
      appliedCreditLedgerCents: 3_000,
    });
    const row = await readRow();
    expect(row.credit_applied_cents).toBe(3_000);
    expect(row.amount_paid_cents).toBe(7_000);
    expect(row.outstanding_cents).toBe(0);
    expect(row.ledger_variance_cents).toBe(0);
    expect(blockers(row)).toEqual([]);
  });

  it("reports a CENT-level ledger variance rather than rounding it away", async () => {
    // 10,001 due; 10,000 charged and 0 credit. One cent short, and the identity
    // `amount + credit + uncollected = final` is broken by exactly that cent.
    setup({
      booking: { finalPriceCents: 10_001 },
      payment: { amountCents: 10_000, creditAppliedCents: 0 },
    });
    const row = await readRow();
    expect(row.ledger_variance_cents).toBe(-1);
    expect(row.outstanding_cents).toBe(1);
    expect(blockers(row)).toContain("ledger_variance");
  });

  it("reports a TRUE OVERPAYMENT as a negative outstanding and a positive variance", async () => {
    // A true overpayment: nothing was refunded, no modification credit was issued,
    // and the price was never rewritten — so 12,000 really was captured against a
    // 10,000 booking and the write-time identity really is broken.
    //
    // The earlier version of this test used the SAME numbers with no refund and
    // called it an overpayment, which is also the exact shape of a perfectly
    // healthy repriced booking (see the reprice test below). It therefore
    // enshrined the defect rather than catching it: any implementation that
    // reported `ledger_variance` for a repriced booking passed it.
    setup({
      booking: { finalPriceCents: 10_000 },
      payment: { amountCents: 12_000, refundedAmountCents: 0 },
    });
    const row = await readRow();
    expect(row.amount_paid_cents).toBe(12_000);
    expect(row.outstanding_cents).toBe(-2_000);
    expect(row.ledger_variance_cents).toBe(2_000);
    expect(blockers(row)).toContain("ledger_variance");
  });

  it("nets REFUNDS out of what is outstanding on a booking repriced downward", async () => {
    // The case that made the old arithmetic dangerous. A paid $120 booking loses a
    // guest: `finalPriceCents` is rewritten to 8,000, `amountCents` stays at the
    // GROSS 12,000 captured (a refund never reduces it — see
    // `syncPaymentAggregate`), and the 4,000 difference is handed back. Nothing is
    // wrong with this row, and gross arithmetic reported it as a $40 overpayment
    // that a Finance Officer could refund a second time.
    setup({
      booking: { finalPriceCents: 8_000 },
      payment: {
        amountCents: 12_000,
        refundedAmountCents: 4_000,
        status: "PARTIALLY_REFUNDED",
      },
    });
    const row = await readRow();
    expect(row.amount_paid_cents).toBe(12_000);
    expect(row.refunded_amount_cents).toBe(4_000);
    expect(row.outstanding_cents).toBe(0);
    // The raw identity IS broken here, and reporting it as a finding would be
    // wrong: no writer re-establishes it after a post-payment reprice.
    expect(row.ledger_variance_cents).toBe(4_000);
    expect(blockers(row)).not.toContain("ledger_variance");
  });

  it("suppresses a ledger variance when a booking-modification CREDIT was issued", async () => {
    // The other half of the same reprice, for a booking whose difference was
    // settled as account credit rather than a card refund. `refundedAmountCents`
    // stays 0, so only the credit type distinguishes it from a real discrepancy.
    setup({
      booking: { finalPriceCents: 8_000 },
      payment: { amountCents: 12_000, refundedAmountCents: 0 },
      cancellationCredits: [
        {
          amountCents: 4_000,
          description: "Booking reduction credit for booking ABC",
          type: "BOOKING_MODIFICATION_REFUND",
        },
      ],
    });
    const row = await readRow();
    expect(row.ledger_variance_cents).toBe(4_000);
    expect(blockers(row)).not.toContain("ledger_variance");
  });

  it("still reports a variance when the only credit is a CANCELLATION refund", async () => {
    // A cancellation credit is not a reprice: `finalPriceCents` is untouched by
    // one, so the identity still describes the row and a break in it is real.
    setup({
      booking: { finalPriceCents: 10_000, status: "CONFIRMED" },
      payment: { amountCents: 12_000, refundedAmountCents: 0 },
      cancellationCredits: [
        {
          amountCents: 2_000,
          description: "Cancellation refund for booking ABC",
          type: "CANCELLATION_REFUND",
        },
      ],
    });
    expect(blockers(await readRow())).toContain("ledger_variance");
  });

  it("counts a REFUNDED payment's gross capture as paid", async () => {
    // `hasCapturedPayment` is the test, not `status === "SUCCEEDED"`. Money that
    // moved and came back still moved, and the refunded amount is reported beside
    // it rather than folded into the captured figure.
    for (const status of ["REFUNDED", "PARTIALLY_REFUNDED"] as const) {
      setup({
        booking: { finalPriceCents: 10_000, status: "CONFIRMED" },
        payment: { amountCents: 10_000, refundedAmountCents: 10_000, status },
      });
      const row = await readRow();
      expect(row.amount_paid_cents, status).toBe(10_000);
    }
  });

  it("reports an UNDERPAYMENT as an outstanding balance", async () => {
    setup({
      booking: { finalPriceCents: 10_000 },
      payment: { amountCents: 6_000 },
    });
    const row = await readRow();
    expect(row.outstanding_cents).toBe(4_000);
    expect(row.ledger_variance_cents).toBe(-4_000);
  });

  it("does not count an UNCAPTURED payment as paid", async () => {
    // A `PENDING` payment carries an amount, and treating it as money is the single
    // most expensive mistake this tool could make. `hasCapturedPayment` decides.
    setup({
      booking: { finalPriceCents: 10_000 },
      payment: { amountCents: 10_000, status: "PENDING" },
    });
    const row = await readRow();
    expect(row.amount_paid_cents).toBe(0);
    expect(row.outstanding_cents).toBe(10_000);
    expect(blockers(row)).toContain("payment_pending");
  });

  it("reports how much is still refundable, net of refunds already made", async () => {
    setup({
      booking: { finalPriceCents: 10_000 },
      payment: {
        amountCents: 10_000,
        refundedAmountCents: 2_500,
        status: "PARTIALLY_REFUNDED",
      },
    });
    const row = await readRow();
    expect(row.refunded_amount_cents).toBe(2_500);
    expect(row.remaining_refundable_cents).toBe(7_500);
  });

  it("never reports a negative refundable amount", async () => {
    setup({
      booking: { finalPriceCents: 10_000 },
      payment: {
        amountCents: 10_000,
        refundedAmountCents: 12_000,
        status: "REFUNDED",
      },
    });
    const row = await readRow();
    expect(row.remaining_refundable_cents).toBe(0);
  });

  it("counts an uncollected additional payment, and clears it once collected", async () => {
    setup({
      booking: { finalPriceCents: 12_000 },
      payment: {
        amountCents: 10_000,
        additionalAmountCents: 2_000,
        additionalPaymentStatus: "PENDING",
      },
    });
    const pending = await readRow();
    expect(pending.uncollected_additional_cents).toBe(2_000);
    expect(pending.ledger_variance_cents).toBe(0);
    expect(blockers(pending)).toContain("additional_payment_outstanding");

    setup({
      booking: { finalPriceCents: 12_000 },
      payment: {
        amountCents: 12_000,
        additionalAmountCents: 2_000,
        additionalPaymentStatus: "SUCCEEDED",
      },
    });
    const collected = await readRow();
    expect(collected.uncollected_additional_cents).toBe(0);
    expect(collected.ledger_variance_cents).toBe(0);
    expect(blockers(collected)).not.toContain("additional_payment_outstanding");
  });

  it("surfaces a disagreement between the payment's credit column and the ledger", async () => {
    // The discrepancy no screen shows: the denormalised copy says 3,000 and the
    // ledger says 2,500. Signed, in cents, and reported rather than reconciled.
    setup({
      booking: { finalPriceCents: 10_000 },
      payment: { amountCents: 7_000, creditAppliedCents: 3_000 },
      appliedCreditLedgerCents: 2_500,
    });
    const row = await readRow();
    expect(row.credit_ledger_variance_cents).toBe(500);
    expect(row.credit_applied_cents).toBe(2_500);
    expect(blockers(row)).toContain("credit_ledger_variance");
    // And the OUTSTANDING figure is netted against the LEDGER, not the payment's
    // copy: 10,000 due less 2,500 real credit less 7,000 captured leaves 500 owing.
    // Reading the denormalised column here would report 0 and tell a Finance
    // Officer the booking was square when the member still owes five dollars. A
    // mutation that swapped the two survived every other assertion in this file.
    expect(row.outstanding_cents).toBe(500);
  });

  it("reports the member's credit balance from the authoritative aggregate", async () => {
    setup({
      booking: { finalPriceCents: 10_000 },
      payment: { amountCents: 10_000 },
      memberCreditBalanceCents: 4_250,
    });
    const row = await readRow();
    expect(row.member_credit_balance_cents).toBe(4_250);
  });

  it("keeps every projected amount an integer", async () => {
    setup({
      booking: { finalPriceCents: 10_001 },
      payment: {
        amountCents: 3_333,
        refundedAmountCents: 1_111,
        creditAppliedCents: 3_334,
        additionalAmountCents: 777,
        additionalPaymentStatus: "PENDING",
        status: "PARTIALLY_REFUNDED",
      },
      appliedCreditLedgerCents: 3_334,
      memberCreditBalanceCents: 999,
    });
    const row = await readRow();
    for (const [key, value] of Object.entries(row)) {
      if (!key.endsWith("_cents")) continue;
      expect(Number.isInteger(value), `${key} = ${String(value)}`).toBe(true);
    }
  });
});

describe("booking finance state: blockers and their order (#2377)", () => {
  it("puts an EXHAUSTED refund first, ahead of bookkeeping problems", async () => {
    // A member is owed money and nothing automatic will move it. A missing Xero
    // invoice is bookkeeping; sending a Finance Officer to Xero first would be wrong.
    setup({
      booking: { finalPriceCents: 10_000, status: "CANCELLED" },
      payment: { amountCents: 10_000, xeroInvoiceId: null },
      recoveryOperations: [{ status: "FAILED", attempts: 5 }],
      xeroOperations: [
        { id: "op-1", status: "FAILED", createdAt: new Date("2026-08-01") },
      ],
    });
    const row = await readRow();
    expect(blockers(row)[0]).toBe("refund_execution_exhausted");
    expect(blockers(row)).toContain("xero_operation_failed");
    expect(row.blocker_count).toBe(blockers(row).length);
  });

  it("does not call a refund exhausted below the attempt ceiling", async () => {
    setup({
      booking: { finalPriceCents: 10_000 },
      payment: { amountCents: 10_000 },
      recoveryOperations: [{ status: "FAILED", attempts: 4 }],
    });
    const row = await readRow();
    expect(blockers(row)).not.toContain("refund_execution_exhausted");
    expect(blockers(row)).not.toContain("refund_execution_pending");
  });

  it("reports a queued refund as PENDING — money that has not moved", async () => {
    setup({
      booking: { finalPriceCents: 10_000 },
      payment: { amountCents: 10_000 },
      recoveryOperations: [{ status: "PROCESSING", attempts: 1 }],
    });
    expect(blockers(await readRow())).toContain("refund_execution_pending");
  });

  it("reports an open hand-back task and a pending member appeal separately", async () => {
    setup({
      booking: { finalPriceCents: 10_000 },
      payment: { amountCents: 10_000, source: "INTERNET_BANKING" },
      openManualRefundTasks: 1,
      pendingRefundAppeals: 1,
    });
    const codes = blockers(await readRow());
    expect(codes).toContain("manual_refund_open");
    expect(codes).toContain("refund_appeal_pending");
    // The two are never merged: one is money owed, the other is an undecided request.
    expect(codes.indexOf("manual_refund_open")).toBeLessThan(
      codes.indexOf("refund_appeal_pending"),
    );
  });

  it("reports a missing Xero invoice only once the booking has settled", async () => {
    setup({
      booking: { finalPriceCents: 10_000, status: "CONFIRMED" },
      payment: { amountCents: 10_000, xeroInvoiceId: null },
    });
    expect(blockers(await readRow())).toContain("xero_invoice_missing");

    setup({
      booking: { finalPriceCents: 10_000, status: "DRAFT" },
      payment: { amountCents: 10_000, xeroInvoiceId: null },
    });
    expect(blockers(await readRow())).not.toContain("xero_invoice_missing");
  });

  it("classifies Xero activity with the same states the admin screen uses", async () => {
    for (const [status, expected] of [
      ["FAILED", "operationFailed"],
      ["PARTIAL", "operationPartial"],
      ["PENDING", "operationPending"],
      ["WAITING_PAYMENT", "operationPending"],
    ] as const) {
      setup({
        booking: { finalPriceCents: 10_000 },
        payment: { amountCents: 10_000 },
        xeroOperations: [
          { id: "op-1", status, createdAt: new Date("2026-08-01") },
        ],
      });
      const row = await readRow();
      expect(row.xero_state, status).toBe(expected);
    }
  });

  it("excludes a Xero operation an administrator resolved by hand", async () => {
    // The query filters `manuallyResolvedAt: null`, exactly as the admin overview
    // does. Asserted on the query rather than the result, because the filter is what
    // stops a fixed problem being reported as a live one forever.
    setup({
      booking: { finalPriceCents: 10_000 },
      payment: { amountCents: 10_000 },
    });
    await readRow();
    const call = vi.mocked(prisma.xeroSyncOperation.findMany).mock.calls[0]?.[0];
    expect(call?.where).toMatchObject({ manuallyResolvedAt: null });
  });

  it("reads the Xero operations of the PAYMENT, keyed exactly as the screen keys them", async () => {
    // `Payment:{id}` and nothing else, which is how `listAdminPayments` scopes it.
    // The booking-scoped alternative an earlier revision also read matches nothing:
    // every writer on the booking-invoice path records `localModel: "Payment"`.
    setup({
      booking: { finalPriceCents: 10_000 },
      payment: { amountCents: 10_000 },
    });
    await readRow();
    const call = vi.mocked(prisma.xeroSyncOperation.findMany).mock.calls[0]?.[0];
    expect(call?.where?.localId).toBe(PAYMENT_ID);
    expect(call?.where?.localModel).toBe("Payment");
  });

  it("treats an ACTIVE primary-invoice LINK as an invoice, with no invoice id on the payment", async () => {
    // THE DIVERGENT STATE THIS PLATFORM NAMES `XERO_LINK_MISMATCH`. The link and
    // the payment column are written by separate steps of the invoice mint, so a
    // booking can hold the link and not the column, and this platform ships an
    // auto-applicable backfill for exactly that. Reading the column alone reported
    // `xero_invoice_missing` for a booking that HAS an invoice — and the next thing
    // an operator does about a missing invoice is raise a second one.
    setup({
      booking: { finalPriceCents: 10_000, status: "CONFIRMED" },
      payment: { amountCents: 10_000, xeroInvoiceId: null },
      primaryInvoiceLink: true,
    });
    const row = await readRow();
    expect(row.xero_state).toBe("invoiceLinked");
    expect(blockers(row)).not.toContain("xero_invoice_missing");

    // And with neither the column nor the link, it IS missing.
    setup({
      booking: { finalPriceCents: 10_000, status: "CONFIRMED" },
      payment: { amountCents: 10_000, xeroInvoiceId: null },
      primaryInvoiceLink: false,
    });
    expect(blockers(await readRow())).toContain("xero_invoice_missing");
  });

  it("queries the primary-invoice link with the same predicate every other surface uses", async () => {
    // #3467: the one reader asks the link only when the column is empty.
    setup({
      booking: { finalPriceCents: 10_000 },
      payment: { amountCents: 10_000, xeroInvoiceId: null },
    });
    await readRow();
    const call = vi.mocked(prisma.xeroObjectLink.findFirst).mock.calls[0]?.[0];
    expect(call?.where).toMatchObject({
      localModel: "Payment",
      localId: PAYMENT_ID,
      xeroObjectType: "INVOICE",
      role: "PRIMARY_INVOICE",
      active: true,
    });
  });

  it("reports the authoritative display label rather than inventing one", async () => {
    setup({
      booking: { finalPriceCents: 10_000, status: "CANCELLED" },
      payment: {
        amountCents: 10_000,
        refundedAmountCents: 10_000,
        status: "REFUNDED",
      },
      cancellationCredits: [
        {
          amountCents: 10_000,
          description: "Cancellation refund for booking ABC",
        },
      ],
    });
    const row = await readRow();
    // The label and the settlement kind both come from the shared helpers the
    // admin payments screen renders, so a diagnostic answer and the screen agree.
    expect(row.payment_display_label).toBe("Credit Issued");
    expect(row.settlement_kind).toBe("accountCredit");
  });

  it("never returns a credit DESCRIPTION, even though it reads one to classify", async () => {
    setup({
      booking: { finalPriceCents: 10_000, status: "CANCELLED" },
      payment: {
        amountCents: 10_000,
        refundedAmountCents: 10_000,
        status: "REFUNDED",
      },
      cancellationCredits: [
        {
          amountCents: 10_000,
          description:
            "Cancellation refund for booking ABC — member Jane Tramper, jane@example.org",
        },
      ],
    });
    const row = await readRow();
    for (const value of Object.values(row)) {
      if (typeof value !== "string") continue;
      expect(value).not.toContain("Jane Tramper");
      expect(value).not.toContain("example.org");
    }
  });

  it("emits blocker codes in the declared PRIORITY order", async () => {
    // The order is the product: several of these are true at once, and telling a
    // Finance Officer the Xero invoice is missing when a refund the platform owes
    // has exhausted its retries sends them to the wrong screen. The list is built
    // by filtering the catalogue, so the order is structural rather than an
    // accident of the order the predicates happen to be written in — this asserts
    // it end to end on a booking carrying six blockers at once.
    setup({
      booking: { finalPriceCents: 10_000, status: "CONFIRMED" },
      payment: {
        amountCents: 4_000,
        status: "PENDING",
        creditAppliedCents: 1_000,
        xeroInvoiceId: null,
      },
      appliedCreditLedgerCents: 500,
      recoveryOperations: [
        { status: "FAILED", attempts: 5 },
        { status: "PENDING", attempts: 1 },
      ],
      openManualRefundTasks: 1,
      pendingRefundAppeals: 1,
    });
    const codes = blockers(await readRow());
    expect(codes).toEqual([
      "refund_execution_exhausted",
      "refund_execution_pending",
      "manual_refund_open",
      "refund_appeal_pending",
      "xero_invoice_missing",
      "payment_pending",
      "ledger_variance",
      "credit_ledger_variance",
    ]);
  });

  it("flags a payment settled by hand, which has no card leg to refund", async () => {
    setup({
      booking: { finalPriceCents: 10_000 },
      payment: {
        amountCents: 10_000,
        source: "INTERNET_BANKING",
        manuallyMarkedPaidAt: new Date("2026-08-01"),
      },
    });
    const row = await readRow();
    expect(row.manually_marked_paid).toBe(true);
  });
});

describe("booking finance state: the booking LIFECYCLE (#2377)", () => {
  it.each(["CANCELLED", "BUMPED"] as const)(
    "does not dun a %s booking for an additional payment nothing zeroed",
    async (status) => {
      // Cancelling a booking leaves `additionalAmountCents` and
      // `additionalPaymentStatus` exactly as they were — nothing zeroes them — so a
      // money-only reading of those two columns reports a cancelled booking as
      // still owing. `isAdditionalPaymentOwed` conjoins the lifecycle half for
      // precisely this reason, and its own docblock names the chase email as the
      // surface that would otherwise dun a member for money they do not owe.
      setup({
        booking: { finalPriceCents: 12_000, status },
        payment: {
          amountCents: 10_000,
          additionalAmountCents: 2_000,
          additionalPaymentStatus: "PENDING",
        },
      });
      const row = await readRow();
      expect(row.uncollected_additional_cents).toBe(0);
      expect(blockers(row)).not.toContain("additional_payment_outstanding");
      // The LEDGER term keeps the money half, because the write-time identity is a
      // property of what was written and a cancellation does not rewrite it. So the
      // identity still holds over this row and no variance is manufactured.
      expect(row.ledger_variance_cents).toBe(0);
      expect(blockers(row)).not.toContain("ledger_variance");
      expect(row.booking_lifecycle_terminal).toBe(true);
    },
  );

  it("still reports an additional payment as owing on a CONFIRMED booking", async () => {
    setup({
      booking: { finalPriceCents: 12_000, status: "CONFIRMED" },
      payment: {
        amountCents: 10_000,
        additionalAmountCents: 2_000,
        additionalPaymentStatus: "PENDING",
      },
    });
    const row = await readRow();
    expect(row.uncollected_additional_cents).toBe(2_000);
    expect(blockers(row)).toContain("additional_payment_outstanding");
    expect(row.booking_lifecycle_terminal).toBe(false);
  });

  it("does not contradict itself on a booking CANCELLED before payment", async () => {
    // The authoritative display label says "Cancelled Before Payment"; the blocker
    // list used to say `payment_pending` and the outstanding figure used to say the
    // member owed the whole price. Both were answers to a question the booking no
    // longer has, and the spec bullet this tool leads with — "which condition is
    // definitely blocking completion" — has no meaning for a booking with no
    // completion to reach.
    setup({
      booking: { finalPriceCents: 10_000, status: "CANCELLED" },
      payment: { amountCents: 10_000, status: "PENDING", xeroInvoiceId: null },
    });
    const row = await readRow();
    expect(row.payment_display_label).toBe("Cancelled Before Payment");
    expect(row.booking_lifecycle_terminal).toBe(true);
    expect(row.outstanding_cents).toBe(0);
    expect(blockers(row)).not.toContain("payment_pending");
    // And a cancelled booking that was never charged is not missing an invoice
    // either: `isSettledBookingStatus` excludes CANCELLED.
    expect(blockers(row)).not.toContain("xero_invoice_missing");
  });

  it.each(["FAILED", "PROCESSING"] as const)(
    "suppresses payment-progress blocker %s on a cancelled booking",
    async (paymentStatus) => {
      setup({
        booking: { finalPriceCents: 10_000, status: "CANCELLED" },
        payment: { amountCents: 10_000, status: paymentStatus },
      });
      const codes = blockers(await readRow());
      expect(codes).not.toContain("payment_failed");
      expect(codes).not.toContain("payment_processing");
    },
  );

  it("still reports BOOKKEEPING blockers on a cancelled booking", async () => {
    // The suppression is narrow on purpose. A cancelled booking can still owe a
    // refund and can still be wrong in Xero, and those are the states an operator
    // most often opens a cancelled booking to investigate.
    setup({
      booking: { finalPriceCents: 10_000, status: "CANCELLED" },
      payment: { amountCents: 10_000, status: "SUCCEEDED" },
      openManualRefundTasks: 1,
      xeroOperations: [
        { id: "op-1", status: "FAILED", createdAt: new Date("2026-08-01") },
      ],
    });
    const codes = blockers(await readRow());
    expect(codes).toContain("manual_refund_open");
    expect(codes).toContain("xero_operation_failed");
  });
});

describe("booking finance state is read-only AT THE DATABASE (#2786)", () => {
  it("assembles inside ONE bounded read-only transaction", async () => {
    setup({ booking: {}, payment: {} });
    await readRow();

    // One transaction for the whole graph, not one per read. A second would take a
    // second pool connection and a second snapshot, which is exactly the shape
    // `docs/CONCURRENCY_AND_LOCKING.md` forbids and the reason `txMock` carries no
    // `$transaction` of its own.
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    expect(prismaMock.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({
        isolationLevel: "RepeatableRead",
        timeout: DIAGNOSTICS_READ_ONLY_TRANSACTION_TIMEOUT_MS,
      }),
    );
  });

  it("tells PostgreSQL to refuse writes before it reads anything", async () => {
    setup({ booking: {}, payment: {} });
    await readRow();

    expect(txMock.$executeRaw).toHaveBeenCalledTimes(2);
    expect(txMock.$executeRaw.mock.calls[0]?.[0]?.[0]).toBe(
      "SET TRANSACTION READ ONLY",
    );
    expect(txMock.$executeRaw.mock.calls[1]?.[1]).toBe(
      String(DIAGNOSTICS_READ_ONLY_STATEMENT_TIMEOUT_MS),
    );
  });

  it("reaches the global client for NOTHING once the transaction is open", async () => {
    // The assertion the mocks could not make. Eight reads in this module and two
    // authoritative credit helpers in `member-credit.ts` — which are deliberately
    // unmocked, and each of which falls back to the global client when it is not
    // handed one. Any of them escaping runs outside the snapshot AND outside the
    // statement timeout while every other expectation in this file still passes.
    setup({
      booking: {},
      payment: {},
      appliedCreditLedgerCents: -2_500,
      memberCreditBalanceCents: 4_000,
      cancellationCredits: [
        { amountCents: 2_500, description: "Cancellation refund for booking" },
      ],
      xeroOperations: [
        { id: "op-1", status: "SUCCESS", createdAt: new Date("2026-08-01") },
      ],
      primaryInvoiceLink: true,
      recoveryOperations: [{ status: "PENDING", attempts: 1 }],
      openManualRefundTasks: 1,
      pendingRefundAppeals: 1,
    });
    await readRow();

    expect(globalClientReads).toEqual([]);
  });

  it("keeps the recorder honest — the reads DID happen, on the transaction", async () => {
    // Non-vacuous: an empty escape list means "everything went through `tx`", never
    // "nothing ran". These are the same doubled functions either client would have
    // reached, so their call counts prove the graph executed.
    setup({ booking: {}, payment: {} });
    await readRow();

    expect(txMock.booking.findUnique).toHaveBeenCalledTimes(1);
    expect(txMock.payment.findUnique).toHaveBeenCalledTimes(1);
    expect(txMock.memberCredit.aggregate).toHaveBeenCalled();
    expect(txMock.refundRequest.count).toHaveBeenCalledTimes(1);
  });

  it("closes the recording window even when the read refuses", async () => {
    setup({ booking: {}, payment: {} });
    vi.mocked(prisma.xeroSyncOperation.findMany).mockRejectedValue(
      new Error("the database stopped answering"),
    );

    await expect(
      readBookingFinanceStateEvidence({ bookingId: BOOKING_ID }),
    ).rejects.toThrow();
    // A refusal must not leave the recorder armed, or the next invocation would
    // count this file's own fixture wiring as an escaped read.
    expect(recordingWindow.open).toBe(false);
  });
});
