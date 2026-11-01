/**
 * #3980 (review rounds 1 and 2): which edits a primary invoice's worth gap
 * belongs to, read at the gap check.
 *
 * The edits that settled against the primary invoice are marked
 * (`markedPrimaryInvoiceEditsWhere`). From them:
 *
 *  - THE RACING EDITS ({@link racingMarkedEdits}, round 2 F1): the marked edits
 *    the create's snapshot did not hold (`markedModificationIdsAtBuild`) - the
 *    ones that landed while it was in flight. An edit the snapshot held is
 *    already on the primary invoice's lines; anchoring a gap on it would bill a
 *    re-base's or a school naming's money (writers that mark nothing) as that
 *    old edit's. Where the create's operation is a replay of an earlier one
 *    (`replayCutoff`), an edit made before that earlier operation is no racing
 *    edit either.
 *  - THE ANCHOR of a shortfall's supplementary invoice
 *    ({@link primaryInvoiceGapAnchors}): a racing edit that moved money and has
 *    no edit-financial review. A $0 edit explains no gap, and a reviewed edit's
 *    review bills its share on a supplementary invoice anchored on that same
 *    edit (round 1 M3).
 *  - THE RACING REDUCTIONS ({@link racingReductionSettlement}): how the
 *    reductions behind an overcharge settled, so the treasurer accounts for any
 *    refund paid out. None when no reduction landed mid-create (round 2 M3).
 */
import type { Prisma } from "@prisma/client";
import { recordedPrimaryInvoiceSettlement, type PrimaryInvoiceEditSettlement } from "@/lib/booking-primary-invoice-claim";
import { prisma } from "@/lib/prisma";
import { asRecord } from "@/lib/xero-json";
import { markedPrimaryInvoiceEditsWhere } from "@/lib/xero-primary-invoice-read";
import { buildXeroBookingInvoiceCorrelationKey } from "@/lib/xero-booking-invoice-key";
import {
  parsePrimaryInvoiceFeeAtLink,
  PRIMARY_INVOICE_FEE_AT_LINK_KEY,
  type PrimaryInvoiceFeeAtLink,
} from "@/lib/xero-primary-invoice-fee-at-link";
import { XERO_OUTBOX_SUPPLEMENTARY_INVOICE_TYPE } from "@/lib/xero-operation-outbox-payload";

export type MarkedPrimaryInvoiceEdit = {
  id: string;
  priceDiffCents: number;
  changeFeeCents: number;
  newData: unknown;
  createdAt: Date;
};

/** The booking's marked edits, newest first. */
/** #3953: the reads below run on a caller's client where it passes one - a transaction, or the repair tool's. */
export type GapAnchorStore = Pick<
  Prisma.TransactionClient,
  "bookingModification" | "manualRefundTask" | "xeroSyncOperation" | "xeroObjectLink"
>;

export async function readMarkedPrimaryInvoiceEdits(
  bookingId: string,
  store: Pick<GapAnchorStore, "bookingModification"> = prisma,
): Promise<MarkedPrimaryInvoiceEdit[]> {
  return store.bookingModification.findMany({
    where: markedPrimaryInvoiceEditsWhere(bookingId),
    orderBy: { createdAt: "desc" },
    select: { id: true, priceDiffCents: true, changeFeeCents: true, newData: true, createdAt: true },
  });
}

/**
 * When the operation that stored these figures is a REPLAY - not the booking's
 * first invoice create operation - when that first one was made: an edit made
 * before it was read by the create that Xero's invoice came from. Null for a
 * first create, or when the figures' operation is not known.
 */
export async function primaryInvoiceReplayCutoff(
  bookingId: string,
  figuresOperationId: string | undefined,
  store: Pick<GapAnchorStore, "xeroSyncOperation"> = prisma,
): Promise<Date | null> {
  if (!figuresOperationId) return null;
  const first = await store.xeroSyncOperation.findFirst({
    where: {
      direction: "OUTBOUND",
      entityType: "INVOICE",
      operationType: "CREATE",
      correlationKey: buildXeroBookingInvoiceCorrelationKey(bookingId),
    },
    orderBy: { createdAt: "asc" },
    select: { id: true, createdAt: true },
  });
  return first && first.id !== figuresOperationId ? first.createdAt : null;
}

/**
 * The marked edits that landed while the create was in flight: not in its
 * snapshot, and not before the operation it replays. A record written before
 * the snapshot existed (`markedAtBuild` undefined) cannot tell, so every marked
 * edit counts, as before.
 */
