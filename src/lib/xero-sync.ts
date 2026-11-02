import { XERO_ACTIVE_OPERATION_STATUSES } from "./xero-active-operation-statuses";
import { PaymentSource, Prisma, type XeroSyncOperation } from "@prisma/client";
import { createHash } from "crypto";
import { prisma } from "./prisma";
import { asRecord, readString } from "./xero-json";
import {
  canonicalRefundNoteFromField,
  isPerDeltaRefundNoteLink,
  isRefundCreditNoteLinkCancelledInXero, isRefundNoteLinkOf, keepStoredRefundNoteVoid, REFUND_NOTE_LINK_ROLES,
  perDeltaRefundNoteIds,
  neverCanonicalRefundNoteIds,
  readCanonicalRefundNoteField,
} from "./xero-refund-note-status";
import { buildXeroObjectUrl, stripXeroOrgShortCode } from "./xero-links";
import { mergeXeroObjectLinkMetadata, planXeroObjectLinkMetadataMerge } from "./xero-object-link-metadata-merge";
import {
  redactSensitiveRecord,
  redactSensitiveText,
} from "./redact-sensitive-json";
import logger from "@/lib/logger";
import { isPrismaUniqueConstraintError } from "@/lib/prisma-errors";
import { providerAmountToCents } from "@/lib/money-provider-amount";
import type { XeroInvoiceEmailInstruction } from "@/lib/xero-invoice-email-instruction";
import { xeroSyncErrorFields } from "@/lib/xero-sync-error-text";
import { REFUND_REQUEST_CREDIT_NOTE_ROLE } from "@/lib/refund-request-credit-note";
import { isClosedByCreditSpentOutsideApp } from "@/lib/xero-operation-resolution";
import { outcomeWriteGuard, refusedOutcomeWrite, type XeroOperationClaim } from "@/lib/xero-operation-outcome-guard";
import { successAfterResolutionAlert } from "@/lib/xero-success-after-resolution-alert";

export interface XeroSyncOperationInput {
  direction: string;
  entityType: string;
  operationType: string;
  localModel?: string;
  localId?: string;
  status?: string;
  idempotencyKey?: string | null;
  correlationKey?: string | null;
  replayable?: boolean;
  requestPayload?: unknown;
  /**
   * The creation-time Xero-invoice-email delivery instruction for this
   * operation (#2929), or absent where the enqueuer has no such choice to
   * express — which is every enqueuer but the on-behalf booking create.
   *
   * Written once here and NEVER updated afterwards, for the same reason
   * `queueType` is: the handlers that rewrite `requestPayload` wholesale would
   * otherwise destroy it on the first provider round-trip. Typed rather than a
   * bare string so an enqueuer cannot invent a third value, and read back only
   * through `readXeroInvoiceEmailInstruction`.
   */
  invoiceEmailDelivery?: XeroInvoiceEmailInstruction | null;
  /**
   * The row's queue type when the payload does not name one — a handler that
   * opens its own operation with the execution-shape payload (#3535: the
   * clearing-note builder on a retry), so readers that select by the column
   * still see the row. The payload's own `queueType` wins when present.
   */
  queueType?: string | null;
  createdByMemberId?: string | null;
}

export interface XeroObjectLinkInput {
  localModel: string;
  localId: string;
  xeroObjectType: string;
  xeroObjectId: string;
  xeroObjectNumber?: string | null;
  xeroObjectUrl?: string | null;
  role: string;
  active?: boolean;
  metadata?: unknown;
  /**
   * F4 (#1354): merge the new metadata over the existing row's metadata
   * instead of replacing it wholesale. Inbound reconcile writes
   * {status,total,appliedAmount,remainingCredit} onto links whose outbound
   * writer stored {amountCents,watermarkCents} — a replace destroyed the
   * per-delta idempotency/covering inputs minutes after every refund credit
   * note was created.
   *
   * THE TEST IS "DOES ONE CALL KNOW THE WHOLE SHAPE?", NOT "IS THIS INBOUND?".
   * A writer composing its row's metadata in ONE call owns that shape and keeps
   * replace semantics, which is every outbound writer but one; inbound
   * reconcile is the original case because it writes half of a shape somebody
   * else wrote. The one OUTBOUND exception is deliberate (#3367): the school
   * contact-link writer in `organisation-xero-contact-persons.ts`, whose row
   * carries `linkedVia` written once at first link and a contact-persons
   * fingerprint rewritten on every refresh. Replacing would make the FIRST
   * refresh drop the provenance the adopted-contact reshape depends on, so
   * "correcting" it back on the strength of the general rule disables that
   * reshape without failing anything.
   *
   * #4445: the merge is one statement over the stored row, so two writers of
   * one link both keep their keys (`xero-object-link-metadata-merge.ts`).
   */
  mergeMetadata?: boolean;
}

export interface XeroSyncOperationCompletion {
  status?: string;
  responsePayload?: unknown;
  xeroObjectType?: string | null;
  xeroObjectId?: string | null;
  xeroObjectNumber?: string | null;
  xeroObjectUrl?: string | null;
  extraLinks?: XeroObjectLinkInput[];
  /** #4256: a non-SUCCEEDED row's message; else it keeps the one it had. */
  lastErrorMessage?: string;
}

export interface CanonicalPaymentRefundCreditNoteLink {
  xeroObjectId: string;
  xeroObjectNumber: string | null;
  source: "payment" | "refund_payment" | "operation" | "link";
}

