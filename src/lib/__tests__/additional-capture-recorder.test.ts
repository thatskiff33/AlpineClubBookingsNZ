/**
 * #3953 review round 1 (`INV-PAY-139`): one recorder per capture. The primary
 * invoice's create, the #3980 gap invoice, a change's own supplementary
 * invoice and a capture's own receipt each know which captures they record,
 * and every other writer stands down for those.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readPrimaryInvoiceFeeAtLink: vi.fn(),
  findPrimaryInvoiceGapInvoice: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/xero-primary-invoice-gap-anchors", () => ({
  readPrimaryInvoiceFeeAtLink: mocks.readPrimaryInvoiceFeeAtLink,
  findPrimaryInvoiceGapInvoice: mocks.findPrimaryInvoiceGapInvoice,
}));

import {
  attributeGapCash,
  creditReleaseShareOverlaps,
  gapPaymentMayBeInXero,
  gapRowCanStillSend,
  GAP_SEND_WAIT_MS,
  readCapturedStripeCash,
  readCaptureRecorder,
  readRecordedByPrimaryOrGap,
  readSupplementaryRecordedIntents,
} from "@/lib/additional-capture-recorder";
import { intentsRecordedByPrimaryCash } from "@/lib/xero-primary-invoice-fee-at-link";
import { primaryInvoiceGapPayload } from "@/lib/additional-capture-receipt-payload";

describe("intentsRecordedByPrimaryCash (F)", () => {
  const captures = [
    { paymentIntentId: "pi_primary", netCents: 30_000 },
    { paymentIntentId: "pi_change", netCents: 8_000 },
  ];

  it("covers the snapshot's captures oldest first, wholly, while the recorded cash lasts", () => {
    expect(intentsRecordedByPrimaryCash(captures, 38_000)).toEqual({ recorded: ["pi_primary", "pi_change"], partial: null });
  });

  it("MUTATION: a replay whose invoice Xero recorded at an earlier $300 covers only the booking's own capture", () => {
    expect(intentsRecordedByPrimaryCash(captures, 30_000)).toEqual({ recorded: ["pi_primary"], partial: null });
  });

  it("names the capture it reached part of, and how much", () => {
    expect(intentsRecordedByPrimaryCash(captures, 35_000)).toEqual({
      recorded: ["pi_primary"],
      partial: { paymentIntentId: "pi_change", cents: 5_000 },
    });
    expect(intentsRecordedByPrimaryCash(captures, 0)).toEqual({ recorded: [], partial: null });
  });
});

describe("attributeGapCash (A)", () => {
  const captures = [
    { paymentIntentId: "pi_primary", netCents: 30_000, sweptCents: 0 },
    { paymentIntentId: "pi_change", netCents: 8_000, sweptCents: 0 },
  ];

  it("pays the gap from the cash the primary left, naming the capture it came from", () => {
    expect(attributeGapCash({ captures, claimed: new Set(), primaryCashCents: 30_000, gapCents: 8_000 })).toEqual({
      leftoverCents: 8_000,
      covered: [{ paymentIntentId: "pi_change", cents: 8_000 }],
    });
  });

  it("MUTATION: never from a capture a receipt row claimed - then the gap is raised unpaid", () => {
    expect(attributeGapCash({ captures, claimed: new Set(["pi_change"]), primaryCashCents: 30_000, gapCents: 8_000 })).toEqual({
      leftoverCents: 0,
      covered: [],
    });
  });

  it("takes all of its figure or none, oldest first", () => {
    expect(attributeGapCash({ captures, claimed: new Set(), primaryCashCents: 30_000, gapCents: 9_000 }).covered).toEqual([]);
    expect(attributeGapCash({ captures, claimed: new Set(), primaryCashCents: 25_000, gapCents: 6_000 })).toEqual({
      leftoverCents: 13_000,
      covered: [
        { paymentIntentId: "pi_primary", cents: 5_000 },
        { paymentIntentId: "pi_change", cents: 1_000 },
      ],
    });
  });

  it("MUTATION round 3 (F4): subtracts what the link stored the primary recorded, never re-walking the cash", () => {
    // The cash figure would cover both; the stored list says only the booking's own.
    expect(
      attributeGapCash({
        captures,
        claimed: new Set(),
        primaryCashCents: 38_000,
        recordedAtLink: { recorded: ["pi_primary"], partial: null },
        gapCents: 8_000,
      }),
    ).toEqual({ leftoverCents: 8_000, covered: [{ paymentIntentId: "pi_change", cents: 8_000 }] });
    expect(
      attributeGapCash({
        captures,
        claimed: new Set(),
        primaryCashCents: 0,
        recordedAtLink: { recorded: ["pi_primary"], partial: { paymentIntentId: "pi_change", cents: 5_000 } },
        gapCents: 3_000,
      }),
    ).toEqual({ leftoverCents: 3_000, covered: [{ paymentIntentId: "pi_change", cents: 3_000 }] });
  });

  describe("#4494: never from the credit-release sweep's share", () => {
    const linked = { recorded: ["pi_a"], partial: null };

    it("MUTATION: a release capture the sweep records in full pays nothing - the gap is raised unpaid", () => {
      expect(
        attributeGapCash({
          captures: [
            { paymentIntentId: "pi_a", netCents: 20_000, sweptCents: 0 },
            { paymentIntentId: "pi_release", netCents: 5_000, sweptCents: 5_000 },
          ],
          claimed: new Set(),
          primaryCashCents: 20_000,
          recordedAtLink: linked,
          gapCents: 3_000,
        }),
      ).toEqual({ leftoverCents: 0, covered: [] });
    });

    it("MUTATION: only the swept part of a mixed capture is excluded, never the whole capture", () => {
      expect(
        attributeGapCash({
          captures: [{ paymentIntentId: "pi_mixed", netCents: 10_000, sweptCents: 4_000 }],
          claimed: new Set(),
          primaryCashCents: 0,
          recordedAtLink: { recorded: [], partial: null },
          gapCents: 6_000,
        }),
      ).toEqual({ leftoverCents: 6_000, covered: [{ paymentIntentId: "pi_mixed", cents: 6_000 }] });
    });

    it("MUTATION: a swept figure larger than the net contributes nothing, never a negative", () => {
      expect(
        attributeGapCash({
          captures: [
            { paymentIntentId: "pi_held", netCents: 2_000, sweptCents: 5_000 },
            { paymentIntentId: "pi_b", netCents: 4_000, sweptCents: 0 },
          ],
          claimed: new Set(),
          // Walked: a negative figure would hand the primary 30.00 back and swallow pi_b's spare cash.
          primaryCashCents: 1_000,
          gapCents: 3_000,
        }),
      ).toEqual({ leftoverCents: 3_000, covered: [{ paymentIntentId: "pi_b", cents: 3_000 }] });
    });

    it("MUTATION: the legacy walk never hands the primary's cash to swept cents (taken out BEFORE the walk)", () => {
      // 60.00 of primary cash, walked oldest first. Taken out first, the release
      // capture absorbs only its 20.00 rest and the newer 40.00 is the primary's:
      // nothing is spare. Taken out after, the walk would spend 50.00 on it and
      // leave 30.00 of the newer capture looking spare.
      expect(
        attributeGapCash({
          captures: [
            { paymentIntentId: "pi_release", netCents: 5_000, sweptCents: 3_000 },
            { paymentIntentId: "pi_b", netCents: 4_000, sweptCents: 0 },
          ],
          claimed: new Set(),
          primaryCashCents: 6_000,
          gapCents: 3_000,
        }),
      ).toEqual({ leftoverCents: 0, covered: [] });
    });
  });

  it("marks the gap's payload with what it took, so the names survive its send", () => {
    expect(primaryInvoiceGapPayload({ coveredCaptures: [{ paymentIntentId: "pi_change", cents: 8_000 }] })).toEqual({
      primaryInvoiceGap: true,
      coveredPaymentIntentIds: ["pi_change"],
      coveredCaptureCents: { pi_change: 8_000 },
    });
    expect(primaryInvoiceGapPayload(undefined)).toEqual({});
  });
});

describe("readCaptureRecorder (B, C)", () => {
  /** What each of the recorder's three supplementary-invoice reads finds, answered by the query's shape. */
  let found: { naming: unknown; covering: unknown; own: unknown; kept?: unknown };
  const store = {
    xeroSyncOperation: {
      findFirst: vi.fn(async ({ where }: { where: { queueType?: string; localModel?: string; requestPayload?: { path: string[] } } }) =>
        where.queueType === "KEPT_LATE_CAPTURE_INVOICE"
          ? (found.kept ?? null)
          : where.localModel ? found.own : where.requestPayload?.path[0] === "paymentIntentId" ? found.naming : found.covering,
      ),
    },
    xeroObjectLink: { findFirst: vi.fn() },
    paymentTransaction: { findUnique: vi.fn(), findMany: vi.fn() },
    bookingModification: {},
    manualRefundTask: {},
  };
  const input = { bookingId: "booking_1", primaryInvoiceId: "inv_primary", paymentIntentId: "pi_change", bookingModificationId: "mod_change" };
  const figures = { operationId: "op_primary", atLink: { xeroInvoiceId: "inv_primary", paymentIntentIdsRecordedAtLink: ["pi_primary"] } };
  const read = () => readCaptureRecorder(input, store as never);
  const gapCovering = (cents: number) => ({
    id: "op_gap",
    requestPayload: { primaryInvoiceGap: true, coveredPaymentIntentIds: ["pi_change"], coveredCaptureCents: { pi_change: cents } },
  });

  beforeEach(() => {
    vi.clearAllMocks();
    found = { naming: null, covering: null, own: null };
    store.xeroObjectLink.findFirst.mockResolvedValue(null);
    store.paymentTransaction.findUnique.mockResolvedValue({ amountCents: 8_000, paymentId: "pay_1" });
    store.paymentTransaction.findMany.mockResolvedValue([]);
    mocks.readPrimaryInvoiceFeeAtLink.mockResolvedValue(figures);
    mocks.findPrimaryInvoiceGapInvoice.mockResolvedValue(null);
  });

  it("is the receipt where nothing else records the capture", async () => {
    await expect(read()).resolves.toEqual({ kind: "receipt", figures, gap: null, target: null, alreadyRecordedCents: 0 });
  });

  describe("a capture that collected credit-release money (#4253)", () => {
    const ledgerRow = (over: Record<string, unknown>) => ({
      id: "row",
      source: "STRIPE",
      status: "PENDING",
      reason: "credit_released_outside_app",
      amountCents: 4_000,
      carriedAskCents: 0,
      withdrawnAt: null,
      stripePaymentIntentId: "pi_release",
      ...over,
    });

    it("stands down where the sweep records all of it", async () => {
      store.paymentTransaction.findUnique.mockResolvedValue({ amountCents: 4_000, paymentId: "pay_1" });
      store.paymentTransaction.findMany.mockResolvedValue([ledgerRow({ id: "r1", status: "SUCCEEDED" })]);
      await expect(readCaptureRecorder({ ...input, paymentIntentId: "pi_release", bookingModificationId: null }, store as never)).resolves.toEqual({
        kind: "credit-release-sweep",
      });
    });

    it("records only the rest of a capture it shares with an edit's own money", async () => {
      store.paymentTransaction.findUnique.mockResolvedValue({ amountCents: 6_500, paymentId: "pay_1" });
      store.paymentTransaction.findMany.mockResolvedValue([
        ledgerRow({ id: "r1", status: "PENDING" }),
        ledgerRow({ id: "r2", reason: "edit_price_increase", amountCents: 6_500, carriedAskCents: 4_000, status: "SUCCEEDED", stripePaymentIntentId: "pi_edit" }),
      ]);
      const recorder = await readCaptureRecorder({ ...input, paymentIntentId: "pi_edit", bookingModificationId: null }, store as never);
      expect(recorder).toMatchObject({ kind: "receipt", alreadyRecordedCents: 4_000 });
    });

    it("stands down for a capture the sweep holds for an officer", async () => {
      store.paymentTransaction.findUnique.mockResolvedValue({ amountCents: 4_000, paymentId: "pay_1" });
      store.paymentTransaction.findMany.mockResolvedValue([ledgerRow({ id: "r1", status: "PARTIALLY_REFUNDED" })]);
      await expect(readCaptureRecorder({ ...input, paymentIntentId: "pi_release", bookingModificationId: null }, store as never)).resolves.toEqual({
        kind: "credit-release-sweep",
      });
    });
  });

  it("MUTATION round 4 (item 4): is the supplementary invoice naming the intent, read first and on its own, whatever a gap covers", async () => {
    found = { naming: { id: "op_named" }, covering: gapCovering(3_000), own: null };
    await expect(read()).resolves.toEqual({ kind: "supplementary-invoice", operationId: "op_named" });
    const [first] = store.xeroSyncOperation.findFirst.mock.calls.map((call) => call[0]);
    expect(first).toEqual({
      where: {
        queueType: "SUPPLEMENTARY_INVOICE",
        status: { not: "CANCELLED" },
        requestPayload: { path: ["paymentIntentId"], equals: "pi_change" },
      },
      orderBy: { createdAt: "desc" },
      select: { id: true, status: true, requestPayload: true, responsePayload: true, manuallyResolvedAt: true, localModel: true, localId: true },
    });
    expect(store.xeroSyncOperation.findFirst).toHaveBeenCalledTimes(1);
  });

  it("MUTATION round 5 (item 1): an UNPAID invoice naming the intent is the receipt's target, never its recorder", async () => {
    const repairInvoice = {
      id: "op_repair_invoice",
      status: "SUCCEEDED",
      requestPayload: { paymentIntentId: "pi_change", recordPayment: false },
      responsePayload: null,
      manuallyResolvedAt: null,
      localModel: "BookingModification",
      localId: "mod_change",
    };
    const repairLink = { id: "link_repair", xeroObjectId: "inv_repair", active: true };
    found.naming = repairInvoice;
    store.xeroObjectLink.findFirst.mockResolvedValueOnce(repairLink);
    // The operation the target carries: the row as read, without its anchor.
    const operation = {
      id: repairInvoice.id,
      status: repairInvoice.status,
      requestPayload: repairInvoice.requestPayload,
      responsePayload: repairInvoice.responsePayload,
      manuallyResolvedAt: repairInvoice.manuallyResolvedAt,
    };
    await expect(read()).resolves.toEqual({
      kind: "receipt",
      figures,
      gap: null,
      target: { kind: "CHANGE_INVOICE", operation, link: repairLink },
      alreadyRecordedCents: 0,
    });
    expect(store.xeroObjectLink.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ localModel: "BookingModification", localId: "mod_change", role: "SUPPLEMENTARY_INVOICE" }) }),
    );
  });

  it("MUTATION #4324 (INV-PAY-144): is the kept late capture's own invoice queued for it, before anything the primary or a gap took", async () => {
    found = { naming: null, covering: gapCovering(3_000), own: null, kept: { id: "op_kept" } };
    await expect(read()).resolves.toEqual({ kind: "kept-late-capture-invoice", operationId: "op_kept" });
    expect(store.xeroSyncOperation.findFirst).toHaveBeenCalledWith({
      where: {
        queueType: "KEPT_LATE_CAPTURE_INVOICE",
        status: { not: "CANCELLED" },
        requestPayload: { path: ["paymentIntentId"], equals: "pi_change" },
      },
      select: { id: true },
    });
    expect(mocks.readPrimaryInvoiceFeeAtLink).not.toHaveBeenCalled();
  });

  it("is the gap invoice where its payment took all of the capture", async () => {
    found.covering = gapCovering(8_000);
    await expect(read()).resolves.toEqual({ kind: "supplementary-invoice", operationId: "op_gap" });
  });

  it("round 10: reads the gap invoice's coverage from its QUEUED row in any status but CANCELLED - a FAILED row an officer's Retry replayed still counts", async () => {
    found.covering = gapCovering(8_000);
    await read();
    expect(store.xeroSyncOperation.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          queueType: "SUPPLEMENTARY_INVOICE",
          status: { not: "CANCELLED" },
          requestPayload: { path: ["coveredPaymentIntentIds"], array_contains: ["pi_change"] },
        },
      }),
    );
  });

  it("is the primary invoice where its recorded cash covered the capture", async () => {
    mocks.readPrimaryInvoiceFeeAtLink.mockResolvedValue({
      ...figures,
      atLink: { ...figures.atLink, paymentIntentIdsRecordedAtLink: ["pi_primary", "pi_change"] },
    });
    await expect(read()).resolves.toEqual({ kind: "primary-invoice" });
  });

  it("MUTATION: is the change's own supplementary invoice where that invoice records a payment and the gap does not bill the change", async () => {
    found.own = { id: "op_change_invoice", requestPayload: { recordPayment: true } };
    await expect(read()).resolves.toEqual({ kind: "supplementary-invoice", operationId: "op_change_invoice" });
    const ownRead = store.xeroSyncOperation.findFirst.mock.calls.map((call) => call[0]).find((args) => args.where.localModel);
    expect(ownRead?.where).toMatchObject({ localModel: "BookingModification", localId: "mod_change", status: { not: "CANCELLED" } });
  });

  it("MUTATION #3403 review 2 (F3): is the receipt where the change's own paid invoice names ANOTHER capture - the request that carried its balance", async () => {
    // A superseded ask's stale-tab capture: the change's invoice was moved onto, and paid by, the carrier.
    found.own = { id: "op_change_invoice", status: "SUCCEEDED", requestPayload: { recordPayment: true, paymentIntentId: "pi_carrier" } };
    store.xeroObjectLink.findFirst.mockResolvedValue({ id: "link_change", xeroObjectId: "inv_change", active: true });
    await expect(read()).resolves.toEqual({ kind: "receipt", figures, gap: null, target: null, alreadyRecordedCents: 0 });
    // Naming this capture, it still records it.
    found.own = { id: "op_change_invoice", status: "SUCCEEDED", requestPayload: { recordPayment: true, paymentIntentId: "pi_change" } };
    await expect(read()).resolves.toEqual({ kind: "supplementary-invoice", operationId: "op_change_invoice" });
  });

  it("is the receipt, against the gap invoice, where the capture's change is one the gap bills for", async () => {
    const gap = { operation: { id: "op_gap" }, link: { xeroObjectId: "inv_gap", active: true }, anchorIds: ["mod_change"] };
    mocks.findPrimaryInvoiceGapInvoice.mockResolvedValue(gap);
    await expect(read()).resolves.toEqual({
      kind: "receipt",
      figures,
      gap,
      target: { kind: "GAP_INVOICE", operation: gap.operation, link: gap.link },
      alreadyRecordedCents: 0,
    });
  });

  it("MUTATION round 3 (F1): is the receipt, against the change's own invoice, where that invoice was raised UNPAID", async () => {
    const own = { id: "op_change_invoice", status: "SUCCEEDED", requestPayload: { recordPayment: false } };
    const ownLink = { id: "link_change", xeroObjectId: "inv_change", active: true };
    found.own = own;
    store.xeroObjectLink.findFirst.mockResolvedValueOnce(ownLink);
    await expect(read()).resolves.toEqual({
      kind: "receipt",
      figures,
      gap: null,
      target: { kind: "CHANGE_INVOICE", operation: own, link: ownLink },
      alreadyRecordedCents: 0,
    });
  });

  it("MUTATION round 3 (F2): records the rest where the gap invoice's payment took only part of the capture", async () => {
    found.covering = gapCovering(3_000);
    await expect(read()).resolves.toMatchObject({ kind: "receipt", alreadyRecordedCents: 3_000 });
  });

  it("MUTATION round 4 (item 3): compares what the gap and the primary took against the GROSS capture, never net of a refund", async () => {
    // 80.00 captured, 30.00 refunded since, the gap took 50.00: net is covered,
    // gross is not, so the receipt records the 30.00 rest (the refund is its own note).
    store.paymentTransaction.findUnique.mockResolvedValue({ amountCents: 8_000 });
    found.covering = gapCovering(5_000);
    await expect(read()).resolves.toMatchObject({ kind: "receipt", alreadyRecordedCents: 5_000 });
    expect(store.paymentTransaction.findUnique).toHaveBeenCalledWith({
      where: { stripePaymentIntentId: "pi_change" },
      select: { amountCents: true },
    });

    // The gap's 50.00 and the primary's 30.00 make the whole gross 80.00: it stands down.
    mocks.readPrimaryInvoiceFeeAtLink.mockResolvedValue({
      ...figures,
      atLink: { ...figures.atLink, partiallyRecordedCaptureAtLink: { paymentIntentId: "pi_change", cents: 3_000 } },
    });
    await expect(read()).resolves.toEqual({ kind: "supplementary-invoice", operationId: "op_gap" });
  });

  it("adds the part the primary's payment reached to what is already recorded", async () => {
    mocks.readPrimaryInvoiceFeeAtLink.mockResolvedValue({
      ...figures,
      atLink: { ...figures.atLink, partiallyRecordedCaptureAtLink: { paymentIntentId: "pi_change", cents: 2_000 } },
    });
    await expect(read()).resolves.toMatchObject({ kind: "receipt", alreadyRecordedCents: 2_000 });
  });

  it("is the receipt, against the primary, where the gap bills another change (C)", async () => {
    const gap = { operation: { id: "op_gap" }, link: { xeroObjectId: "inv_gap", active: true }, anchorIds: ["mod_racing"] };
    mocks.findPrimaryInvoiceGapInvoice.mockResolvedValue(gap);
    await expect(read()).resolves.toEqual({ kind: "receipt", figures, gap, target: null, alreadyRecordedCents: 0 });
  });
});

