import { PaymentSource, Prisma } from "@prisma/client";
import { createHash } from "crypto";
import { prisma } from "./prisma";
import { getXeroErrorStatusCode } from "./xero-error-shape";
import { asRecord, readString } from "./xero-json";
import { isRefundCreditNoteLinkCancelledInXero } from "./xero-refund-note-status";
import { buildXeroObjectUrl, stripXeroOrgShortCode } from "./xero-links";
import {
  redactSensitiveRecord,
  redactSensitiveText,
} from "./redact-sensitive-json";
import logger from "@/lib/logger";
import { isPrismaUniqueConstraintError } from "@/lib/prisma-errors";
import { providerAmountToCents } from "@/lib/money-provider-amount";

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
   * note was created. Only inbound writers should set this; outbound writers
   * own their metadata shape and keep replace semantics.
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
  db: Prisma.TransactionClient = prisma
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
  db: Prisma.TransactionClient = prisma
): Promise<number> {
  const links = await db.xeroObjectLink.findMany({
    where: {
      localModel: "Payment",
      localId: paymentId,
      xeroObjectType: "CREDIT_NOTE",
      role: "REFUND_CREDIT_NOTE",
      active: true,
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
  const refundCreditNoteLinks = await db.xeroObjectLink.findMany({
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
      xeroObjectId: { not: null },
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

  if (payment?.xeroRefundCreditNoteId) {
    return {
      xeroObjectId: payment.xeroRefundCreditNoteId,
      xeroObjectNumber:
        xeroObjectNumberById.get(payment.xeroRefundCreditNoteId) ?? null,
      source: "payment",
    };
  }

  for (const link of refundPaymentLinks) {
    const metadata = asRecord(link.metadata);
    const linkedCreditNoteId = readString(metadata?.creditNoteId);
    if (linkedCreditNoteId) {
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

export async function startXeroSyncOperation(
  input: XeroSyncOperationInput & { store?: Prisma.TransactionClient }
) {
  // When a caller passes an in-flight transaction client the operation row is
  // written inside that transaction so it commits atomically with the caller's
  // other writes; the default global `prisma` keeps every existing caller
  // unchanged. `store` is never part of the `create` payload.
  const db = input.store ?? prisma;
  const attemptWhere = getAttemptWhere(input);
  const attemptCount = attemptWhere
    ? (await db.xeroSyncOperation.count({ where: attemptWhere })) + 1
    : 1;

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
  const queueType = payloadRecord ? readString(payloadRecord.queueType) : null;

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
        createdByMemberId: input.createdByMemberId ?? null,
        startedAt: input.status === "PENDING" ? null : new Date(),
      },
    });
  } catch (error) {
    // #1354: the partial unique index (one ACTIVE operation per correlation
    // key) turns a lost concurrent-enqueue race into a unique violation here.
    // Resolve it the same way the findFirst fast-path dedup would have:
    // return the winner's active row so the caller's enqueue is idempotent.
    if (isPrismaUniqueConstraintError(error) && input.correlationKey) {
      const existing = await db.xeroSyncOperation.findFirst({
        where: {
          correlationKey: input.correlationKey,
          status: { in: ["PENDING", "RUNNING", "WAITING_PAYMENT"] },
        },
        orderBy: { createdAt: "desc" },
      });
      if (existing) {
        return existing;
      }
    }
    throw error;
  }
}

async function normalizePaymentRefundLinkWithClient(
  client: Prisma.TransactionClient,
  link: XeroObjectLinkInput
): Promise<XeroObjectLinkInput> {
  if (link.localModel !== "Payment") {
    return link;
  }

  if (link.role === "REFUND_CREDIT_NOTE" && link.xeroObjectType === "CREDIT_NOTE") {
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
    if (payment?.source === PaymentSource.STRIPE) {
      // ... unless the incoming write itself says the note was VOIDED/DELETED
      // in Xero (inbound reconciliation and the operator status recorder carry
      // the live provider status). A cancelled note credits nothing, so its
      // local mirror is deactivated on write — without this, an inbound
      // re-reconcile of a voided note re-armed the phantom coverage the #2901
      // repair had just removed (upsert's update clause forces `active` from
      // this return value).
      if (isRefundCreditNoteLinkCancelledInXero(link.metadata)) {
        return {
          ...link,
          active: false,
        };
      }
      return {
        ...link,
        active: link.active ?? true,
      };
    }

    const canonicalCreditNoteId = payment?.xeroRefundCreditNoteId ?? link.xeroObjectId;
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
    const canonicalCreditNoteId = payment?.xeroRefundCreditNoteId ?? linkedCreditNoteId;
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

  let metadataForUpdate: unknown = normalizedLink.metadata;
  if (normalizedLink.mergeMetadata) {
    const existing = await client.xeroObjectLink.findUnique({
      where: {
        localModel_localId_xeroObjectType_xeroObjectId_role: {
          localModel: normalizedLink.localModel,
          localId: normalizedLink.localId,
          xeroObjectType: normalizedLink.xeroObjectType,
          xeroObjectId: normalizedLink.xeroObjectId,
          role: normalizedLink.role,
        },
      },
      select: { metadata: true },
    });
    const existingRecord =
      existing?.metadata &&
      typeof existing.metadata === "object" &&
      !Array.isArray(existing.metadata)
        ? (existing.metadata as Record<string, unknown>)
        : null;
    const incomingRecord =
      normalizedLink.metadata &&
      typeof normalizedLink.metadata === "object" &&
      !Array.isArray(normalizedLink.metadata)
        ? (normalizedLink.metadata as Record<string, unknown>)
        : null;
    if (existingRecord || incomingRecord) {
      metadataForUpdate = { ...(existingRecord ?? {}), ...(incomingRecord ?? {}) };
    }
  }

  return client.xeroObjectLink.upsert({
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
      metadata: sanitizeForJson(normalizedLink.metadata),
    },
    update: {
      xeroObjectNumber: normalizedLink.xeroObjectNumber ?? null,
      xeroObjectUrl,
      active: normalizedLink.active ?? true,
      metadata: sanitizeForJson(metadataForUpdate),
    },
  });
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
  operationId: string,
  completion: XeroSyncOperationCompletion,
  options?: { store?: Prisma.TransactionClient },
) {
  // #2314: organisation-agnostic in the column, organisation applied on read —
  // see the note on the object-link funnel above.
  const xeroObjectUrl = stripXeroOrgShortCode(
    completion.xeroObjectUrl ??
      (completion.xeroObjectType && completion.xeroObjectId
        ? buildXeroObjectUrl(completion.xeroObjectType, completion.xeroObjectId)
        : null),
  );

  const completeWithClient = async (tx: Prisma.TransactionClient) => {
    const operation = await tx.xeroSyncOperation.update({
      where: { id: operationId },
      data: {
        status: completion.status ?? "SUCCEEDED",
        responsePayload: sanitizeForJson(completion.responsePayload),
        xeroObjectType: completion.xeroObjectType ?? null,
        xeroObjectId: completion.xeroObjectId ?? null,
        xeroObjectNumber: completion.xeroObjectNumber ?? null,
        xeroObjectUrl,
        completedAt: new Date(),
      },
    });

    for (const link of completion.extraLinks ?? []) {
      await upsertXeroObjectLinkWithClient(tx, link);
    }

    return operation;
  };
  const operation = options?.store
    ? await completeWithClient(options.store)
    : await prisma.$transaction(completeWithClient);

  if (operation.status === "PARTIAL") {
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

export async function failXeroSyncOperation(
  operationId: string,
  error: unknown,
  responsePayload?: unknown
) {
  const statusCode = getXeroErrorStatusCode(error);
  const rawMessage =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "Unknown Xero sync failure";
  const message = redactSensitiveText(rawMessage);

  const operation = await prisma.xeroSyncOperation.update({
    where: { id: operationId },
    data: {
      status: "FAILED",
      lastErrorCode: statusCode ? String(statusCode) : null,
      lastErrorMessage: message,
      responsePayload: sanitizeForJson(responsePayload ?? error),
      completedAt: new Date(),
    },
  });

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