const SINGLE_ACTIVE_CANONICAL_LINK_SCOPES = [
  { localModel: "Member", role: "CONTACT" },
  { localModel: "Payment", role: "PRIMARY_INVOICE" },
  { localModel: "MemberSubscription", role: "SUBSCRIPTION_INVOICE" },
] as const;

/**
 * The writer for `XeroSyncOperation.requestPayload` / `responsePayload` at
 * ~20 call sites, and for the metadata on `XeroObjectLink`.
 *
 * These are PERSISTED RECORDS, not log lines, and several of the callers are
 * read-modify-write cycles (`xero-applied-credit-deallocation.ts`,
 * `xero-contacts.ts`'s contact-repair requeue) that read the stored payload back
 * and persist it again — so anything cut here is cut permanently and cut again
 * on every subsequent pass. It therefore takes `redactSensitiveRecord`, which
 * applies the same redaction rules and the same circular guard (this function
 * had NO cycle protection at all before #2683) without the log depth cap that
 * was measured deleting `lineItems[].tracking` from an invoice update.
 */
export function sanitizeForJson(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined) {
    return undefined;
  }

  return JSON.parse(
    JSON.stringify(redactSensitiveRecord(value))
  ) as Prisma.InputJsonValue;
}

function normalizePayloadHashValue(value: unknown): unknown {
  if (value === undefined) {
    return undefined;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }

  if (Array.isArray(value)) {
    return value.map((entry) => normalizePayloadHashValue(entry));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .map(([key, entryValue]) => [key, normalizePayloadHashValue(entryValue)] as const)
      .filter(([, entryValue]) => entryValue !== undefined)
  );
}

/**
 * The short hash of an outbound Xero payload, feeding
 * `XeroSyncOperation.idempotencyKey` — and, through it, the `Idempotency-Key`
 * header Xero itself deduplicates on.
 *
 * ## Deliberately NOT routed through `stableDigest` (#3250/#3251/#3252)
 *
 * The sweep that gave deterministic identity one home left this one alone ON
 * PURPOSE, and this note exists so the next reader does not "finish the job".
 *
 * `stableDigest` sorts object keys recursively before hashing. This does not: it
 * preserves insertion order, deliberately. Every idempotency key already stored
 * in `XeroSyncOperation` was derived under insertion order, so sorting the keys
 * would re-derive EVERY one of them. A retry or replay would then present Xero
 * with a key it has never seen for a document it has already accepted, and Xero
 * would create a SECOND invoice, credit note or payment. The failure is a
 * duplicate financial document at the provider, which no later code change can
 * take back.
 *
 * The property `stableDigest` exists to give — "the same data hashes the same
 * however its keys were ordered" — is not wanted here either. This hash asks a
 * narrower question: *is the request I am about to send byte-for-byte the
 * request I sent before?* An outbound payload is built by one code path in one
 * order, so insertion order is stable in practice, and a change in that order IS
 * a change in the request.
 *
 * `identity-ordering-census.test.ts` records this exclusion by name, so removing
 * it is a deliberate act rather than a tidy-up.
 */
export function buildXeroPayloadHash(payload: unknown): string {
  // Idempotency keys must change when the outbound request changes, including
  // fields that are redacted before storage such as email addresses and phone numbers.
  const json = JSON.stringify(normalizePayloadHashValue(payload) ?? null);
  return createHash("sha256").update(json).digest("hex").slice(0, 12);
}

export function buildXeroIdempotencyKey(
  ...parts: Array<string | number | boolean | null | undefined>
): string {
  const base = parts
    .filter((part): part is string | number | boolean => part !== null && part !== undefined && part !== "")
    .map((part) => String(part))
    .join(":");

  if (!base) {
    throw new Error("Cannot build a Xero idempotency key from empty parts");
  }

  if (base.length <= 120) {
    return base;
  }

  const digest = createHash("sha256").update(base).digest("hex").slice(0, 12);
  return `${base.slice(0, 107)}:${digest}`;
}

/**
 * The cents one REFUND_CREDIT_NOTE link contributes to a payment's covered
 * refund total (#1162): the link metadata's recorded `amountCents` when
 * present, else the create operation's persisted request payload
 * (`allocation.amount` in dollars), which every historical note carries.
 * Returns null when neither source can recover an amount — or when the link's
 * recorded Xero status is VOIDED/DELETED, because a cancelled note credits
 * nothing in Xero and must not count as coverage anywhere (#2901 review:
 * status-blind counting here permanently suppressed the self-heal after an
 * operator void, under-crediting the member). Shared by
 * `sumCoveredRefundCreditNoteCents` and the #2901 operator repair so the two
 * can never disagree about what a legacy link is worth.
 */
export async function recoverRefundCreditNoteLinkAmountCents(
  paymentId: string,
  link: { xeroObjectId: string; metadata: unknown },
  db: Pick<Prisma.TransactionClient, "xeroSyncOperation"> = prisma
): Promise<number | null> {
  if (isRefundCreditNoteLinkCancelledInXero(link.metadata)) {
    return null;
  }
  const metadata = asRecord(link.metadata);
  const recorded = metadata?.amountCents;
  if (typeof recorded === "number" && Number.isFinite(recorded)) {
    return Math.max(0, Math.round(recorded));
  }
  const operation = await db.xeroSyncOperation.findFirst({
    where: {
      direction: "OUTBOUND",
      entityType: "CREDIT_NOTE",
      operationType: "CREATE",
      localModel: "Payment",
      localId: paymentId,
      xeroObjectId: link.xeroObjectId,
    },
    orderBy: { createdAt: "desc" },
    select: { requestPayload: true },
  });
  const payload = asRecord(operation?.requestPayload);
  const allocation = asRecord(payload?.allocation);
  const allocationCents = providerAmountToCents(allocation?.amount);
  if (allocationCents !== null) {
    return Math.max(0, allocationCents);
  }
  return null;
}

