// Which Xero credit-note statuses still count as refund coverage, and how a
// link's recorded status is read. ONE home, by design (#2901 review): every
// refund valuation — the inbound contribution math, the coverage sum behind
// the outbox enqueue/executor and the daily self-heal, canonical link cleanup,
// the drift report, and the operator repair — answers "does this note still
// count?" through these helpers, so no path can treat a VOIDED note as live
// coverage while its siblings do not. A pure leaf: import it from anywhere.
import type { Prisma } from "@prisma/client";
import { asRecord, readNumber, readString } from "@/lib/xero-json";
import { providerAmountToCents } from "@/lib/money-provider-amount";
import { readRefundRequestIdFromOperation, readRefundRequestIdFromPayload, REFUND_REQUEST_CREDIT_NOTE_ROLE } from "@/lib/refund-request-credit-note";

/**
 * True when a Xero credit-note status still contributes to refund coverage.
 * Unknown shapes (missing/non-string status) COUNT — outbound-created links
 * carry no status until inbound reconciliation or the operator status
 * recorder merges one, and their notes are live. Only an explicit
 * VOIDED/DELETED is excluded. Note the assumption this bakes in: a
 * non-cancelled recorded status (DRAFT, SUBMITTED, PAID, ...) counts as live
 * coverage. That is safe because the system only ever creates AUTHORISED
 * refund credit notes; a hand-crafted DRAFT note linked as refund coverage
 * would count here before it credits anything in Xero (#2901 stated limit).
 */
export function isIncludedRefundCreditNoteStatus(status: unknown) {
  if (typeof status !== "string") {
    return true;
  }

  const normalized = status.trim().toUpperCase();
  return normalized !== "VOIDED" && normalized !== "DELETED";
}

/** The link's recorded Xero status (uppercased), or null when never recorded. */
export function readRefundCreditNoteLinkStatus(metadata: unknown): string | null {
  const record = asRecord(metadata);
  const status = record ? readString(record.status) : null;
  return status ? status.trim().toUpperCase() : null;
}

/**
 * True when the link's recorded status says the Xero document was cancelled
 * (VOIDED/DELETED). False when no status was ever recorded — callers that
 * need "positively known live" must check `readRefundCreditNoteLinkStatus`
 * for null themselves.
 */
export function isRefundCreditNoteLinkCancelledInXero(metadata: unknown): boolean {
  const status = readRefundCreditNoteLinkStatus(metadata);
  return status !== null && !isIncludedRefundCreditNoteStatus(status);
}

/**
 * #3880: a refund note raised PER REFUND on a non-Stripe payment - a review's
 * bank-transfer hand-back on a cancelled booking, sized as a delta
 * (`createXeroCreditNote` stamps `perDelta` on its link). Like a Stripe delta
 * (#1162) it stays active beside its siblings, so coverage totals all of them,
 * and it is never the payment's ONE canonical note that its single-refund
 * callers (hold expiry, group cancel, a cancellation hand-back) dedupe on.
 */
export function isPerDeltaRefundNoteLink(metadata: unknown): boolean {
  return asRecord(metadata)?.perDelta === true;
}

/**
 * #3880 F1: the evidence for a payment's ONE canonical refund note with every
 * per-refund note left out - the field (`canonicalRefundNoteFromField`), its
 * links, and its create rows, which `createXeroCreditNote` stamps `perDelta` as
 * it stamps the link. The booking-repair pass resolves the field from this, so
 * a per-refund note is neither offered as the field nor read as a conflict.
 */
export function canonicalRefundNoteCandidates<
  L extends { role: string; xeroObjectId: string; metadata: unknown },
  O extends { requestPayload: unknown; xeroObjectId: string | null },
>(fieldNoteId: string | null | undefined, links: L[], operations: O[]) {
  const perDeltaIds = new Set(
    links.filter((link) => link.role === "REFUND_CREDIT_NOTE" && isPerDeltaRefundNoteLink(link.metadata)).map((link) => link.xeroObjectId),
  );
  return {
    fieldObjectId: canonicalRefundNoteFromField(fieldNoteId, perDeltaIds),
    links: links.filter((link) => !perDeltaIds.has(link.xeroObjectId)),
    operations: operations.filter(
      (operation) =>
        asRecord(operation.requestPayload)?.perDelta !== true && !(operation.xeroObjectId && perDeltaIds.has(operation.xeroObjectId)),
    ),
  };
}

