// Pure JSON/date/amount readers and small helpers for the booking-vs-Xero
// repair tool. Extracted verbatim from xero-booking-repair.ts (#1208 item 2).
// Per #1208, this file's readJson* guards are intentionally kept local (NOT
// merged into @/lib/xero-json) to preserve behavior.
import {
  XERO_OUTBOX_MODIFICATION_ACCOUNT_CREDIT_NOTE_TYPE,
  XERO_OUTBOX_MODIFICATION_CREDIT_NOTE_TYPE,
  readQueueType,
} from "@/lib/xero-operation-outbox-payload";
import { providerAmountToCents } from "@/lib/money-provider-amount";
import { isDateOnlyString } from "@/lib/date-only";

export function makeLocalKey(localModel: string, localId: string) {
  return `${localModel}:${localId}`;
}

/**
 * "THIS XERO OPERATION GOT FAR ENOUGH TO HAVE TOUCHED ITS OBJECT" - the repair
 * tool's one definition, imported by every arm that needs it (`INV-SSOT-001`).
 *
 * `PARTIAL` joins `SUCCEEDED` because the Xero write itself landed: the object
 * exists, carries an id, and is recorded on the row. What failed is a step
 * AFTER it - the payment write, the emailed copy - so a `PARTIAL` invoice-create
 * is an invoice that really was raised. Every reader in this tool wants that
 * fact, and each used to spell it as its own inline `["SUCCEEDED", "PARTIAL"]`;
 * the sixth copy arrived with #3199, on a money path, which is where two
 * definitions of one fact stop being cosmetic.
 *
 * NOT the same fact as `SETTLED_CREDIT_OPERATION_STATUSES`
 * (`membership-cancellation-subscription-credit.ts`), which happens to be the
 * same two strings. That one asks "has this operation had its one run", a
 * question about the QUEUE rather than about the object, and merging the two
 * would tie a subscription-credit gate to whatever this tool later decides
 * counts as evidence of a Xero object. Same strings, different questions: they
 * stay apart.
 */
const SUCCESSFUL_XERO_OPERATION_STATUSES = [
  "SUCCEEDED",
  "PARTIAL",
] as const;

export function isSuccessfulXeroOperation(operation: { status: string }) {
  return (SUCCESSFUL_XERO_OPERATION_STATUSES as readonly string[]).includes(
    operation.status
  );
}

/**
 * A club calendar day for the repair scope, or a refusal (#2868).
 *
 * Shared by the CLI's `--from`/`--to` and by `buildScopeWhere`, so the sweep
 * cannot be handed a day the CLI would have rejected. Both callers fail CLOSED:
 * the alternative for a tool that can `--apply` is a window quietly wider than
 * the operator asked for, and `scope.from` was previously only kept out of that
 * state by a truthiness check — `""` read as "not supplied" and produced an
 * unbounded-below sweep.
 *
 * `isDateOnlyString` is the canonical validator, and it is STRICTER than the
 * `new Date(`${day}T00:00:00`)` + `Number.isNaN` pair the CLI used to run.
 * Measured on Node 24: that pair ACCEPTED `2026-02-30` (rolling it to 2 March),
 * `2026-04-31` (to 1 May) and `2026-02-29` (to 1 March), because a `Date` built
 * from out-of-range parts rolls over rather than failing. `isDateOnlyString`
 * round-trips the value through `toISOString()` and compares, so a day that
 * rolled is a day that changed and is refused. `2024-02-29`, a real leap day,
 * is accepted by both.
 */
export function parseRepairScopeDay(value: string, label: string): string {
  const trimmed = value.trim();
  if (!isDateOnlyString(trimmed)) {
    throw new Error(
      `${label} must be a real calendar day in YYYY-MM-DD format (received ${JSON.stringify(value)}).`
    );
  }
  return trimmed;
}

// #1427: which outbox queue type did this operation belong to? The immutable
// column first (#1347), then the payload's own name — but the pre-column
// EXECUTED ledger has neither: executors overwrite requestPayload at
// dispatch (the account-credit executor leaves a bare document naming no
// queueType), and the #1347 backfill copied the column from those
// already-overwritten payloads. For exactly those rows the correlation/
// idempotency key is decisive: the enqueue embedded a kind segment
// ("mod-credit-note" for the invoice-applied note; "mod-unapplied-credit-
// note" / "mod-account-credit-note" for the account-credit note) and no
// executor ever rewrites the key. Null only for rows carrying none of these
// (REQUEUE/backfill/inbound rows, or the pre-outbox era).
const OPERATION_KEY_SEGMENT_QUEUE_TYPES: Record<string, string> = {
  "mod-credit-note": XERO_OUTBOX_MODIFICATION_CREDIT_NOTE_TYPE,
  "mod-unapplied-credit-note":
    XERO_OUTBOX_MODIFICATION_ACCOUNT_CREDIT_NOTE_TYPE,
  "mod-account-credit-note":
    XERO_OUTBOX_MODIFICATION_ACCOUNT_CREDIT_NOTE_TYPE,
};