/**
 * Cents already covered by refund credit notes for a payment (#1162): the sum
 * of the active REFUND_CREDIT_NOTE links' recorded amounts. Links written
 * before amounts were recorded fall back to the create operation's persisted
 * request payload (`allocation.amount` in dollars), which every historical
 * note carries.
 */
export async function sumCoveredRefundCreditNoteCents(
  paymentId: string,
  // Optional transaction client (#1357) so a tx-scoped enqueue sees its own
  // uncommitted writes; defaults to the global client for existing callers.
  db: Pick<Prisma.TransactionClient, "xeroObjectLink" | "xeroSyncOperation"> = prisma,
  // #3924 round 8: only these notes - the ones a single refund's own rows
  // raised (`sumRefundCreditNoteCoverageOfRowsCents`). Omitted, every note.
  onlyNoteIds?: readonly string[]
): Promise<number> {
  if (onlyNoteIds && onlyNoteIds.length === 0) return 0;
  const links = await db.xeroObjectLink.findMany({
    where: {
      localModel: "Payment",
      localId: paymentId,
      xeroObjectType: "CREDIT_NOTE",
      role: "REFUND_CREDIT_NOTE",
      active: true,
      ...(onlyNoteIds ? { xeroObjectId: { in: [...onlyNoteIds] } } : {}),
    },
    select: { xeroObjectId: true, metadata: true },
  });

  let coveredCents = 0;
  for (const link of links) {
    coveredCents +=
      (await recoverRefundCreditNoteLinkAmountCents(paymentId, link, db)) ?? 0;
  }
  return coveredCents;
}

export async function findCanonicalPaymentRefundCreditNote(
  paymentId: string,
  // Optional transaction client (#1357); defaults to the global client.
  db: Prisma.TransactionClient = prisma
): Promise<CanonicalPaymentRefundCreditNoteLink | null> {
  // Sequential on purpose (#1357): an interactive transaction client
  // serializes queries onto one connection anyway, and concurrent dispatch on
  // an itx lets a failing sibling surface as a masking secondary
  // "transaction already closed" error.
  const payment = await db.payment.findUnique({
    where: { id: paymentId },
    select: {
      xeroRefundCreditNoteId: true,
    },
  });
  const allRefundCreditNoteLinks = await db.xeroObjectLink.findMany({
    where: {
      localModel: "Payment",
      localId: paymentId,
      xeroObjectType: "CREDIT_NOTE",
      role: "REFUND_CREDIT_NOTE",
      active: true,
    },
    orderBy: [
      { updatedAt: "desc" },
      { createdAt: "desc" },
    ],
    select: {
      xeroObjectId: true,
      xeroObjectNumber: true,
    },
  });
  // #3827 (D-3813-8): a refund request's own note is an allowed extra, never
  // this payment's one refund note - left out of every fallback below, or a
  // cancellation's note would be absorbed into a request's.
  const refundRequestNoteIds = new Set(
    (
      (await db.xeroObjectLink.findMany({
        where: {
          localModel: "Payment",
          localId: paymentId,
          xeroObjectType: "CREDIT_NOTE",
          role: REFUND_REQUEST_CREDIT_NOTE_ROLE,
        },
        select: { xeroObjectId: true },
      })) ?? []
    ).map((link) => link.xeroObjectId)
  );
  // #3880: a per-refund note is never the canonical one, in any form below.
  // `INV-ADDPAY-041`: nor is a note Xero voided or deleted - a later
  // request raises a fresh note rather than re-adopting it.
  const neverCanonicalNoteIds = await neverCanonicalRefundNoteIds(paymentId, db);
  const refundCreditNoteLinks = allRefundCreditNoteLinks.filter((link) => !neverCanonicalNoteIds.has(link.xeroObjectId));
  const nonCanonicalNoteIds = new Set([...refundRequestNoteIds, ...neverCanonicalNoteIds]);
  const refundPaymentLinks = await db.xeroObjectLink.findMany({
    where: {
      localModel: "Payment",
      localId: paymentId,
      xeroObjectType: "PAYMENT",
      role: "REFUND_PAYMENT",
      active: true,
    },
    orderBy: [
      { updatedAt: "desc" },
      { createdAt: "desc" },
    ],
    select: {
      metadata: true,
    },
  });
  const succeededOperation = await db.xeroSyncOperation.findFirst({
    where: {
      status: "SUCCEEDED",
      entityType: "CREDIT_NOTE",
      operationType: "CREATE",
      localModel: "Payment",
      localId: paymentId,
      xeroObjectId:
        nonCanonicalNoteIds.size > 0
          ? { not: null, notIn: [...nonCanonicalNoteIds] }
          : { not: null },
    },
    orderBy: [
      { completedAt: "desc" },
      { createdAt: "desc" },
    ],
    select: {
      xeroObjectId: true,
      xeroObjectNumber: true,
    },
  });

  const xeroObjectNumberById = new Map<string, string | null>();
  for (const link of refundCreditNoteLinks) {
    xeroObjectNumberById.set(link.xeroObjectId, link.xeroObjectNumber ?? null);
  }

  if (succeededOperation?.xeroObjectId && !xeroObjectNumberById.has(succeededOperation.xeroObjectId)) {
    xeroObjectNumberById.set(
      succeededOperation.xeroObjectId,
      succeededOperation.xeroObjectNumber ?? null
    );
  }

  const canonicalFieldNoteId = canonicalRefundNoteFromField(payment?.xeroRefundCreditNoteId, neverCanonicalNoteIds);
  if (canonicalFieldNoteId) {
    return {
      xeroObjectId: canonicalFieldNoteId,
      xeroObjectNumber:
        xeroObjectNumberById.get(canonicalFieldNoteId) ?? null,
      source: "payment",
    };
  }

  for (const link of refundPaymentLinks) {
    const metadata = asRecord(link.metadata);
    const linkedCreditNoteId = readString(metadata?.creditNoteId);
    if (linkedCreditNoteId && !nonCanonicalNoteIds.has(linkedCreditNoteId)) {
      return {
        xeroObjectId: linkedCreditNoteId,
        xeroObjectNumber: xeroObjectNumberById.get(linkedCreditNoteId) ?? null,
        source: "refund_payment",
      };
    }
  }

  if (succeededOperation?.xeroObjectId) {
    return {
      xeroObjectId: succeededOperation.xeroObjectId,
      xeroObjectNumber: succeededOperation.xeroObjectNumber ?? null,
      source: "operation",
    };
  }

  const latestActiveLink = refundCreditNoteLinks[0];
  if (!latestActiveLink) {
    return null;
  }

  return {
    xeroObjectId: latestActiveLink.xeroObjectId,
    xeroObjectNumber: latestActiveLink.xeroObjectNumber ?? null,
    source: "link",
  };
}

