/**
 * #3642 (`INV-PAY-105`): the combined group-settlement invoice's outbox
 * identity — the one home for the keys its CREATE attempts and VOIDs carry, the
 * object link it is recorded under, and the CREATE enqueue.
 *
 * AN ATTEMPT is one invoice the settlement asked for. The first is attempt 0,
 * whose key is the pre-#3642 constant, so a row queued before this shipped is
 * the same attempt after it. A settlement that abandons its invoice (the reaper
 * released it, or the organiser's group changed and the invoice was replaced)
 * asks for the next attempt under a new key: the outbox never folds it onto the
 * old attempt's row, and Xero never answers it with a replay of the old
 * invoice. A retry of the SAME attempt keeps its key, so Xero still
 * deduplicates a create that timed out after it was accepted.
 *
 * The attempt is read back from the row's correlation key, which is written
 * once at enqueue: the create worker overwrites the row's request payload with
 * the invoice it sends, so the payload cannot carry it.
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  buildXeroIdempotencyKey,
  startXeroSyncOperation,
  type XeroObjectLinkInput,
} from "@/lib/xero-sync";
import { buildXeroInvoiceUrl } from "@/lib/xero-links";
import { XERO_OUTBOX_GROUP_SETTLEMENT_INVOICE_TYPE } from "@/lib/xero-operation-outbox-payload";
import { GROUP_SETTLEMENT_INVOICE_ROLE } from "@/lib/group-settlement-invoice-binding";

type Db = Prisma.TransactionClient | typeof prisma;

/** The Xero idempotency and outbox correlation key of one CREATE attempt. */
export function groupSettlementInvoiceCreateKey(
  settlementId: string,
  attempt: number
): string {
  return attempt === 0
    ? buildXeroIdempotencyKey("group-settlement", settlementId, "invoice", "v1")
    : buildXeroIdempotencyKey(
        "group-settlement",
        settlementId,
        "invoice",
        `attempt-${attempt}`,
        "v1"
      );
}

/** The attempt a CREATE row's correlation key names, or null for any other key. */
export function parseGroupSettlementInvoiceAttempt(
  settlementId: string,
  correlationKey: string | null | undefined
): number | null {
  if (!correlationKey) return null;
  if (correlationKey === groupSettlementInvoiceCreateKey(settlementId, 0)) return 0;
  const prefix = `group-settlement:${settlementId}:invoice:attempt-`;
  if (!correlationKey.startsWith(prefix) || !correlationKey.endsWith(":v1")) {
    return null;
  }
  const digits = correlationKey.slice(prefix.length, -":v1".length);
  return /^[1-9]\d*$/.test(digits) ? Number(digits) : null;
}

/**
 * The Xero idempotency and outbox correlation key of a VOID: after the group
 * was cancelled (`INV-PAY-035`), or after the settlement abandoned the invoice
 * (`INV-PAY-105`). Invoice-specific, so every observer of one invoice converges
 * on one row and one provider call.
 */
export function groupSettlementInvoiceVoidKey(
  settlementId: string,
  invoiceId: string,
  after: "cancel" | "abandon"
): string {
  return buildXeroIdempotencyKey(
    "group-settlement",
    settlementId,
    after === "cancel" ? "invoice-void-after-cancel" : "invoice-void-after-abandon",
    invoiceId,
    "v1"
  );
}

/** The object link a combined settlement invoice is recorded under. */
export function groupSettlementInvoiceLink(
  settlementId: string,
  invoice: { id: string; number?: string | null },
  options?: { active?: boolean }
): XeroObjectLinkInput {
  return {
    localModel: "GroupBookingSettlement",
    localId: settlementId,
    xeroObjectType: "INVOICE",
    xeroObjectId: invoice.id,
    xeroObjectNumber: invoice.number ?? null,
    xeroObjectUrl: buildXeroInvoiceUrl(invoice.id),
    role: GROUP_SETTLEMENT_INVOICE_ROLE,
    ...(options?.active === undefined ? {} : { active: options.active }),
  };
}

/** The settlement's CREATE rows, every attempt. */
function createRowsOf(settlementId: string) {
  return {
    direction: "OUTBOUND",
    entityType: "INVOICE",
    operationType: "CREATE",
    localModel: "GroupBookingSettlement",
    localId: settlementId,
  } as const;
}

/**
 * The settlement's current attempt: the highest one any CREATE row names, or
 * null before the first. Read under `lock(1)` by every writer that enqueues,
 * and by the create worker to learn whether a later attempt superseded it.
 */
export async function currentGroupSettlementInvoiceAttempt(
  db: Db,
  settlementId: string
): Promise<number | null> {
  const rows = await db.xeroSyncOperation.findMany({
    where: createRowsOf(settlementId),
    select: { correlationKey: true },
  });
  let current: number | null = null;
  for (const row of rows) {
    const attempt = parseGroupSettlementInvoiceAttempt(settlementId, row.correlationKey);
    if (attempt !== null && (current === null || attempt > current)) current = attempt;
  }
  return current;
}

/**
 * Queue the combined invoice's CREATE, inside the settle transaction under
 * `lock(1)`.
 *
 * - `newAttempt: false`: the settlement still wants the invoice it already asked
 *   for. The settlement's pointer is the one authority on "already raised";
 *   otherwise an active row of the current attempt is returned, and a failed
 *   one is re-driven under the SAME key.
 * - `newAttempt: true`: the settlement abandoned its invoice, or never had one.
 *   The next attempt is queued under its own key whatever the old attempt's row
 *   is doing; that row finds itself superseded and raises nothing, or abandons
 *   what it raised.
 */
export async function enqueueXeroGroupSettlementInvoiceOperation(
  settlementId: string,
  options: {
    newAttempt: boolean;
    createdByMemberId?: string;
    store?: Prisma.TransactionClient;
  }
) {
  const db = options.store ?? prisma;
  const settlement = await db.groupBookingSettlement.findUnique({
    where: { id: settlementId },
    select: { id: true, xeroInvoiceId: true },
  });
  if (!settlement) {
    throw new Error(`Group settlement not found: ${settlementId}`);
  }
  if (settlement.xeroInvoiceId && !options.newAttempt) {
    return {
      queueOperationId: null,
      message: "Xero settlement invoice already linked for this group.",
    };
  }

  const current = await currentGroupSettlementInvoiceAttempt(db, settlementId);
  const attempt = options.newAttempt
    ? current === null
      ? 0
      : current + 1
    : (current ?? 0);
  const correlationKey = groupSettlementInvoiceCreateKey(settlementId, attempt);

  if (!options.newAttempt) {
    const active = await db.xeroSyncOperation.findFirst({
      where: {
        ...createRowsOf(settlementId),
        correlationKey,
        status: { in: ["PENDING", "RUNNING"] },
      },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    if (active) {
      return {
        queueOperationId: active.id,
        message: "Xero settlement invoice is already queued for background processing.",
      };
    }
  }

  const queuedOperation = await startXeroSyncOperation({
    ...createRowsOf(settlementId),
    status: "PENDING",
    idempotencyKey: correlationKey,
    correlationKey,
    requestPayload: {
      queueType: XERO_OUTBOX_GROUP_SETTLEMENT_INVOICE_TYPE,
      settlementId,
    },
    createdByMemberId: options.createdByMemberId ?? null,
    store: options.store,
  });
  return {
    queueOperationId: queuedOperation.id,
    message: "Xero settlement invoice queued for background processing.",
  };
}