describe("readSupplementaryRecordedIntents (round 3, F3)", () => {
  it("names the captures a supplementary invoice records - by its intent, or the change's own invoice that records a payment - never the gap's", async () => {
    const store = {
      xeroSyncOperation: {
        findMany: vi.fn().mockResolvedValue([
          { localModel: "BookingModification", localId: "mod_named", requestPayload: { paymentIntentId: "pi_named", recordPayment: true } },
          { localModel: "BookingModification", localId: "mod_paid", requestPayload: { paymentIntentId: null, recordPayment: true } },
          { localModel: "BookingModification", localId: "mod_unpaid", requestPayload: { paymentIntentId: null, recordPayment: false } },
          // Round 5: an unpaid invoice naming its intent records nothing either.
          { localModel: "BookingModification", localId: "mod_unpaid_named", requestPayload: { paymentIntentId: "pi_unpaid_named", recordPayment: false } },
          { localModel: "BookingModification", localId: "mod_gap", requestPayload: { primaryInvoiceGap: true, recordPayment: true } },
          // #3403 review 2 (F3): moved onto, and paid by, the request that carried its balance.
          { localModel: "BookingModification", localId: "mod_moved", requestPayload: { paymentIntentId: "pi_carrier", recordPayment: true } },
        ]),
      },
    };
    const recorded = await readSupplementaryRecordedIntents(
      "booking_1",
      [
        { paymentIntentId: "pi_named", bookingModificationId: null },
        { paymentIntentId: "pi_paid", bookingModificationId: "mod_paid" },
        { paymentIntentId: "pi_unpaid", bookingModificationId: "mod_unpaid" },
        { paymentIntentId: "pi_gap", bookingModificationId: "mod_gap" },
        { paymentIntentId: "pi_none", bookingModificationId: null },
        { paymentIntentId: "pi_unpaid_named", bookingModificationId: "mod_unpaid_named" },
        { paymentIntentId: "pi_superseded_ask", bookingModificationId: "mod_moved" },
        { paymentIntentId: "pi_carrier", bookingModificationId: "mod_carrier" },
      ],
      store as never,
    );
    expect([...recorded].sort()).toEqual(["pi_carrier", "pi_named", "pi_paid"]);
  });
});