function getAttemptWhere(
  input: Pick<XeroSyncOperationInput, "correlationKey" | "idempotencyKey">
): Prisma.XeroSyncOperationWhereInput | undefined {
  const or: Prisma.XeroSyncOperationWhereInput[] = [];

  if (input.correlationKey) {
    or.push({ correlationKey: input.correlationKey });
  }

  if (input.idempotencyKey) {
    or.push({ idempotencyKey: input.idempotencyKey });
  }

  if (or.length === 0) {
    return undefined;
  }

  return { OR: or };
}

/** Inserts `startXeroSyncOperation` makes at most when each lost race finds the winner FAILED (#4338). */
const START_OPERATION_INSERT_ATTEMPTS = 3;

export async function startXeroSyncOperation(
  input: XeroSyncOperationInput & { store?: Prisma.TransactionClient }
) {
  // When a caller passes an in-flight transaction client the operation row is
  // written inside that transaction so it commits atomically with the caller's
  // other writes; the default global `prisma` keeps every existing caller
  // unchanged. `store` is never part of the `create` payload.
  const db = input.store ?? prisma;
  const attemptWhere = getAttemptWhere(input);

  // Denormalized copy of the outbox queue type (#1271, item 3 of #1208),
  // captured once here at enqueue and never updated afterward. Derive it from
  // the SAME sanitized payload that gets persisted so it mirrors the
  // enqueue-time `requestPayload.queueType` exactly. Dispatch reads queueType
  // from the payload (not this column) BEFORE handlers may overwrite
  // requestPayload, so the two can legitimately diverge post-dispatch. The
  // booking-vs-Xero repair pass reads this column as the AUTHORITATIVE
  // discriminator precisely because it survives those overwrites (#1427).
  // Rows without a queueType (REQUEUE, inbound reconciles, backfill) stay
  // null.
  const requestPayload = sanitizeForJson(input.requestPayload);
  const payloadRecord = asRecord(requestPayload);
  const queueType =
    (payloadRecord ? readString(payloadRecord.queueType) : null) ?? input.queueType ?? null;

  for (let insert = 1; ; insert += 1) {
    const attemptCount = attemptWhere ? (await db.xeroSyncOperation.count({ where: attemptWhere })) + 1 : 1;
    try {
      return await db.xeroSyncOperation.create({
        data: {
          direction: input.direction,
          entityType: input.entityType,
          operationType: input.operationType,
          localModel: input.localModel ?? null,
          localId: input.localId ?? null,
          status: input.status ?? "RUNNING",
          idempotencyKey: input.idempotencyKey ?? null,
          correlationKey: input.correlationKey ?? null,
          attemptCount,
          replayable: input.replayable ?? true,
          requestPayload,
          queueType,
          // #2929: immutable after enqueue, exactly like `queueType` above and
          // for the same reason — the booking-invoice handler rewrites
          // `requestPayload` wholesale before its first provider call, so the
          // instruction cannot live there and survive a retry.
          invoiceEmailDelivery: input.invoiceEmailDelivery ?? null,
          createdByMemberId: input.createdByMemberId ?? null,
          startedAt: input.status === "PENDING" ? null : new Date(),
        },
      });
    } catch (error) {
      // #1354: the partial unique index (one ACTIVE operation per correlation key)
      // turns a lost concurrent-enqueue race into a unique violation here. Resolve
      // it as the findFirst fast-path dedup would: return the winner's active row.
      // Not on a caller's transaction (the root client is none): the violation has
      // aborted it, so no read can follow (#4338).
      if (!isPrismaUniqueConstraintError(error) || !input.correlationKey || db !== prisma) throw error;
      const { correlationKey } = input;
      const existing = await db.xeroSyncOperation.findFirst({
        where: { correlationKey, status: { in: [...XERO_ACTIVE_OPERATION_STATUSES] } },
        orderBy: { createdAt: "desc" },
      });
      if (existing) return existing;
      // #4338: the winner finished in between. Only a FAILED one leaves work to
      // do, so only then insert again, as a retry a moment later would: while it
      // is unresolved, or when the converge closed it itself. A PARTIAL winner's
      // Xero object exists, and an officer's mark is done and never re-minted
      // beside (`INV-INT-025`); those, like a SUCCEEDED or CANCELLED winner, keep
      // the error: the caller's own pre-checks never saw it.
      const newest = await db.xeroSyncOperation.findFirst({
        where: { correlationKey },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: { status: true, manuallyResolvedAt: true, manuallyResolvedById: true, manuallyResolvedReason: true },
      });
      const winnerLeftWork =
        newest?.status === "FAILED" && (newest.manuallyResolvedAt === null || isClosedByCreditSpentOutsideApp(newest));
      if (!winnerLeftWork || insert >= START_OPERATION_INSERT_ATTEMPTS) throw error;
    }
  }
}