export function racingMarkedEdits(
  marked: readonly MarkedPrimaryInvoiceEdit[],
  markedAtBuild: readonly string[] | undefined,
  replayCutoff: Date | null,
): MarkedPrimaryInvoiceEdit[] {
  const known = new Set(markedAtBuild ?? []);
  return marked.filter(
    (edit) => !known.has(edit.id) && (replayCutoff === null || edit.createdAt >= replayCutoff),
  );
}

/** The racing edits a shortfall may be anchored on, newest first. */
export async function primaryInvoiceGapAnchors(
  bookingId: string,
  racing: readonly MarkedPrimaryInvoiceEdit[],
  store: Pick<GapAnchorStore, "manualRefundTask"> = prisma,
): Promise<MarkedPrimaryInvoiceEdit[]> {
  const moved = racing.filter((edit) => edit.priceDiffCents !== 0 || edit.changeFeeCents !== 0);
  if (moved.length === 0) return [];
  const reviews = await store.manualRefundTask.findMany({
    where: { bookingId, kind: "EDIT_FINANCIAL_REVIEW" },
    select: { reviewContext: true },
  });
  const reviewed = new Set(
    reviews.flatMap((task) => {
      const id = asRecord(task.reviewContext)?.bookingModificationId;
      return typeof id === "string" ? [id] : [];
    }),
  );
  return moved.filter((edit) => !reviewed.has(edit.id));
}

/**
 * How the reductions behind an overcharge settled (round 1 M5): the racing
 * reductions only. Null when none landed mid-create - then the overcharge has
 * another cause (a replayed invoice, a writer that marks nothing) and the task
 * says nothing about a settlement (round 2 M3).
 */
export function racingReductionSettlement(
  racing: readonly MarkedPrimaryInvoiceEdit[],
): { modificationIds: string[]; settledBy: PrimaryInvoiceEditSettlement } | null {
  const reductions = racing.filter((edit) => edit.priceDiffCents + edit.changeFeeCents < 0);
  if (reductions.length === 0) return null;
  const settledBy = { refundAmountCents: 0, accountCreditAmountCents: 0, appliedCreditGivenBackCents: 0, unpaidAskOffsetCents: 0 };
  for (const edit of reductions) {
    const recorded = recordedPrimaryInvoiceSettlement(edit.newData);
    if (!recorded) continue;
    settledBy.refundAmountCents += recorded.refundAmountCents;
    settledBy.accountCreditAmountCents += recorded.accountCreditAmountCents;
    settledBy.appliedCreditGivenBackCents += recorded.appliedCreditGivenBackCents;
    settledBy.unpaidAskOffsetCents += recorded.unpaidAskOffsetCents;
  }
  return { modificationIds: reductions.map((edit) => edit.id), settledBy };
}

/**
 * The figures the create stored with this invoice's link (`persistPrimaryInvoiceLink`),
 * and the create operation that stored them; null for an invoice linked without them.
 */
export async function readPrimaryInvoiceFeeAtLink(
  bookingId: string,
  xeroInvoiceId: string,
  store: Pick<GapAnchorStore, "xeroSyncOperation"> = prisma,
): Promise<{ atLink: PrimaryInvoiceFeeAtLink; operationId: string } | null> {
  const operation = await store.xeroSyncOperation.findFirst({
    where: {
      direction: "OUTBOUND",
      entityType: "INVOICE",
      operationType: "CREATE",
      correlationKey: buildXeroBookingInvoiceCorrelationKey(bookingId),
      requestPayload: { path: [PRIMARY_INVOICE_FEE_AT_LINK_KEY, "xeroInvoiceId"], equals: xeroInvoiceId },
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, requestPayload: true },
  });
  const atLink = parsePrimaryInvoiceFeeAtLink(operation?.requestPayload, xeroInvoiceId);
  return operation && atLink ? { atLink, operationId: operation.id } : null;
}

/**
 * The gap's supplementary invoice on these anchors: its newest outbox
 * operation and any `SUPPLEMENTARY_INVOICE` link, active or not. A racing
 * edit raised no document of its own, so an invoice on one is the gap's
 * (`queuePrimaryInvoiceWorthGap`). #3953: the gap check and the late
 * capture's receipt ask this one question.
 */
