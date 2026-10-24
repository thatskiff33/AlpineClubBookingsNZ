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
import { xeroInstant } from "@/lib/xero-provider-dates";

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

  return !(CANCELLED_CREDIT_NOTE_STATUSES as readonly string[]).includes(status.trim().toUpperCase());
}

/**
 * The two Xero statuses that cancel a credit note, as Xero spells them. A query
 * that filters links by their recorded status in SQL (#4162's voided
 * bank-transfer note scan) reads them from here, then re-checks each row with
 * `isRefundCreditNoteLinkCancelledInXero`.
 */
export const CANCELLED_CREDIT_NOTE_STATUSES = ["VOIDED", "DELETED"] as const;

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

/**
 * A payment's own refund-note links (`REFUND_CREDIT_NOTE`), active or not, as a
 * where fragment - the one filter the reads below share, and (#4231) the one
 * the booking repair's deploy-note SQL is pinned to.
 */
export const REFUND_CREDIT_NOTE_LINK_WHERE = {
  localModel: "Payment",
  xeroObjectType: "CREDIT_NOTE",
  role: "REFUND_CREDIT_NOTE",
} as const satisfies Prisma.XeroObjectLinkWhereInput;

/** #4288: the two roles of a payment's refund-note links - its own notes, and a refund request's (`INV-PAY-118`). */
export const REFUND_NOTE_LINK_ROLES = [REFUND_CREDIT_NOTE_LINK_WHERE.role, REFUND_REQUEST_CREDIT_NOTE_ROLE] as const;

/** #4288: `REFUND_CREDIT_NOTE_LINK_WHERE` as a predicate on a link (for `role`, either refund-note role; its own by default). */
export function isRefundNoteLinkOf(
  link: { localModel: string; xeroObjectType: string; role: string },
  role: (typeof REFUND_NOTE_LINK_ROLES)[number] = REFUND_CREDIT_NOTE_LINK_WHERE.role,
): boolean {
  return link.localModel === REFUND_CREDIT_NOTE_LINK_WHERE.localModel && link.xeroObjectType === REFUND_CREDIT_NOTE_LINK_WHERE.xeroObjectType && link.role === role;
}

/**
 * The refund-note links of one payment (or several), active or not: the one
 * fetch every reader below shares. #4288: optionally of one note only, and of
 * a refund request's role instead of the payment's own.
 */
async function readRefundNoteLinks(
  localId: string | { in: string[] },
  db: Pick<Prisma.TransactionClient, "xeroObjectLink">,
  only?: { xeroObjectId?: string; role?: (typeof REFUND_NOTE_LINK_ROLES)[number] },
) {
  return (await db.xeroObjectLink.findMany({
    // Only defined keys: an undefined `role` would drop the role filter, not keep the default.
    where: { ...REFUND_CREDIT_NOTE_LINK_WHERE, role: only?.role ?? REFUND_CREDIT_NOTE_LINK_WHERE.role, ...(only?.xeroObjectId !== undefined ? { xeroObjectId: only.xeroObjectId } : {}), localId },
    select: { localId: true, xeroObjectId: true, xeroObjectNumber: true, metadata: true, active: true },
  })) ?? [];
}

/**
 * The payment's refund notes, active or not, in one read on the caller's client:
 * its per-refund notes (#3880), the notes Xero recorded VOIDED/DELETED, which
 * are never re-adopted as its one refund note (`INV-ADDPAY-041`), and (#4250)
 * the notes with an active link - all from the same read, so a void landing
 * meanwhile never shows in one set and not another.
 */
export async function refundNoteIdSets(
  paymentId: string,
  db: Pick<Prisma.TransactionClient, "xeroObjectLink">,
): Promise<{ perDelta: Set<string>; cancelled: Set<string>; active: Set<string> }> {
  const links = await readRefundNoteLinks(paymentId, db);
  const idsWhere = (keep: (link: (typeof links)[number]) => boolean) =>
    new Set(links.filter(keep).map((link) => link.xeroObjectId));
  return {
    perDelta: idsWhere((link) => isPerDeltaRefundNoteLink(link.metadata)),
    cancelled: idsWhere((link) => isRefundCreditNoteLinkCancelledInXero(link.metadata)),
    active: idsWhere((link) => link.active === true),
  };
}

/**
 * For several payments at once (the booking repair's loader), from one read:
 * `refundNoteIdSets(...).cancelled`, and (#4231) the payments with any refund
 * note linked, active or not - a deactivated link is still a note Xero may
 * hold, so a refund request's own note is never offered beside it.
 */