async function releaseCancelledRefundCreditNotePointer(
  client: Prisma.TransactionClient,
  link: XeroObjectLinkInput,
): Promise<void> {
  const remaining = await client.xeroObjectLink.findMany({
    where: {
      localModel: "Payment",
      localId: link.localId,
      xeroObjectType: "CREDIT_NOTE",
      role: "REFUND_CREDIT_NOTE",
      active: true,
      xeroObjectId: { not: link.xeroObjectId },
    },
    select: {
      id: true,
      xeroObjectId: true,
      metadata: true,
      createdAt: true,
    },
  });
  const newestLive = [...remaining]
    .sort((left, right) => {
      const byCreated = right.createdAt.getTime() - left.createdAt.getTime();
      if (byCreated !== 0) {
        return byCreated;
      }
      return right.id.localeCompare(left.id);
    })
    // #3880: a per-refund note is never written into the field.
    .find(
      (candidate) =>
        !isRefundCreditNoteLinkCancelledInXero(candidate.metadata) &&
        !isPerDeltaRefundNoteLink(candidate.metadata),
    );

  await client.payment.updateMany({
    where: {
      id: link.localId,
      xeroRefundCreditNoteId: link.xeroObjectId,
    },
    data: {
      xeroRefundCreditNoteId: newestLive?.xeroObjectId ?? null,
    },
  });
}

async function normalizePaymentRefundLinkWithClient(
  client: Prisma.TransactionClient,
  link: XeroObjectLinkInput
): Promise<XeroObjectLinkInput> {
  if (link.localModel !== "Payment") {
    return link;
  }

  if (REFUND_NOTE_LINK_ROLES.some((role) => isRefundNoteLinkOf(link, role))) {
    link = await keepStoredRefundNoteVoid(client, link); // #4195, #4223: own row first; keeps a void it waited on
    // A note the write (or that stored void) records VOIDED/DELETED in Xero credits nothing, so its mirror
    // is written inactive on every payment: a Stripe or per-refund note (#2901), a bank-transfer payment's
    // one canonical note (#4091) and a refund request's own note (#4195, `INV-PAY-118`). Else an inbound
    // re-reconcile re-arms phantom coverage (upsert forces `active` from this return). It retires no sibling.
    if (isRefundCreditNoteLinkCancelledInXero(link.metadata)) {
      // The pointer moves after this link row is written: link, then payment, the repair apply's order.
      return { ...link, active: false };
    }
    if (link.role === REFUND_REQUEST_CREDIT_NOTE_ROLE) return link; // never the one note below

    const payment = await client.payment.findUnique({
      where: { id: link.localId },
      select: {
        source: true,
        xeroRefundCreditNoteId: true,
      },
    });

    // Stripe payments can be refunded in several steps, each recorded as its
    // own active REFUND_CREDIT_NOTE (#1162). Those per-delta notes must all stay
    // active so `sumCoveredRefundCreditNoteCents` totals them correctly, so skip
    // the single-active canonical enforcement that non-Stripe single-note
    // refunds still rely on below.
    // #3880: a non-Stripe payment's per-refund note takes the Stripe rule, and
    // the single-refund rule below never retires one.
    const perDeltaNoteIds = payment?.source === PaymentSource.STRIPE ? new Set<string>() : await perDeltaRefundNoteIds(link.localId, client);
    if (payment?.source === PaymentSource.STRIPE || isPerDeltaRefundNoteLink(link.metadata) || perDeltaNoteIds.has(link.xeroObjectId)) {
      return {
        ...link,
        active: link.active ?? true,
      };
    }

    // #3880 F1: a field naming a per-refund note is no canonical note at all.
    const canonicalCreditNoteId =
      canonicalRefundNoteFromField(payment?.xeroRefundCreditNoteId, perDeltaNoteIds) ?? link.xeroObjectId;
    const shouldBeActive = (link.active ?? true) && canonicalCreditNoteId === link.xeroObjectId;

    if (canonicalCreditNoteId === link.xeroObjectId) {
      await client.xeroObjectLink.updateMany({
        where: {
          localModel: "Payment",
          localId: link.localId,
          xeroObjectType: "CREDIT_NOTE",
          role: "REFUND_CREDIT_NOTE",
          active: true,
          xeroObjectId: {
            not: canonicalCreditNoteId,
            notIn: [...perDeltaNoteIds],
          },
        },
        data: {
          active: false,
        },
      });
    }

    return {
      ...link,
      active: shouldBeActive,
    };
  }

  if (link.role === "REFUND_PAYMENT" && link.xeroObjectType === "PAYMENT") {
    const payment = await client.payment.findUnique({
      where: { id: link.localId },
      select: {
        xeroRefundCreditNoteId: true,
      },
    });
    const metadata = asRecord(link.metadata);
    const linkedCreditNoteId = readString(metadata?.creditNoteId);
    const canonicalCreditNoteId =
      (await readCanonicalRefundNoteField(
        payment ? { id: link.localId, xeroRefundCreditNoteId: payment.xeroRefundCreditNoteId } : null,
        client,
      )) ?? linkedCreditNoteId;
    const shouldBeActive =
      (link.active ?? true)
      && (!canonicalCreditNoteId || linkedCreditNoteId === canonicalCreditNoteId);

    if (shouldBeActive) {
      await client.xeroObjectLink.updateMany({
        where: {
          localModel: "Payment",
          localId: link.localId,
          xeroObjectType: "PAYMENT",
          role: "REFUND_PAYMENT",
          active: true,
          xeroObjectId: {
            not: link.xeroObjectId,
          },
        },
        data: {
          active: false,
        },
      });
    }

    return {
      ...link,
      active: shouldBeActive,
    };
  }

  return link;
}

