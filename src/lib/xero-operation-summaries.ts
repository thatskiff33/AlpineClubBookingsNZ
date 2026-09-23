import { redactSensitiveRecord } from "@/lib/redact-sensitive-json";
import { formatCents } from "@/lib/utils";
import { providerAmountToCents } from "@/lib/money-provider-amount";
import type { ClubFormat } from "@/lib/club-format";

/**
 * Plain-English summaries of Xero sync operations for the admin Xero
 * operations panel (#1448). A treasurer expanding an operation should be able
 * to read what happened without parsing the raw Xero request/response JSON.
 *
 * Framework-agnostic, pure TypeScript with no server-only imports so it can run
 * inside the client `operations-panel.tsx`. The only dependencies are the
 * object-level redactor and the shared cents formatter.
 *
 * Redaction: every summary is built from data that has ALREADY passed through
 * `redactSensitiveRecord` (the object-level counterpart to the
 * `formatRedactedJson` string formatter the raw view uses, and the same limits —
 * the STORED-record ones, because a depth cap tuned for a log line would change
 * what this panel counts). Any secret/PII field the redaction would mask is
 * `"[REDACTED]"` before a value is read out of it, so a summary can never
 * surface a value the raw JSON view would have hidden.
 *
 * Keys are matched on `(entityType, operationType)` plus payload-shape sniffing.
 * The denormalized `queueType` column is dropped from `requestPayload` once a
 * handler runs (it overwrites the payload with the real Xero request), so we
 * read `queueType` from the payload only when it is still present (PENDING /
 * failed-before-dispatch rows) and otherwise sniff the persisted Xero shape.
 * Unknown / unmapped shapes return `null` so the panel falls back to raw JSON.
 */

interface XeroOperationSummaryFact {
  label: string;
  value: string;
}

export interface XeroOperationSummary {
  title: string;
  facts: XeroOperationSummaryFact[];
}