describe("readCapturedStripeCash (#4494)", () => {
  const additional = (over: Record<string, unknown>) => ({
    id: "row",
    kind: "ADDITIONAL",
    source: "STRIPE",
    status: "SUCCEEDED",
    reason: "edit_price_increase",
    amountCents: 4_000,
    refundedAmountCents: 0,
    carriedAskCents: 0,
    withdrawnAt: null,
    stripePaymentIntentId: null as string | null,
    bookingModificationId: null,
    ...over,
  });
  // One payment's ledger, oldest first.
  const ledger = [
    additional({ id: "primary", kind: "PRIMARY", reason: null, amountCents: 30_000, stripePaymentIntentId: "pi_primary" }),
    // A release request paid on its own: all of it is the sweep's.
    additional({ id: "release", reason: "credit_released_outside_app", amountCents: 5_000, stripePaymentIntentId: "pi_release" }),
    // A release request an edit's request carried, paid together: 40.00 is the sweep's.
    additional({ id: "release_2", reason: "credit_released_outside_app", status: "PENDING", amountCents: 4_000 }),
    additional({ id: "mixed", amountCents: 10_000, carriedAskCents: 4_000, stripePaymentIntentId: "pi_mixed" }),
    // A release capture partly refunded: the sweep holds it, so all of its net is taken.
    additional({ id: "held", reason: "credit_released_outside_app", status: "PARTIALLY_REFUNDED", amountCents: 6_000, refundedAmountCents: 1_000, stripePaymentIntentId: "pi_held" }),
    // An edit's own capture: none of it.
    additional({ id: "edit", amountCents: 2_000, stripePaymentIntentId: "pi_edit", bookingModificationId: "mod_edit" }),
  ];
  const store = {
    paymentTransaction: {
      findMany: vi.fn(async ({ where }: { where: { kind?: string; payment?: unknown } }) =>
        where.kind === "ADDITIONAL"
          ? ledger.filter((row) => row.kind === "ADDITIONAL")
          : ledger.filter((row) => row.stripePaymentIntentId !== null),
      ),
      findUnique: vi.fn(async () => ({ paymentId: "pay_1" })),
    },
  };

  it("names each capture's swept cents through the credit-release share: all, part, held or none", async () => {
    const captures = await readCapturedStripeCash("booking_1", store as never);
    expect(captures.map(({ paymentIntentId, netCents, sweptCents }) => ({ paymentIntentId, netCents, sweptCents }))).toEqual([
      { paymentIntentId: "pi_primary", netCents: 30_000, sweptCents: 0 },
      { paymentIntentId: "pi_release", netCents: 5_000, sweptCents: 5_000 },
      { paymentIntentId: "pi_mixed", netCents: 10_000, sweptCents: 4_000 },
      { paymentIntentId: "pi_held", netCents: 5_000, sweptCents: 5_000 },
      { paymentIntentId: "pi_edit", netCents: 2_000, sweptCents: 0 },
    ]);
  });
});