function isSingleActiveCanonicalLinkScope(link: XeroObjectLinkInput) {
  return SINGLE_ACTIVE_CANONICAL_LINK_SCOPES.some(
    (scope) => scope.localModel === link.localModel && scope.role === link.role
  );
}

async function deactivateOtherCanonicalLinksWithClient(
  client: Prisma.TransactionClient,
  link: XeroObjectLinkInput
) {
  if (!(link.active ?? true) || !isSingleActiveCanonicalLinkScope(link)) {
    return;
  }

  await client.xeroObjectLink.updateMany({
    where: {
      localModel: link.localModel,
      localId: link.localId,
      role: link.role,
      active: true,
      OR: [
        {
          xeroObjectType: {
            not: link.xeroObjectType,
          },
        },
        {
          xeroObjectId: {
            not: link.xeroObjectId,
          },
        },
      ],
    },
    data: {
      active: false,
    },
  });
}

async function upsertXeroObjectLinkWithClient(
  client: Prisma.TransactionClient,
  link: XeroObjectLinkInput
) {
  const normalizedLink = await normalizePaymentRefundLinkWithClient(client, link);
  await deactivateOtherCanonicalLinksWithClient(client, normalizedLink);
  // #2314: what this column HOLDS is organisation-agnostic, always. A short
  // code baked into a row is wrong the moment the club reconnects to a
  // different Xero organisation, and nothing would ever correct it; the
  // organisation is applied when the row is read instead
  // (`applyXeroOrgShortCode`). Enforcing it here means none of the ~50 callers
  // that reach the column THROUGH this funnel has to remember, and a legacy row
  // that already carries a short code is normalised the next time it is
  // written. This funnel is not the only writer, though — three files write the
  // column with direct Prisma calls they cannot route through here (see
  // `xero-object-url-write-guard.test.ts`, which fails CI on any direct write
  // that does not strip).
  const xeroObjectUrl = stripXeroOrgShortCode(
    normalizedLink.xeroObjectUrl ??
      buildXeroObjectUrl(
        normalizedLink.xeroObjectType,
        normalizedLink.xeroObjectId,
      ),
  );

  const metadata = sanitizeForJson(normalizedLink.metadata);
  // #4445: a merge is written by one statement that reads the row it writes,
  // after the upsert below takes that row (`xero-object-link-metadata-merge.ts`).
  const merge = normalizedLink.mergeMetadata
    ? planXeroObjectLinkMetadataMerge(normalizedLink.metadata, metadata)
    : null;

  let written = await client.xeroObjectLink.upsert({
    where: {
      localModel_localId_xeroObjectType_xeroObjectId_role: {
        localModel: normalizedLink.localModel,
        localId: normalizedLink.localId,
        xeroObjectType: normalizedLink.xeroObjectType,
        xeroObjectId: normalizedLink.xeroObjectId,
        role: normalizedLink.role,
      },
    },
    create: {
      localModel: normalizedLink.localModel,
      localId: normalizedLink.localId,
      xeroObjectType: normalizedLink.xeroObjectType,
      xeroObjectId: normalizedLink.xeroObjectId,
      xeroObjectNumber: normalizedLink.xeroObjectNumber ?? null,
      xeroObjectUrl,
      role: normalizedLink.role,
      active: normalizedLink.active ?? true,
      metadata,
    },
    update: {
      xeroObjectNumber: normalizedLink.xeroObjectNumber ?? null,
      xeroObjectUrl,
      active: normalizedLink.active ?? true,
      ...(normalizedLink.mergeMetadata ? {} : { metadata }),
    },
  });
  if (merge) {
    await mergeXeroObjectLinkMetadata(client, written.id, merge);
    written = await client.xeroObjectLink.findUniqueOrThrow({ where: { id: written.id } });
  }

  // After the link row, matching the refund-note repair apply. The nightly
  // report treats Payment.xeroRefundCreditNoteId as a promise that an active
  // REFUND_CREDIT_NOTE link exists. Deactivating a VOIDED or DELETED mirror
  // without moving that pointer leaves a "missing refund credit note link"
  // until #4192 heals the inactive mirror. Repoint at the newest other live
  // note, or clear it. The where-clause is the claim: a pointer that already
  // names a different note is left alone.
  if (
    isRefundNoteLinkOf(normalizedLink) &&
    normalizedLink.active === false &&
    isRefundCreditNoteLinkCancelledInXero(normalizedLink.metadata)
  ) {
    const payment = await client.payment.findUnique({
      where: { id: normalizedLink.localId },
      select: { xeroRefundCreditNoteId: true },
    });
    if (payment?.xeroRefundCreditNoteId === normalizedLink.xeroObjectId) {
      // INV-LOCK-001, INV-LOCK-002: a write whose void was kept (it named no
      // status, #4223, or an older live one, #4288) can hold this link while a
      // Payment-first enqueue waits for it: never wait back on that Payment.
      // SKIP LOCKED still returns a row this transaction holds. When busy, the
      // inactive mirror commits and the #4161 heal can release its pointer. A
      // caller naming VOIDED/DELETED itself keeps its waiting order (#4200).
      if (!isRefundCreditNoteLinkCancelledInXero(link.metadata)) {
        const available = await client.$executeRaw`
          SELECT 1 FROM "Payment" WHERE "id" = ${normalizedLink.localId}
          FOR NO KEY UPDATE SKIP LOCKED`;
        if (available === 0) return written;
      }
      await releaseCancelledRefundCreditNotePointer(client, normalizedLink);
    }
  }

  return written;
}