/** The refund-note links of one payment (or several), active or not: the one fetch every reader below shares. */
async function readRefundNoteLinks(localId: string | { in: string[] }, db: Pick<Prisma.TransactionClient, "xeroObjectLink">) {
  return (await db.xeroObjectLink.findMany({
    where: { localModel: "Payment", localId, xeroObjectType: "CREDIT_NOTE", role: "REFUND_CREDIT_NOTE" },
    select: { xeroObjectId: true, metadata: true },
  })) ?? [];
}

/**
 * The payment's refund notes, active or not, in one read on the caller's client:
 * its per-refund notes (#3880), and the notes Xero recorded VOIDED/DELETED,
 * which are never re-adopted as its one refund note (`INV-ADDPAY-041`).
 */
export async function refundNoteIdSets(
  paymentId: string,
  db: Pick<Prisma.TransactionClient, "xeroObjectLink">,
): Promise<{ perDelta: Set<string>; cancelled: Set<string> }> {
  const links = await readRefundNoteLinks(paymentId, db);
  const idsWhere = (keep: (metadata: unknown) => boolean) =>
    new Set(links.filter((link) => keep(link.metadata)).map((link) => link.xeroObjectId));
  return { perDelta: idsWhere(isPerDeltaRefundNoteLink), cancelled: idsWhere(isRefundCreditNoteLinkCancelledInXero) };
}

/** `refundNoteIdSets(...).cancelled` for several payments at once (the booking repair's loader). */
export async function cancelledRefundNoteIds(
  paymentIds: readonly string[],
  db: Pick<Prisma.TransactionClient, "xeroObjectLink">,
): Promise<Set<string>> {
  if (paymentIds.length === 0) return new Set();
  const links = await readRefundNoteLinks({ in: [...paymentIds] }, db);
  return new Set(links.filter((link) => isRefundCreditNoteLinkCancelledInXero(link.metadata)).map((link) => link.xeroObjectId));
}

/**
 * #4195 (`INV-ADDPAY-041`, `INV-PAY-118`): ONE refund request's own notes on a
 * payment, active or not, matched on the request its link records. `live` is
 * the note that covers the request; `cancelledIds` (sorted) are those Xero
 * recorded VOIDED/DELETED, which the request never re-adopts, even on a mirror
 * still active from before #4195 - it raises a fresh note instead.
 */
export async function refundRequestOwnNotes(
  paymentId: string,
  refundRequestId: string,
  db: Pick<Prisma.TransactionClient, "xeroObjectLink">,
) {
  const own = (await readRefundRequestNoteLinks(paymentId, db)).filter(
    (link) => readRefundRequestIdFromPayload(link.metadata) === refundRequestId,
  );
  return {
    live: own.find((link) => link.active && !isRefundCreditNoteLinkCancelledInXero(link.metadata)) ?? null,
    cancelledIds: own.filter((link) => isRefundCreditNoteLinkCancelledInXero(link.metadata)).map((link) => link.xeroObjectId).sort(),
  };
}

/**
 * #4195, #4214 (owner decision: the officer re-raises): true when a refund
 * request raised a note that Xero has since voided and no live note of its own
 * replaces it, read from the booking repair's rows and its ACTIVE links (an
 * inactive request mirror is one a void wrote off). Such a request is never
 * re-raised automatically.
 */
export function refundRequestNoteVoidedWithNoLive(
  refundRequestId: string,
  operations: ReadonlyArray<{ entityType: string; operationType: string; xeroObjectId: string | null; requestPayload: unknown; correlationKey?: string | null; idempotencyKey?: string | null }>,
  activeLinks: ReadonlyArray<{ xeroObjectType: string; role: string; xeroObjectId: string; metadata: unknown }>,
): boolean {
  const noteIds = new Set(
    operations
      .filter((op) => op.entityType === "CREDIT_NOTE" && op.operationType === "CREATE" && op.xeroObjectId && readRefundRequestIdFromOperation(op) === refundRequestId)
      .map((op) => op.xeroObjectId!),
  );
  const own = activeLinks.filter(
    (link) =>
      link.xeroObjectType === "CREDIT_NOTE" &&
      link.role === REFUND_REQUEST_CREDIT_NOTE_ROLE &&
      (readRefundRequestIdFromPayload(link.metadata) === refundRequestId || noteIds.has(link.xeroObjectId)),
  );
  const raised = noteIds.size > 0 || own.length > 0;
  return raised && !own.some((link) => !isRefundCreditNoteLinkCancelledInXero(link.metadata));
}