export async function readGapInvoiceOnAnchors(
  anchorIds: readonly string[],
  store: Pick<GapAnchorStore, "xeroSyncOperation" | "xeroObjectLink"> = prisma,
) {
  if (anchorIds.length === 0) return { operation: null, link: null };
  const [operation, link] = await Promise.all([
    store.xeroSyncOperation.findFirst({
      where: {
        direction: "OUTBOUND",
        entityType: "INVOICE",
        operationType: "CREATE",
        queueType: XERO_OUTBOX_SUPPLEMENTARY_INVOICE_TYPE,
        localModel: "BookingModification",
        localId: { in: [...anchorIds] },
      },
      orderBy: { createdAt: "desc" },
      select: { id: true, status: true, requestPayload: true, responsePayload: true, manuallyResolvedAt: true },
    }),
    store.xeroObjectLink.findFirst({
      where: {
        localModel: "BookingModification",
        localId: { in: [...anchorIds] },
        xeroObjectType: "INVOICE",
        role: "SUPPLEMENTARY_INVOICE",
      },
      orderBy: [{ active: "desc" }, { createdAt: "desc" }],
      select: { id: true, xeroObjectId: true, active: true },
    }),
  ]);
  return { operation, link };
}

/**
 * #3953 (`INV-PAY-139`): the primary invoice's gap invoice, read from the
 * figures stored with its link exactly as the gap check reads them - the
 * racing edits, then the anchors - with the anchors it may bill for, or null
 * when no figures were stored or no anchor carries one.
 */
export async function findPrimaryInvoiceGapInvoice(
  bookingId: string,
  stored: { atLink: PrimaryInvoiceFeeAtLink; operationId: string },
  store: GapAnchorStore = prisma,
) {
  return (await readPrimaryInvoiceGapBilling(bookingId, stored, store)).gap;
}

/**
 * #4324 Codex re-review: the same reading as
 * {@link findPrimaryInvoiceGapInvoice}, keeping the racing edits it starts
 * from - the marked edits the primary was built WITHOUT (`racingKnown` false
 * where the create stored no snapshot, so it cannot tell).
 */
export async function readPrimaryInvoiceGapBilling(
  bookingId: string,
  stored: { atLink: PrimaryInvoiceFeeAtLink; operationId: string },
  store: GapAnchorStore = prisma,
) {
  const markedAtBuild = stored.atLink.worth?.markedModificationIdsAtBuild;
  const racing = racingMarkedEdits(
    await readMarkedPrimaryInvoiceEdits(bookingId, store),
    markedAtBuild,
    await primaryInvoiceReplayCutoff(bookingId, stored.operationId, store),
  );
  const anchorIds = (await primaryInvoiceGapAnchors(bookingId, racing, store)).map((anchor) => anchor.id);
  const found = await readGapInvoiceOnAnchors(anchorIds, store);
  return {
    racingKnown: Array.isArray(markedAtBuild),
    racingIds: racing.map((edit) => edit.id),
    gap: found.operation || found.link ? { ...found, anchorIds } : null,
  };
}

/**
 * #4324 Codex re-review (`INV-PAY-144`): DID THE PRIMARY INVOICE MISS THIS
 * MARKED CHANGE? #3980's settlement marker says the edit expected the primary
 * to bill it; one that raced the primary's create was billed by the gap
 * invoice instead, if at all. Read from the create's snapshot where it stored
 * one; where it did not, a gap invoice raised on anchors naming the change
 * (not withdrawn unsent) is the evidence.
 */
export function primaryInvoiceMissedChange(
  billing: Awaited<ReturnType<typeof readPrimaryInvoiceGapBilling>>,
  changeId: string,
): boolean {
  if (billing.racingKnown) return billing.racingIds.includes(changeId);
  const { gap } = billing;
  return Boolean(gap?.anchorIds.includes(changeId) && (gap.link !== null || gap.operation?.status !== "CANCELLED"));
}

/**
 * #4324 review N2 (`INV-PAY-144`, `INV-SSOT`): DOES THIS GAP INVOICE BILL THIS
 * CHANGE? Read from {@link findPrimaryInvoiceGapInvoice}'s own answer, the one
 * `readCaptureRecorder` targets a change's capture at: the change is one of its
 * racing anchors (any of them, not only the first it is anchored on), and the
 * invoice is in Xero (an active link) or may still get there (a row neither
 * CANCELLED nor finished). One that reached Xero and was voided there (link
 * deactivated, row SUCCEEDED or PARTIAL) bills nothing, and a receipt on it
 * would only be refused.
 */
export function primaryInvoiceGapBillsChange(
  gap: Awaited<ReturnType<typeof findPrimaryInvoiceGapInvoice>>,
  changeId: string,
): boolean {
  if (!gap || !gap.anchorIds.includes(changeId)) return false;
  if (gap.link?.active) return true;
  return gap.operation !== null && !["CANCELLED", "SUCCEEDED", "PARTIAL"].includes(gap.operation.status);
}