describe("readRecordedByPrimaryOrGap and creditReleaseShareOverlaps (#4494)", () => {
  const gapRow = (status: string, cents?: number) => ({
    id: "op_gap",
    status,
    requestPayload: {
      primaryInvoiceGap: true,
      coveredPaymentIntentIds: ["pi_release"],
      ...(cents === undefined ? {} : { coveredCaptureCents: { pi_release: cents } }),
    },
  });
  let rows: Array<ReturnType<typeof gapRow>>;
  // Answers the reader's gap query the way PostgreSQL would: CANCELLED rows excluded by the filter it sends.
  const store = {
    xeroSyncOperation: {
      findFirst: vi.fn(async ({ where }: { where: { status?: { not?: string } } }) =>
        rows.find((row) => row.status !== where.status?.not) ?? null,
      ),
    },
    paymentTransaction: { findUnique: vi.fn(async () => ({ amountCents: 5_000 })) },
  };
  beforeEach(() => {
    rows = [];
  });

  it("reads the gap's cents beside the part the primary reached, and all of it for a legacy row", async () => {
    await expect(readRecordedByPrimaryOrGap("pi_release", null, store as never)).resolves.toEqual({ kind: "part", cents: 0 });
    rows = [gapRow("PENDING", 3_000)];
    await expect(readRecordedByPrimaryOrGap("pi_release", null, store as never)).resolves.toEqual({ kind: "part", cents: 3_000 });
    const atLink = { partiallyRecordedCaptureAtLink: { paymentIntentId: "pi_release", cents: 2_000 } } as never;
    await expect(readRecordedByPrimaryOrGap("pi_release", atLink, store as never)).resolves.toEqual({ kind: "gap-invoice", operationId: "op_gap" });
    rows = [gapRow("FAILED")];
    await expect(readRecordedByPrimaryOrGap("pi_release", null, store as never)).resolves.toEqual({ kind: "gap-invoice", operationId: "op_gap" });
  });

  it("#4494 fix round: says, for the sweep only, whether the gap row's payment can be in Xero yet and whether it can still send", async () => {
    const now = new Date("2026-07-01T00:00:00.000Z");
    const unsent = {
      ...gapRow("PENDING", 3_000),
      xeroObjectId: null,
      responsePayload: null,
      lastErrorCode: null,
      manuallyResolvedAt: null,
      localModel: null,
      localId: null,
      replayable: true,
      createdAt: new Date("2026-06-30T00:00:00.000Z"),
    };
    rows = [unsent as never];
    await expect(readRecordedByPrimaryOrGap("pi_release", null, store as never, { withGapSendState: { now } })).resolves.toEqual({
      kind: "part",
      cents: 3_000,
      gapSend: { operationId: "op_gap", mayBeInXero: false, canStillSend: true },
    });
    // The receipt's reading is unchanged: a queued gap's cents count, with no send state.
    await expect(readRecordedByPrimaryOrGap("pi_release", null, store as never)).resolves.toEqual({ kind: "part", cents: 3_000 });
  });

  it("MUTATION: ignores a CANCELLED gap row", async () => {
    rows = [gapRow("CANCELLED", 3_000)];
    await expect(readRecordedByPrimaryOrGap("pi_release", null, store as never)).resolves.toEqual({ kind: "part", cents: 0 });
  });

  it("overlaps where the sweep's share and what was recorded exceed the card, or the sweep holds a capture something recorded", () => {
    const share = (ownCents: number, held = false) => ({ ownCents, held });
    expect(creditReleaseShareOverlaps({ kind: "part", cents: 3_000 }, share(5_000), 5_000)).toBe(true);
    expect(creditReleaseShareOverlaps({ kind: "part", cents: 6_000 }, share(4_000), 10_000)).toBe(false);
    expect(creditReleaseShareOverlaps({ kind: "part", cents: 0 }, share(5_000), 5_000)).toBe(false);
    expect(creditReleaseShareOverlaps({ kind: "gap-invoice", operationId: "op_gap" }, share(1), 5_000)).toBe(true);
    expect(creditReleaseShareOverlaps({ kind: "gap-invoice", operationId: "op_gap" }, share(0), 5_000)).toBe(false);
    expect(creditReleaseShareOverlaps({ kind: "part", cents: 1 }, share(0, true), 5_000)).toBe(true);
    expect(creditReleaseShareOverlaps({ kind: "part", cents: 0 }, share(0, true), 5_000)).toBe(false);
  });
});