/** #4214 (owner decision): why no retry or requeue path re-raises a voided refund request note. */
export const VOIDED_REQUEST_NOTE_RETRY_REASON =
  "This refund request's own Xero credit note was voided in Xero and nothing live replaces it. An officer decides whether to raise a fresh note (#4214); no retry raises one.";

/**
 * #4195 review F-A, #4214 (owner decision: the officer re-raises): true when
 * this row is a refund request's own note create whose request's note Xero
 * voided with no live replacement (`refundRequestNoteVoidedWithNoLive`). The
 * retry, requeue and retry-all doors and the queued retry's worker refuse it,
 * whatever the row's state, so no retry raises a second credit after a void.
 */
export async function isRetryOfVoidedRefundRequestNote(
  operation: { localModel: string | null; localId: string | null; entityType: string; operationType: string; requestPayload: unknown; correlationKey?: string | null; idempotencyKey?: string | null },
  db: Pick<Prisma.TransactionClient, "xeroObjectLink" | "xeroSyncOperation">,
): Promise<boolean> {
  const refundRequestId = readRefundRequestIdFromOperation(operation);
  const paymentId = operation.localId;
  if (!refundRequestId || !paymentId || operation.localModel !== "Payment" || operation.entityType !== "CREDIT_NOTE" || operation.operationType !== "CREATE") {
    return false;
  }
  const operations = (await db.xeroSyncOperation.findMany({
    where: { localModel: "Payment", localId: paymentId, entityType: "CREDIT_NOTE", operationType: "CREATE", xeroObjectId: { not: null } },
    select: { entityType: true, operationType: true, xeroObjectId: true, requestPayload: true, correlationKey: true, idempotencyKey: true },
  })) ?? [];
  const activeLinks = (await readRefundRequestNoteLinks(paymentId, db))
    .filter((link) => link.active)
    .map((link) => ({ ...link, xeroObjectType: "CREDIT_NOTE", role: REFUND_REQUEST_CREDIT_NOTE_ROLE }));
  return refundRequestNoteVoidedWithNoLive(refundRequestId, operations, activeLinks);
}

/**
 * #4195, #4223 (`INV-ADDPAY-041`): THE ONE RULE FOR A REFUND-NOTE LINK WRITE
 * RACING AN INBOUND VOID, for both roles - the payment's own notes
 * (`REFUND_CREDIT_NOTE`, its one canonical note among them) and a refund
 * request's (`REFUND_REQUEST_CREDIT_NOTE`). Every such write first locks its
 * own link row in the write's transaction, so the link funnel takes that row
 * before any sibling note's row or the Payment row, on every write. A write
 * that names no Xero status (a retry's, a completion's, a repair's) then
 * re-reads the row under that lock, so a void that committed while it waited is
 * kept: inactive, its status on the row, where the funnel's void rules read it
 * (no sibling retired, a pointer naming it released). A write that names a
 * status is judged on it.
 */
export async function keepStoredRefundNoteVoid<L extends {
  localModel: string; localId: string; xeroObjectType: string; xeroObjectId: string; role: string; metadata?: unknown; active?: boolean; mergeMetadata?: boolean;
}>(client: Pick<Prisma.TransactionClient, "$executeRaw" | "xeroObjectLink">, link: L): Promise<L> {
  // Lock only (the #4161 heal's statement), then read through the model under it.
  await client.$executeRaw`
    SELECT 1 FROM "XeroObjectLink"
    WHERE "localModel" = ${link.localModel} AND "localId" = ${link.localId} AND "xeroObjectType" = ${link.xeroObjectType}
      AND "xeroObjectId" = ${link.xeroObjectId} AND "role" = ${link.role}
    FOR UPDATE`;
  if (readRefundCreditNoteLinkStatus(link.metadata) !== null) return link;
  const stored = await client.xeroObjectLink.findUnique({
    where: { localModel_localId_xeroObjectType_xeroObjectId_role: { localModel: link.localModel, localId: link.localId, xeroObjectType: link.xeroObjectType, xeroObjectId: link.xeroObjectId, role: link.role } },
    select: { metadata: true },
  });
  const status = readRefundCreditNoteLinkStatus(stored?.metadata);
  if (status === null || isIncludedRefundCreditNoteStatus(status)) return link;
  const metadata = asRecord(link.metadata);
  // A write with no metadata of its own (a covered retry's) merges the status
  // over the stored row, so no stored key moves and the status rides the write.
  return metadata
    ? { ...link, active: false, metadata: { ...metadata, status } }
    : { ...link, active: false, metadata: { status }, mergeMetadata: true };
}