export async function upsertXeroObjectLink(
  link: XeroObjectLinkInput,
  // Optional in-flight transaction client (#1357): callers already inside a
  // transaction must not open a nested one, so the write joins theirs.
  options?: { store?: Prisma.TransactionClient }
) {
  if (options?.store) {
    return upsertXeroObjectLinkWithClient(options.store, link);
  }
  return prisma.$transaction((tx) => upsertXeroObjectLinkWithClient(tx, link));
}

export async function deactivateXeroObjectLinks(params: {
  localModel: string;
  localId: string;
  role?: string;
  xeroObjectType?: string;
  xeroObjectId?: string;
}) {
  return prisma.xeroObjectLink.updateMany({
    where: {
      localModel: params.localModel,
      localId: params.localId,
      role: params.role,
      xeroObjectType: params.xeroObjectType,
      xeroObjectId: params.xeroObjectId,
      active: true,
    },
    data: {
      active: false,
    },
  });
}

export async function completeXeroSyncOperation(
  // #4373: the claim this outcome was made under; it never lands on another claim (`INV-INT-029`).
  claim: XeroOperationClaim,
  completion: XeroSyncOperationCompletion,
  // #4356 (`INV-INT-029`): no PARTIAL, FAILED or CANCELLED completion lands on a recorded success or a repair's claim; null then.
  // #4256: `retryClaim` writes only onto that retry claim, clearing its marker code; `alert: false` raises no repeated-failure alert.
  options?: { store?: Prisma.TransactionClient; retryClaim?: true; alert?: false },
): Promise<(XeroSyncOperation & { deferredPostCommit?: () => Promise<void> }) | null> {
  const operationId = claim.id;
  // #2314: organisation-agnostic in the column, organisation applied on read —
  // see the note on the object-link funnel above.
  const xeroObjectUrl = stripXeroOrgShortCode(
    completion.xeroObjectUrl ??
      (completion.xeroObjectType && completion.xeroObjectId
        ? buildXeroObjectUrl(completion.xeroObjectType, completion.xeroObjectId)
        : null),
  );

  const completeWithClient = async (tx: Prisma.TransactionClient) => {
    const status = completion.status ?? "SUCCEEDED";
    const data = {
      status,
      // #4049: no earlier wait's or failure's error stays on a SUCCEEDED row (PARTIAL keeps it).
      ...(status === "SUCCEEDED" ? { lastErrorCode: null, lastErrorMessage: null } : {}),
      ...(status !== "SUCCEEDED" && options?.retryClaim ? { lastErrorCode: null } : {}),
      ...(status !== "SUCCEEDED" && completion.lastErrorMessage ? { lastErrorMessage: completion.lastErrorMessage } : {}),
      responsePayload: sanitizeForJson(completion.responsePayload),
      xeroObjectType: completion.xeroObjectType ?? null,
      xeroObjectId: completion.xeroObjectId ?? null,
      xeroObjectNumber: completion.xeroObjectNumber ?? null,
      xeroObjectUrl,
      completedAt: new Date(),
    };
    const guard = outcomeWriteGuard(claim, status, { retryClaim: options?.retryClaim });
    const claimed = await tx.xeroSyncOperation.updateMany({ where: { id: operationId, ...guard }, data });
    if (claimed.count === 0) {
      // #4373 review F1: a success refused on a later claim still records its links.
      return refusedOutcomeWrite(tx, claim, status, options ?? {}, {
        xeroObjectId: completion.xeroObjectId ?? null,
        recordLinks: async () => {
          for (const link of completion.extraLinks ?? []) await upsertXeroObjectLinkWithClient(tx, link);
        },
      });
    }
    const operation = await tx.xeroSyncOperation.findUniqueOrThrow({ where: { id: operationId } });

    for (const link of completion.extraLinks ?? []) {
      await upsertXeroObjectLinkWithClient(tx, link);
    }

    return operation;
  };
  const operation = options?.store
    ? await completeWithClient(options.store)
    : await prisma.$transaction(completeWithClient);

  // #4374 (`INV-INT-029`): a success landing on a row resolved in Xero warns and alerts once, after commit. On an
  // injected store that is its owner's commit: the owner runs the `deferredPostCommit` returned here after it.
  const resolvedRowAlert = successAfterResolutionAlert(operation);
  if (resolvedRowAlert && operation && options?.store) return { ...operation, deferredPostCommit: resolvedRowAlert };
  await resolvedRowAlert?.();

  if (operation?.status === "PARTIAL" && options?.alert !== false) {
    try {
      const { maybeNotifyXeroRepeatedFailure } = await import("./xero-hardening");
      await maybeNotifyXeroRepeatedFailure(operation);
    } catch (error) {
      logger.error(
        {
          err: error,
          operationId,
        },
        "Failed to process repeated Xero failure alert for partial operation"
      );
    }
  }

  return operation;
}