describe("gapPaymentMayBeInXero (#4494 fix round)", () => {
  const row = (over: Record<string, unknown>) => ({
    status: "FAILED",
    requestPayload: { primaryInvoiceGap: true, coveredPaymentIntentIds: ["pi_release"] },
    xeroObjectId: null,
    responsePayload: null,
    lastErrorCode: null,
    manuallyResolvedAt: null,
    localModel: "BookingModification",
    localId: "mod_gap",
    ...over,
  });
  const store = { xeroObjectLink: { findFirst: vi.fn() } };
  beforeEach(() => store.xeroObjectLink.findFirst.mockReset().mockResolvedValue(null));
  const ask = (over: Record<string, unknown>) => gapPaymentMayBeInXero(row(over) as never, store as never);

  it("is yes for a row that sent, went PARTIAL or was resolved by hand", async () => {
    await expect(ask({ status: "SUCCEEDED" })).resolves.toBe(true);
    await expect(ask({ status: "PARTIAL" })).resolves.toBe(true);
    await expect(ask({ manuallyResolvedAt: new Date("2026-06-30T00:00:00.000Z") })).resolves.toBe(true);
  });

  it("MUTATION: is yes for any evidence an attempt reached Xero", async () => {
    await expect(ask({ xeroObjectId: "inv_gap" })).resolves.toBe(true);
    await expect(ask({ responsePayload: { invoice: { invoices: [{ invoiceID: "inv_gap" }] } } })).resolves.toBe(true);
    await expect(ask({ responsePayload: { payment: { paymentID: "pay_gap" } } })).resolves.toBe(true);
    await expect(ask({ lastErrorCode: "ORPHANED_STALE_RUNNING" })).resolves.toBe(true);
    // Delta review d-1: a send stores the invoice body before any Xero call, so a payment that landed before its completion failed still counts.
    await expect(ask({ requestPayload: { primaryInvoiceGap: true, invoices: [{ type: "ACCREC" }] } })).resolves.toBe(true);
    store.xeroObjectLink.findFirst.mockResolvedValueOnce({ id: "link_gap" });
    await expect(ask({})).resolves.toBe(true);
  });

  it("is no only for a row that provably never reached Xero", async () => {
    await expect(ask({ responsePayload: { message: "Account code 200 has been archived" } })).resolves.toBe(false);
    await expect(ask({ status: "PENDING" })).resolves.toBe(false);
    await expect(ask({ status: "RUNNING", localModel: null })).resolves.toBe(false);
  });
});