/** The payment's refund-request note links (`INV-PAY-118`), any request's, active or not. */
async function readRefundRequestNoteLinks(paymentId: string, db: Pick<Prisma.TransactionClient, "xeroObjectLink">) {
  return (await db.xeroObjectLink.findMany({
    where: { localModel: "Payment", localId: paymentId, xeroObjectType: "CREDIT_NOTE", role: REFUND_REQUEST_CREDIT_NOTE_ROLE },
    select: { xeroObjectId: true, xeroObjectNumber: true, active: true, metadata: true },
  })) ?? [];
}

/**
 * What a refund note's idempotency key is built on: a watermark (v2), an amount
 * (v1), a close's own rows (v3), or (#4195) one refund request's own note.
 */
export type RefundNoteKeyScope =
  | { watermarkCents: number }
  | { amountCents: number }
  | { closeRowsWhere: Prisma.XeroSyncOperationWhereInput }
  | { refundRequestId: string };

/**
 * A refund-note link's recorded watermark or amount, or null when neither the
 * link nor its create row records it (`INV-ADDPAY-041` fails closed on null).
 * Inbound, backfilled and pre-#1162 links carry no figures; the create row's
 * payload does (`allocation.amount` in dollars, or the queued figures).
 */
async function recordedRefundNoteFigure(
  paymentId: string,
  link: { xeroObjectId: string; metadata: unknown },
  field: "watermarkCents" | "amountCents",
  db: Pick<Prisma.TransactionClient, "xeroSyncOperation">,
): Promise<number | null> {
  const onLink = readNumber(asRecord(link.metadata)?.[field]);
  if (onLink !== null) return onLink;
  // Oldest first: the row that raised the note. A later row closed as covered
  // by it carries its own enqueue figures, not the note's.
  const create = await db.xeroSyncOperation.findFirst({
    where: { entityType: "CREDIT_NOTE", operationType: "CREATE", localModel: "Payment", localId: paymentId, xeroObjectId: link.xeroObjectId },
    orderBy: { createdAt: "asc" },
    select: { requestPayload: true },
  });
  const payload = asRecord(create?.requestPayload);
  if (field === "watermarkCents") return readNumber(payload?.watermarkCents);
  return readNumber(payload?.refundAmountCents) ?? providerAmountToCents(asRecord(payload?.allocation)?.amount);
}

/**
 * `INV-ADDPAY-041`: the parts a refund note's key gains once the payment has a
 * voided refund note, `after-void:<sorted ids>`, so a reissue never sends a key
 * Xero has answered before. A void moves coverage, so a reissue's base can equal
 * the voided note's own key or a LIVE note's: the suffix names every refund
 * note, live or voided, whose recorded watermark (v2) or amount (v1) equals the
 * key's base - one whose figure cannot be recovered counts as equal (fail
 * closed) - or, once a "Paid another way" close has a voided note, every note
 * its own rows raised (v3). A lost attempt's own note has no link yet, so its
 * retry keeps its key; with no void the key is byte-identical. The one home
 * for the enqueue's correlation key and the executor's Xero key. A refund
 * request's key (#4195) names that request's own voided notes, each raised
 * under the request's one key before it.
 */
export async function refundNoteKeyAfterVoidParts(
  paymentId: string,
  scope: RefundNoteKeyScope,
  db: Pick<Prisma.TransactionClient, "xeroObjectLink" | "xeroSyncOperation">,
): Promise<string[]> {
  if ("refundRequestId" in scope) {
    const { cancelledIds } = await refundRequestOwnNotes(paymentId, scope.refundRequestId, db);
    return cancelledIds.length > 0 ? ["after-void", ...cancelledIds] : [];
  }
  const links = await readRefundNoteLinks(paymentId, db);
  const voided = links.filter((link) => isRefundCreditNoteLinkCancelledInXero(link.metadata));
  if (voided.length === 0) return [];
  const named: string[] = [];
  if ("closeRowsWhere" in scope) {
    const rows = (await db.xeroSyncOperation.findMany({ where: scope.closeRowsWhere, select: { xeroObjectId: true } })) ?? [];
    const own = new Set(rows.map((row) => row.xeroObjectId));
    if (voided.some((link) => own.has(link.xeroObjectId))) {
      named.push(...links.filter((link) => own.has(link.xeroObjectId)).map((link) => link.xeroObjectId));
    }
  } else {
    const [field, cents] = "watermarkCents" in scope ? (["watermarkCents", scope.watermarkCents] as const) : (["amountCents", scope.amountCents] as const);
    for (const link of links) {
      const recorded = await recordedRefundNoteFigure(paymentId, link, field, db);
      if (recorded === null || recorded === cents) named.push(link.xeroObjectId);
    }
  }
  const ids = [...new Set(named)].sort();
  return ids.length > 0 ? ["after-void", ...ids] : [];
}