/**
 * The optional write guard of {@link failXeroSyncOperation}: at most one, so a
 * caller can never pass two and have one silently dropped (#3462). Either way a failure
 * never lands on a recorded success, a repair's claim (#4356), another claim (#4373), or
 * anything but its own claim's RUNNING or FAILED row (#4673, `INV-INT-029`): null.
 */
type FailXeroSyncOperationGuard =
  | {
      /**
       * #3635 round-3 N5: a guarded caller (a missing row only logs). A WITHDRAWN
       * (CANCELLED) row is left as it is - since PR #4687 review every failure
       * keeps CANCELLED (`INV-INT-029`). Answers null then.
       */
      keepCancelled: true;
      retryClaim?: never;
    }
  | {
      /**
       * #3462: fail the row ONLY while it is still the claim's RUNNING claim -
       * a retry's abandon of a claim whose handler threw before it owned
       * completion. A row the handler already completed, failed or cancelled,
       * or one a later claim re-stamped, is left exactly as it is. Answers null
       * then, and the retry reports it.
       */
      retryClaim: true;
      keepCancelled?: never;
    }
  | { keepCancelled?: never; retryClaim?: never };

export async function failXeroSyncOperation(
  // #4373: the claim this failure was made under; it never lands on another claim (`INV-INT-029`).
  claim: XeroOperationClaim,
  error: unknown,
  responsePayload?: unknown,
  options?: FailXeroSyncOperationGuard & {
    /**
     * #3462: the operator-facing message to record instead of the error's own
     * (still redacted). The status code is still read from `error`.
     */
    lastErrorMessage?: string;
  }
) {
  const operationId = claim.id;
  const data = {
    status: "FAILED" as const,
    ...xeroSyncErrorFields(error, options?.lastErrorMessage),
    responsePayload: sanitizeForJson(responsePayload ?? error),
    completedAt: new Date(),
  };

  // #4356: always guarded - a failure never lands on a recorded success. The
  // row returned, and offered to the alert, is the one this write wrote.
  const guard = outcomeWriteGuard(claim, "FAILED", {
    retryClaim: options?.retryClaim,
    alsoKeep: options?.keepCancelled ? "CANCELLED" : undefined,
  });
  const [operation] = await prisma.xeroSyncOperation.updateManyAndReturn({ where: { id: operationId, ...guard }, data });
  if (!operation) return refusedOutcomeWrite(prisma, claim, "FAILED", options ?? {});

  try {
    const { maybeNotifyXeroRepeatedFailure } = await import("./xero-hardening");
    await maybeNotifyXeroRepeatedFailure(operation);
  } catch (alertError) {
    logger.error(
      {
        err: alertError,
        operationId,
      },
      "Failed to process repeated Xero failure alert for failed operation"
    );
  }

  return operation;
}

export async function recordXeroInboundEvent(input: {
  source?: string;
  eventCategory?: string | null;
  eventType: string;
  resourceId?: string | null;
  eventCreatedAt?: Date | null;
  correlationKey: string;
  payload: unknown;
  status?: string;
  errorMessage?: string | null;
  processedAt?: Date | null;
}) {
  const payload = sanitizeForJson(input.payload) ?? Prisma.JsonNull;
  const requestedStatus = input.status ?? "RECEIVED";
  const existing = await prisma.xeroInboundEvent.findUnique({
    where: {
      correlationKey: input.correlationKey,
    },
    select: {
      id: true,
      status: true,
      processedAt: true,
    },
  });

  const shouldPreserveTerminalState =
    requestedStatus === "RECEIVED" &&
    (existing?.status === "PROCESSING" || existing?.status === "PROCESSED");
  const nextStatus = shouldPreserveTerminalState ? existing.status : requestedStatus;
  const nextProcessedAt =
    nextStatus === "PROCESSED"
      ? existing?.processedAt ?? input.processedAt ?? new Date()
      : shouldPreserveTerminalState
        ? existing?.processedAt ?? null
        : input.processedAt ?? null;
  const data = {
    source: input.source ?? "webhook",
    eventCategory: input.eventCategory ?? null,
    eventType: input.eventType,
    resourceId: input.resourceId ?? null,
    eventCreatedAt: input.eventCreatedAt ?? null,
    correlationKey: input.correlationKey,
    payload,
    status: nextStatus,
    errorMessage: input.errorMessage
      ? redactSensitiveText(input.errorMessage)
      : null,
    processedAt: nextProcessedAt,
  };

  if (!existing) {
    return prisma.xeroInboundEvent.create({ data });
  }

  return prisma.xeroInboundEvent.update({
    where: {
      id: existing.id,
    },
    data,
  });
}