export async function refundNoteSetsForPayments(
  paymentIds: readonly string[],
  db: Pick<Prisma.TransactionClient, "xeroObjectLink">,
): Promise<{ cancelled: Set<string>; notedPaymentIds: Set<string> }> {
  if (paymentIds.length === 0) return { cancelled: new Set(), notedPaymentIds: new Set() };
  const links = await readRefundNoteLinks({ in: [...paymentIds] }, db);
  return {
    cancelled: new Set(links.filter((link) => isRefundCreditNoteLinkCancelledInXero(link.metadata)).map((link) => link.xeroObjectId)),
    notedPaymentIds: new Set(links.map((link) => link.localId)),
  };
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
 * #4288 (owner decision 24 Oct 2026): the link-metadata key holding the Xero
 * `UpdatedDateUTC` of the snapshot whose status the link records, as an ISO
 * instant, or null when Xero sent none.
 */
export const REFUND_NOTE_SNAPSHOT_AT_KEY = "providerUpdatedAt";

/** The parts of a Xero credit note a link records as its snapshot. */
export interface XeroCreditNoteSnapshotSource {
  status?: unknown;
  total?: unknown;
  appliedAmount?: unknown;
  remainingCredit?: unknown;
  updatedDateUTC?: unknown;
}

/**
 * #4288: THE ONE SHAPE OF A XERO CREDIT-NOTE SNAPSHOT ON A LINK. Every writer
 * that records a status it read from Xero spreads this, so the status always
 * travels with the `UpdatedDateUTC` it was read at (`judgeRefundNoteWrite`
 * orders snapshots by it). `refund-note-snapshot-stamp-census.test.ts` fails a
 * credit-note link literal that names a status any other way.
 */
export function xeroCreditNoteSnapshotMetadata(note: XeroCreditNoteSnapshotSource) {
  return {
    status: note.status ?? null,
    total: note.total ?? null,
    appliedAmount: note.appliedAmount ?? null,
    remainingCredit: note.remainingCredit ?? null,
    [REFUND_NOTE_SNAPSHOT_AT_KEY]: xeroInstant(note.updatedDateUTC)?.toISOString() ?? null,
  };
}

/** #4288: the Xero `UpdatedDateUTC` a link's recorded snapshot was read at, or null (legacy rows, status-less writers). */
export function readRefundNoteSnapshotAt(metadata: unknown): Date | null {
  return xeroInstant(asRecord(metadata)?.[REFUND_NOTE_SNAPSHOT_AT_KEY]);
}

/**
 * What a refund-note link write does with the row it locked: write as asked;
 * keep the stored VOIDED/DELETED status under a write that names none (#4223);
 * or (#4288), because the write's own snapshot is stale, keep the stored
 * status, stamp and figures; the canonical rule (active flag, sibling
 * retirement) still applies.
 */
export type RefundNoteWriteVerdict = "apply" | "keep-stored-status" | "keep-stored-snapshot";

/**
 * #4223, #4288 (`INV-ADDPAY-041`, owner decision 24 Oct 2026): THE ONE ORDER
 * OF TWO WRITES TO ONE REFUND-NOTE LINK, judged on the row as stored under its
 * lock. Pure. In Xero a void is terminal - a note is never un-voided, and
 * re-crediting always raises a new note - so:
 * - a write naming no status keeps a stored void's status (#4223);
 * - a write naming VOIDED/DELETED is always applied;
 * - a live status never overwrites a stored VOIDED/DELETED, whatever either
 *   side's timestamp - with no timestamp on either side this is the decision's
 *   fallback, and with both it is the provider contract above;
 * - between two live snapshots, one whose `UpdatedDateUTC` is OLDER than the
 *   stored one's is not applied. Equal timestamps are the same snapshot and
 *   apply; a missing timestamp on either side applies.
 */
export function judgeRefundNoteWrite(incoming: unknown, stored: unknown): RefundNoteWriteVerdict {
  const storedStatus = readRefundCreditNoteLinkStatus(stored);
  if (storedStatus === null) return "apply";
  const storedVoid = !isIncludedRefundCreditNoteStatus(storedStatus);
  const incomingStatus = readRefundCreditNoteLinkStatus(incoming);
  if (incomingStatus === null) return storedVoid ? "keep-stored-status" : "apply";
  if (!isIncludedRefundCreditNoteStatus(incomingStatus)) return "apply";
  if (storedVoid) return "keep-stored-snapshot";
  const incomingAt = readRefundNoteSnapshotAt(incoming);
  const storedAt = readRefundNoteSnapshotAt(stored);
  return incomingAt !== null && storedAt !== null && incomingAt.getTime() < storedAt.getTime() ? "keep-stored-snapshot" : "apply";
}

/**
 * #4288: one note's refund-note row (by default the payment's own role) on each
 * of these payments, active or not, read NOW on the caller's client. A writer
 * that acts on a Xero reading after its link write - the inbound recount, its
 * allocation and refund-payment links - reads this at the point it acts, so a
 * void or a newer snapshot that committed since its own link write is what it
 * acts on, never a verdict it remembered from that write.
 */
export async function readRefundNoteRowsByPayment(
  creditNoteId: string,
  paymentIds: readonly string[],
  db: Pick<Prisma.TransactionClient, "xeroObjectLink">,
  role: (typeof REFUND_NOTE_LINK_ROLES)[number] = REFUND_CREDIT_NOTE_LINK_WHERE.role,
): Promise<Map<string, { active: boolean; metadata: unknown }>> {
  if (paymentIds.length === 0) return new Map();
  const rows = await readRefundNoteLinks({ in: [...new Set(paymentIds)] }, db, { xeroObjectId: creditNoteId, role });
  return new Map(rows.map((row) => [row.localId, { active: row.active, metadata: row.metadata }]));
}

/**
 * #4288: these links, less every one a payment holds through a refund-note row
 * (either role) for this note that is VOIDED/DELETED now, read fresh on the
 * caller's client. A live reading's allocation and refund-payment links are
 * written through this, so a void that won is never given them; any other
 * link passes untouched.
 */
export async function withoutVoidedRefundNoteLinks<L extends { localModel: string; localId: string; xeroObjectType: string; role: string }>(
  creditNoteId: string,
  links: readonly L[],
  db: Pick<Prisma.TransactionClient, "xeroObjectLink">,
): Promise<L[]> {
  const voided = new Set<string>();
  for (const role of REFUND_NOTE_LINK_ROLES) {
    const rows = await readRefundNoteRowsByPayment(creditNoteId, links.filter((link) => isRefundNoteLinkOf(link, role)).map((link) => link.localId), db, role);
    for (const [paymentId, row] of rows) if (isRefundCreditNoteLinkCancelledInXero(row.metadata)) voided.add(`${paymentId}:${role}`);
  }
  return links.filter((link) => !(REFUND_NOTE_LINK_ROLES.some((role) => isRefundNoteLinkOf(link, role)) && voided.has(`${link.localId}:${link.role}`)));
}

/**
 * #4288: a Xero reading of a refund note as its link write JUDGED it, read from
 * the row that write returned. The link funnel either applies the reading (its
 * status and `UpdatedDateUTC` are then the row's) or, when `judgeRefundNoteWrite`
 * keeps the stored snapshot, leaves the row as it was - and it keeps one only
 * when the row's status or timestamp differs from the reading's. So `stale` is
 * exactly "the reading was not applied" - in that write's own transaction,
 * where a writer whose keys must land with its reading (the hand-made note
 * answer) refuses on it. A writer that acts LATER, outside that transaction
 * (the inbound recount, its allocation and refund-payment links), reads the
 * row afresh instead (`readRefundNoteRowsByPayment`). `reading` is the
 * builder's shape (`xeroCreditNoteSnapshotMetadata`), which always carries the
 * timestamp's key, so an applied reading always overwrites the row's.
 */
export function judgedRefundNoteReading(reading: unknown, written: { metadata: unknown }) {
  const row = asRecord(written.metadata);
  const stale =
    readRefundCreditNoteLinkStatus(row) !== readRefundCreditNoteLinkStatus(reading) ||
    readRefundNoteSnapshotAt(row)?.getTime() !== readRefundNoteSnapshotAt(reading)?.getTime();
  return { stale };
}

/**
 * #4195, #4223, #4288 (`INV-ADDPAY-041`): THE ONE RULE FOR A REFUND-NOTE LINK
 * WRITE RACING ANOTHER, for both roles - the payment's own notes
 * (`REFUND_CREDIT_NOTE`, its one canonical note among them) and a refund
 * request's (`REFUND_REQUEST_CREDIT_NOTE`). Every such write first ensures an
 * inactive identity row, then locks it in the write's transaction, so the link
 * funnel takes that row before any sibling note's row or the Payment row, on
 * every write. It then re-reads the row under that lock and applies
 * `judgeRefundNoteWrite`: a void that committed while it waited is kept,
 * whether the write names no status (a retry's, a completion's, a repair's) or
 * an older live one (an inbound reconcile, the status recorder, a hand-made
 * note answer, each read from Xero outside any transaction): inactive, its
 * status on the row, where the funnel's void rules read it (no sibling
 * retired, a pointer naming it released without waiting on a busy Payment).
 */
export async function keepStoredRefundNoteVoid<L extends {
  localModel: string; localId: string; xeroObjectType: string; xeroObjectId: string; role: string; metadata?: unknown; active?: boolean; mergeMetadata?: boolean;
}>(client: Pick<Prisma.TransactionClient, "$executeRaw" | "xeroObjectLink">, link: L): Promise<L> {
  // INV-ADDPAY-041: a missing row cannot be locked. Reserve only its identity,
  // inactive, in this same write transaction. The existing unique key waits for
  // a competing first insertion to commit (or roll back); skipDuplicates leaves
  // an existing row untouched. Never commit this reservation on its own.
  await client.xeroObjectLink.createMany({
    data: [{
      localModel: link.localModel, localId: link.localId, xeroObjectType: link.xeroObjectType,
      xeroObjectId: link.xeroObjectId, role: link.role, active: false,
    }],
    skipDuplicates: true,
  });
  // Lock only (the #4161 heal's statement), then read through the model under it.
  await client.$executeRaw`
    SELECT 1 FROM "XeroObjectLink"
    WHERE "localModel" = ${link.localModel} AND "localId" = ${link.localId} AND "xeroObjectType" = ${link.xeroObjectType}
      AND "xeroObjectId" = ${link.xeroObjectId} AND "role" = ${link.role}
    FOR UPDATE`;
  const stored = await client.xeroObjectLink.findUnique({
    where: { localModel_localId_xeroObjectType_xeroObjectId_role: { localModel: link.localModel, localId: link.localId, xeroObjectType: link.xeroObjectType, xeroObjectId: link.xeroObjectId, role: link.role } },
    select: { metadata: true, active: true },
  });
  const verdict = judgeRefundNoteWrite(link.metadata, stored?.metadata);
  if (verdict === "apply") return link;
  if (verdict === "keep-stored-status") {
    // Preserve the stored figures and provenance even when the retry has some
    // metadata of its own. Its keys and the kept status merge over the locked row.
    return { ...link, active: false, metadata: { ...asRecord(link.metadata), status: readRefundCreditNoteLinkStatus(stored?.metadata) }, mergeMetadata: true };
  }
  // #4288: a stale snapshot writes nothing of its own: merging the stored
  // metadata over itself keeps the stored status, stamp and figures, and a
  // stored void stays inactive. The canonical rule (active flag, sibling
  // retirement) still applies to a stored live snapshot.
  return {
    ...link,
    active: isRefundCreditNoteLinkCancelledInXero(stored?.metadata) ? false : stored?.active,
    metadata: asRecord(stored?.metadata) ?? {},
    mergeMetadata: true,
  };
}

/** The payment's refund-request note links (`INV-PAY-118`), any request's, active or not. */
async function readRefundRequestNoteLinks(paymentId: string, db: Pick<Prisma.TransactionClient, "xeroObjectLink">) {
  return readRefundNoteLinks(paymentId, db, { role: REFUND_REQUEST_CREDIT_NOTE_ROLE });
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
  const create = await readRefundNoteRaisingRow(paymentId, link.xeroObjectId, db);
  const payload = asRecord(create?.requestPayload);
  if (field === "watermarkCents") return readNumber(payload?.watermarkCents);
  return readNumber(payload?.refundAmountCents) ?? providerAmountToCents(asRecord(payload?.allocation)?.amount);
}

/**
 * THE ROW THAT RAISED A NOTE: the oldest credit-note create on the payment
 * naming it. A later row closed as covered by it (`coveredByExistingNote`)
 * names it too, with its own enqueue figures, so oldest is the rule. One home
 * (#4162, `INV-SSOT-001`): the recorded figure above, and the voided
 * bank-transfer note scan's read of which hand-back a note recorded.
 */
export async function readRefundNoteRaisingRow(
  paymentId: string,
  creditNoteId: string,
  db: Pick<Prisma.TransactionClient, "xeroSyncOperation">,
) {
  return db.xeroSyncOperation.findFirst({
    where: { entityType: "CREDIT_NOTE", operationType: "CREATE", localModel: "Payment", localId: paymentId, xeroObjectId: creditNoteId },
    orderBy: { createdAt: "asc" },
    select: { id: true, requestPayload: true, correlationKey: true },
  });
}

/**
 * #4162 (money re-check): an outbound refund-note create that raised nothing -
 * it completed as covered by a note already on the payment
 * (`createXeroCreditNote`'s `coveredByExistingNote` answer), so the note it
 * names answers another refund, never the one this row was enqueued for.
 */
export function isCoveredByExistingNoteRow(row: { responsePayload: unknown }): boolean {
  return asRecord(row.responsePayload)?.coveredByExistingNote === true;
}

/**
 * #4162 (`INV-ADDPAY-042`): a refund note's recorded amount in cents - its
 * link's, else its raising row's - or null when neither records one. What the
 * nightly undo of a voided bank-transfer note takes back; null sends the note
 * to a person, never a guess.
 */
export function recordedRefundNoteAmountCents(
  paymentId: string,
  link: { xeroObjectId: string; metadata: unknown },
  db: Pick<Prisma.TransactionClient, "xeroSyncOperation">,
): Promise<number | null> {
  return recordedRefundNoteFigure(paymentId, link, "amountCents", db);
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