/**
 * `INV-ADDPAY-041` defence in depth: throws, before anything is recorded, when
 * Xero answered a refund-note create with a note this payment must not take -
 * one Xero reports or a link records VOIDED/DELETED (a refund request's own
 * note's link too, #4195), or one another create row on this payment already
 * raised. No key reuse can then re-adopt or relabel a note; the row fails with
 * this message for an officer to read.
 */
export async function assertFreshRefundNoteFromCreate(
  paymentId: string,
  operationId: string,
  created: { creditNoteID: string; status?: unknown },
  db: Pick<Prisma.TransactionClient, "xeroObjectLink" | "xeroSyncOperation">,
): Promise<void> {
  const voidedInXero = typeof created.status === "string" && !isIncludedRefundCreditNoteStatus(created.status);
  if (
    voidedInXero ||
    (await refundNoteIdSets(paymentId, db)).cancelled.has(created.creditNoteID) ||
    (await readRefundRequestNoteLinks(paymentId, db)).some(
      (link) => link.xeroObjectId === created.creditNoteID && isRefundCreditNoteLinkCancelledInXero(link.metadata),
    )
  ) {
    throw new Error(
      `Refusing to record Xero credit note ${created.creditNoteID} for payment ${paymentId}: Xero answered with a VOIDED or DELETED note, which is never re-adopted (INV-ADDPAY-041). Check the note in Xero before retrying.`,
    );
  }
  const other = await db.xeroSyncOperation.findFirst({
    where: { entityType: "CREDIT_NOTE", operationType: "CREATE", localModel: "Payment", localId: paymentId, xeroObjectId: created.creditNoteID, id: { not: operationId } },
    select: { id: true },
  });
  if (other) {
    throw new Error(
      `Refusing to record Xero credit note ${created.creditNoteID} for payment ${paymentId}: operation ${other.id} already raised it, so this create would relabel another refund's note (INV-ADDPAY-041). Check the note in Xero before retrying.`,
    );
  }
}

/** #3880: the payment's per-refund notes, active or not, read on the caller's client. */
export async function perDeltaRefundNoteIds(paymentId: string, db: Prisma.TransactionClient): Promise<Set<string>> {
  return (await refundNoteIdSets(paymentId, db)).perDelta;
}

/**
 * #3880: THE PAYMENT'S ONE CANONICAL REFUND NOTE, as `Payment.xeroRefundCreditNoteId`
 * records it: the field, unless it names a per-refund note, which is never
 * canonical. Every reader of the field that dedupes on it or retires siblings
 * for it asks here, so a field an older writer pointed at a per-refund note
 * cannot hide the cancellation's own note.
 */
export function canonicalRefundNoteFromField(
  fieldNoteId: string | null | undefined,
  perDeltaNoteIds: ReadonlySet<string>,
): string | null {
  return fieldNoteId && !perDeltaNoteIds.has(fieldNoteId) ? fieldNoteId : null;
}

/** The notes that are never the payment's one refund note: per-refund (#3880) and voided (`INV-ADDPAY-041`). */
export async function neverCanonicalRefundNoteIds(paymentId: string, db: Pick<Prisma.TransactionClient, "xeroObjectLink">) {
  const { perDelta, cancelled } = await refundNoteIdSets(paymentId, db);
  return new Set([...perDelta, ...cancelled]);
}

/** #3880: `canonicalRefundNoteFromField`, never a per-refund or (`INV-ADDPAY-041`) voided note, on the caller's client. */
export async function readCanonicalRefundNoteField(
  payment: { id: string; xeroRefundCreditNoteId: string | null } | null | undefined,
  db: Prisma.TransactionClient,
): Promise<string | null> {
  if (!payment?.xeroRefundCreditNoteId) return null;
  return canonicalRefundNoteFromField(payment.xeroRefundCreditNoteId, await neverCanonicalRefundNoteIds(payment.id, db));
}

/**
 * Whether a note may be written into `Payment.xeroRefundCreditNoteId`: never a
 * per-refund one (#3880), and never one Xero voided (`INV-ADDPAY-041`).
 */
export async function mayRecordAsCanonicalRefundNote(
  paymentId: string,
  creditNoteId: string,
  db: Prisma.TransactionClient,
): Promise<boolean> {
  return !(await neverCanonicalRefundNoteIds(paymentId, db)).has(creditNoteId);
}