describe("gapRowCanStillSend (#4494 delta review d-3)", () => {
  const now = new Date("2026-07-01T00:00:00.000Z");
  const queuedAgo = (ms: number) => new Date(now.getTime() - ms);
  const row = (over: Record<string, unknown>) => ({ status: "PENDING", replayable: true, manuallyResolvedAt: null, createdAt: queuedAgo(60_000), ...over }) as never;

  it("is yes while the row is queued, sending, waiting, or FAILED and still replayable, within the bound", () => {
    for (const status of ["PENDING", "RUNNING", "WAITING_PAYMENT", "FAILED"]) expect(gapRowCanStillSend(row({ status }), now)).toBe(true);
    expect(gapRowCanStillSend(row({ createdAt: queuedAgo(GAP_SEND_WAIT_MS) }), now)).toBe(true);
  });

  it("MUTATION: is no once it cannot send, or is past the bound", () => {
    expect(gapRowCanStillSend(row({ status: "FAILED", replayable: false }), now)).toBe(false);
    expect(gapRowCanStillSend(row({ manuallyResolvedAt: now }), now)).toBe(false);
    expect(gapRowCanStillSend(row({ createdAt: queuedAgo(GAP_SEND_WAIT_MS + 1) }), now)).toBe(false);
  });
});