export function getOperationQueueTypeHint(operation: {
  queueType: string | null;
  requestPayload: unknown;
  correlationKey: string | null;
  idempotencyKey: string | null;
}): string | null {
  if (operation.queueType) {
    return operation.queueType;
  }

  const payloadQueueType = readQueueType(operation.requestPayload);
  if (payloadQueueType) {
    return payloadQueueType;
  }

  for (const key of [operation.correlationKey, operation.idempotencyKey]) {
    if (!key) {
      continue;
    }
    for (const segment of key.split(":")) {
      const queueType = OPERATION_KEY_SEGMENT_QUEUE_TYPES[segment];
      if (queueType) {
        return queueType;
      }
    }
  }

  return null;
}

export function toIsoDate(value: Date) {
  return value.toISOString();
}

export function readJsonRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

export function readJsonString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function readJsonNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function readJsonArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function dollarsToCents(value: unknown): number | null {
  return providerAmountToCents(readJsonNumber(value));
}

function readLineItemTotalCents(lineItems: unknown): number | null {
  const items = readJsonArray(lineItems);
  if (items.length === 0) {
    return null;
  }

  let totalCents = 0;
  let foundAmount = false;
  for (const item of items) {
    const record = readJsonRecord(item);
    if (!record) {
      continue;
    }
    const unitAmountCents = dollarsToCents(record.unitAmount);
    if (unitAmountCents === null) {
      continue;
    }
    const quantity = readJsonNumber(record.quantity) ?? 1;
    totalCents += Math.round(unitAmountCents * quantity);
    foundAmount = true;
  }

  return foundAmount ? totalCents : null;
}

function readDocumentAmountCents(document: unknown): number | null {
  const record = readJsonRecord(document);
  if (!record) {
    return null;
  }

  return dollarsToCents(record.total) ?? readLineItemTotalCents(record.lineItems);
}

function readFirstDocumentAmountCents(documents: unknown): number | null {
  const firstDocument = readJsonArray(documents)[0];
  return firstDocument ? readDocumentAmountCents(firstDocument) : null;
}

export function readStoredXeroAmountCents(payload: unknown): number | null {
  const record = readJsonRecord(payload);
  if (!record) {
    return null;
  }

  const directAmount = readJsonNumber(record.amountCents);
  if (directAmount !== null) {
    return directAmount;
  }

  const refundAmount = readJsonNumber(record.refundAmountCents);
  if (refundAmount !== null) {
    return refundAmount;
  }

  const priceDiffCents = readJsonNumber(record.priceDiffCents);
  const changeFeeCents = readJsonNumber(record.changeFeeCents);
  if (priceDiffCents !== null || changeFeeCents !== null) {
    return (priceDiffCents ?? 0) + (changeFeeCents ?? 0);
  }

  return (
    readFirstDocumentAmountCents(record.invoices) ??
    readFirstDocumentAmountCents(record.creditNotes) ??
    readDocumentAmountCents(record.invoice) ??
    readDocumentAmountCents(record.creditNote)
  );
}

// #2868: `startOfDay` (a bare `setHours(0, 0, 0, 0)` wrapper) and `addDays` (its
// local-calendar partner) were DELETED rather than fixed. Their only two callers
// were the repair scope window in `xero-booking-repair-load.ts`, which now
// derives its bounds from `@/lib/date-only` — a date-only value for the
// `@db.Date` `Booking.checkIn` and a club-zone start-of-day instant for the
// three `DateTime` columns beside it. An exported local-midnight helper is not
// a thing this file should offer: it hides the truncation from a `setHours`
// grep at the call site, which is exactly how this defect outlived #2684's
// inventory and #2838's census (INV-DATE-013). Anything needing either shape
// takes it from `@/lib/date-only`, where the receiver contract is documented.

export function createCountMap(items: string[]): Record<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    counts.set(item, (counts.get(item) ?? 0) + 1);
  }
  return Object.fromEntries(
    Array.from(counts.entries()).sort(([left], [right]) => left.localeCompare(right))
  );
}