export interface XeroOperationSummaryInput {
  entityType: string;
  operationType: string;
  requestPayload: unknown;
  responsePayload: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function firstArrayItem(value: unknown): Record<string, unknown> | null {
  return Array.isArray(value) ? asRecord(value[0]) : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function readNumberLike(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/** Integer-cent money, formatted with the shared cents helper. */
function formatCentsValue(value: unknown, format: ClubFormat): string | null {
  const cents = readNumberLike(value);
  if (cents === null) return null;
  return formatCents(Math.round(cents), format);
}

/**
 * Xero API amounts are decimal dollars; normalize to integer cents so the same
 * cents-only helper renders them. This is a unit conversion, not a hand-rolled
 * currency formatter — the actual formatting still goes through `formatCents`.
 */
function formatDollarsValue(value: unknown, format: ClubFormat): string | null {
  const cents = providerAmountToCents(readNumberLike(value));
  if (cents === null) return null;
  return formatCents(cents, format);
}

function shortId(value: unknown): string | null {
  const id = readString(value);
  if (!id) return null;
  return id.length > 12 ? `${id.slice(0, 12)}...` : id;
}

function truncate(value: string, max = 80): string {
  return value.length > max ? `${value.slice(0, max - 1)}...` : value;
}

class FactList {
  private readonly facts: XeroOperationSummaryFact[] = [];

  add(label: string, value: string | null | undefined): this {
    if (value !== null && value !== undefined && value !== "") {
      this.facts.push({ label, value });
    }
    return this;
  }

  get length(): number {
    return this.facts.length;
  }

  build(): XeroOperationSummaryFact[] {
    return this.facts;
  }
}

// ---------------------------------------------------------------------------
// Queued outbox payloads (rows still carrying `requestPayload.queueType`).
// ---------------------------------------------------------------------------

function summarizeQueuedPayload(
  queueType: string,
  req: Record<string, unknown>,
  format: ClubFormat,
): XeroOperationSummary | null {
  const facts = new FactList();

  switch (queueType) {
    case "BOOKING_INVOICE":
      facts.add("Booking", shortId(req.bookingId));
      return { title: "Queued: create booking invoice", facts: facts.build() };

    case "ENTRANCE_FEE_INVOICE":
      facts
        .add("Category", readString(req.category))
        .add("Fee", formatCentsValue(req.feeAmountCents, format))
        .add("Item code", readString(req.itemCode))
        .add("Description", readString(req.description));
      return {
        title: "Queued: create entrance-fee invoice",
        facts: facts.build(),
      };

    case "SUPPLEMENTARY_INVOICE": {
      const priceDiff = readNumberLike(req.priceDiffCents);
      const changeFee = readNumberLike(req.changeFeeCents);
      facts
        .add("Booking", shortId(req.bookingId))
        .add("Price difference", formatCentsValue(req.priceDiffCents, format))
        .add("Change fee", formatCentsValue(req.changeFeeCents, format));
      if (priceDiff !== null && changeFee !== null) {
        facts.add("Net to bill", formatCentsValue(priceDiff + changeFee, format));
      }
      const waiting = readBoolean(req.waitForConfirmedAdditionalPayment);
      if (waiting === true) {
        facts.add("Status", "Waiting for confirmed additional payment");
      }
      facts.add("Booking modification", shortId(req.bookingModificationId));
      return {
        title: "Queued: create supplementary invoice",
        facts: facts.build(),
      };
    }

    case "GROUP_SETTLEMENT_INVOICE":
      facts.add("Settlement", shortId(req.settlementId));
      return {
        title: "Queued: create group-settlement invoice",
        facts: facts.build(),
      };

    case "GROUP_SETTLEMENT_INVOICE_VOID":
      facts.add("Settlement", shortId(req.settlementId));
      return {
        title: "Queued: void cancelled group-settlement invoice",
        facts: facts.build(),
      };

    case "BOOKING_INVOICE_UPDATE":
      facts
        .add("Booking", shortId(req.bookingId))
        .add("Xero invoice", shortId(req.xeroInvoiceId));
      if (readBoolean(req.skippedByPolicy) === true) {
        facts.add("Skipped by policy", readString(req.reason) ?? "Yes");
      }
      return { title: "Queued: update booking invoice", facts: facts.build() };

    case "REFUND_CREDIT_NOTE":
      facts
        .add("Refund amount", formatCentsValue(req.refundAmountCents, format))
        .add("Covers refunds up to", formatCentsValue(req.watermarkCents, format));
      return {
        title: "Queued: create refund credit note",
        facts: facts.build(),
      };

    case "ACCOUNT_CREDIT_NOTE":
      facts.add("Credit amount", formatCentsValue(req.refundAmountCents, format));
      return {
        title: "Queued: create account-credit note",
        facts: facts.build(),
      };

    case "MODIFICATION_CREDIT_NOTE":
      facts
        .add("Booking", shortId(req.bookingId))
        .add("Refund amount", formatCentsValue(req.refundAmountCents, format))
        .add("Booking modification", shortId(req.bookingModificationId));
      return {
        title: "Queued: create modification credit note",
        facts: facts.build(),
      };

    case "MODIFICATION_ACCOUNT_CREDIT_NOTE":
      facts
        .add("Booking", shortId(req.bookingId))
        .add("Payment", shortId(req.paymentId))
        .add("Refund amount", formatCentsValue(req.refundAmountCents, format))
        .add("Booking modification", shortId(req.bookingModificationId));
      return {
        title: "Queued: create modification account-credit note",
        facts: facts.build(),
      };

    case "CREDIT_NOTE_ALLOCATION":
      facts
        .add("Amount", formatCentsValue(req.amountCents, format))
        .add("Credit note", shortId(req.creditNoteId))
        .add("Invoice", shortId(req.invoiceId))
        .add("Role", readString(req.role));
      return {
        title: "Queued: allocate credit note to invoice",
        facts: facts.build(),
      };

    case "APPLIED_CREDIT_DEALLOCATION": {
      facts.add("Booking", shortId(req.bookingId));
      const checkpoint = asRecord(req.checkpoint);
      if (checkpoint) {
        facts
          .add("Credit note", shortId(checkpoint.creditNoteId))
          .add("Current allocation", formatCentsValue(checkpoint.currentCents, format))
          .add("Target allocation", formatCentsValue(checkpoint.targetCents, format))
          .add("Recovery phase", readString(checkpoint.phase));
      }
      return {
        title: "Queued: reduce applied credit on Xero invoice",
        facts: facts.build(),
      };
    }

    case "MEMBERSHIP_CANCELLATION_CREDIT_NOTE":
      facts
        .add("Subscription", shortId(req.subscriptionId))
        .add("Participant", shortId(req.participantId));
      return {
        title: "Queued: create membership-cancellation credit note",
        facts: facts.build(),
      };

    case "MEMBERSHIP_CANCELLATION_CONTACT":
      facts
        .add("Member", shortId(req.memberId))
        .add("Participant", shortId(req.participantId));
      return {
        title: "Queued: archive membership-cancellation contact",
        facts: facts.build(),
      };

    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Persisted Xero API shapes (rows whose handler has overwritten the payload).
// ---------------------------------------------------------------------------

function findInvoice(record: Record<string, unknown> | null) {
  if (!record) return null;
  return (
    firstArrayItem(record.invoices) ??
    firstArrayItem(asRecord(record.invoice)?.invoices)
  );
}

function findCreditNote(record: Record<string, unknown> | null) {
  if (!record) return null;
  return (
    firstArrayItem(record.creditNotes) ??
    firstArrayItem(asRecord(record.creditNote)?.creditNotes) ??
    firstArrayItem(asRecord(record.body)?.creditNotes)
  );
}

function lineItemsSummary(
  lineItems: unknown
): { count: number; descriptions: string } | null {
  if (!Array.isArray(lineItems) || lineItems.length === 0) return null;
  const descriptions = lineItems
    .map((item) => readString(asRecord(item)?.description))
    .filter((description): description is string => description !== null);
  return {
    count: lineItems.length,
    descriptions: truncate(descriptions.slice(0, 4).join("; ")),
  };
}

function summarizeInvoice(
  operationType: string,
  req: Record<string, unknown> | null,
  res: Record<string, unknown> | null,
  format: ClubFormat,
): XeroOperationSummary | null {
  const requestInvoice = findInvoice(req);
  const responseInvoice = findInvoice(res);
  if (!requestInvoice && !responseInvoice) return null;

  const facts = new FactList();
  facts
    .add(
      "Reference",
      readString(responseInvoice?.reference) ?? readString(requestInvoice?.reference)
    )
    .add(
      "Invoice number",
      readString(responseInvoice?.invoiceNumber) ??
        readString(requestInvoice?.invoiceNumber)
    )
    .add("Contact", shortId(asRecord(requestInvoice?.contact)?.contactID));

  const lines = lineItemsSummary(
    requestInvoice?.lineItems ?? responseInvoice?.lineItems
  );
  if (lines) {
    facts.add("Line items", String(lines.count));
    facts.add("Lines", lines.descriptions || null);
  }

  facts
    .add("Total", formatDollarsValue(responseInvoice?.total, format))
    .add("Amount due", formatDollarsValue(responseInvoice?.amountDue, format))
    .add(
      "Status",
      readString(responseInvoice?.status) ?? readString(requestInvoice?.status)
    );

  if (facts.length === 0) return null;
  return {
    title:
      operationType === "UPDATE"
        ? "Update invoice in Xero"
        : "Create invoice in Xero",
    facts: facts.build(),
  };
}

function summarizeCreditNote(
  req: Record<string, unknown> | null,
  res: Record<string, unknown> | null,
  format: ClubFormat,
): XeroOperationSummary | null {
  const existingCreditNoteId = shortId(res?.existingCreditNoteId);
  if (existingCreditNoteId) {
    return {
      title: "Reused existing credit note",
      facts: new FactList().add("Credit note", existingCreditNoteId).build(),
    };
  }

  const requestNote = findCreditNote(req);
  const responseNote = findCreditNote(res);
  if (!requestNote && !responseNote) return null;

  const facts = new FactList();
  facts
    .add(
      "Reference",
      readString(responseNote?.reference) ?? readString(requestNote?.reference)
    )
    .add(
      "Credit note number",
      readString(responseNote?.creditNoteNumber) ??
        readString(requestNote?.creditNoteNumber)
    );

  const lines = lineItemsSummary(
    requestNote?.lineItems ?? responseNote?.lineItems
  );
  if (lines) {
    facts.add("Line items", String(lines.count));
    facts.add("Lines", lines.descriptions || null);
  }

  facts
    .add("Total", formatDollarsValue(responseNote?.total, format))
    .add(
      "Status",
      readString(responseNote?.status) ?? readString(requestNote?.status)
    );

  const allocation = asRecord(req?.allocation);
  if (allocation) {
    facts
      .add("Allocated", formatDollarsValue(allocation.amount, format))
      .add("Allocated to invoice", shortId(allocation.invoiceId));
  }

  if (facts.length === 0) return null;
  return { title: "Create credit note in Xero", facts: facts.build() };
}

function summarizeAllocation(
  req: Record<string, unknown> | null,
  res: Record<string, unknown> | null,
  format: ClubFormat,
): XeroOperationSummary | null {
  if (!req) return null;
  const responseAllocation = firstArrayItem(res?.allocations);
  const facts = new FactList();
  facts
    .add(
      "Amount",
      formatCentsValue(req.amountCents, format) ??
        formatDollarsValue(responseAllocation?.amount, format)
    )
    .add("Credit note", shortId(req.creditNoteId))
    .add("Invoice", shortId(req.invoiceId))
    .add("Role", readString(req.role));

  if (facts.length === 0) return null;
  return { title: "Allocate credit note to invoice", facts: facts.build() };
}

function groupNames(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const names = value
    .map((group) => readString(asRecord(group)?.name))
    .filter((name): name is string => name !== null);
  return names.length > 0 ? truncate(names.join(", ")) : null;
}

function summarizeContactGroupSync(
  req: Record<string, unknown> | null,
  res: Record<string, unknown> | null
): XeroOperationSummary | null {
  if (!req && !res) return null;
  const facts = new FactList();
  facts
    // The member id, not a composed name: the name is no longer written into
    // the stored payload (INV-PRIV-011, #2683), and every other identifying
    // fact in this panel is a shortened id already.
    .add("Member", shortId(req?.memberId))
    .add("Age tier", readString(req?.ageTier))
    .add("Default group", readString(asRecord(req?.defaultGroup)?.name));

  const added = Array.isArray(res?.addedGroupIds) ? res.addedGroupIds.length : null;
  const removed = Array.isArray(res?.removedGroupIds)
    ? res.removedGroupIds.length
    : null;
  if (added !== null) facts.add("Groups added", String(added));
  if (removed !== null) facts.add("Groups removed", String(removed));
  facts.add("Resulting groups", groupNames(res?.resultingGroups));

  if (facts.length === 0) return null;
  return { title: "Sync managed Xero contact groups", facts: facts.build() };
}

/**
 * Produce a plain-English summary for a Xero sync operation, or `null` when the
 * shape is not mapped (the panel then falls back to the raw JSON view).
 */
export function summarizeXeroOperation(
  input: XeroOperationSummaryInput
): XeroOperationSummary | null {
  // The stored-record limits, not the log cap: these are already-persisted,
  // already-redacted payloads being re-read to build the panel's summary, and a
  // depth-6 cut would silently change what the summary counts and reports.
  const req = asRecord(redactSensitiveRecord(input.requestPayload ?? null));
  const res = asRecord(redactSensitiveRecord(input.responsePayload ?? null));

  const queueType = req ? readString(req.queueType) : null;
  if (queueType) {
    const queued = summarizeQueuedPayload(queueType, req!);
    if (queued) return queued;
  }

  switch (input.entityType) {
    case "INVOICE":
      return summarizeInvoice(input.operationType, req, res);
    case "CREDIT_NOTE":
      return summarizeCreditNote(req, res);
    case "ALLOCATION":
      return summarizeAllocation(req, res);
    case "CONTACT_GROUP":
      return input.operationType === "SYNC_MANAGED_MEMBERSHIP"
        ? summarizeContactGroupSync(req, res)
        : null;
    default:
      return null;
  }
}
