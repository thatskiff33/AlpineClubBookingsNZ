import { PaymentSource } from "@prisma/client";
import { prisma } from "./prisma";
import {
  deriveBookingAppliedCreditCents,
  lockMemberCreditLedger,
} from "./member-credit";
import { callXeroApi, getAuthenticatedXeroClient } from "./xero-api-client";
import { readClubTimeZoneOutsideRequest } from "@/lib/club-time-zone-runtime";
import { xeroDocumentDateForClubToday } from "@/lib/xero-provider-dates";
import { requireContainedXeroContactForInvoiceOperation } from "@/lib/xero-contact-containment-proof";
import {
  buildXeroIdempotencyKey,
  completeXeroSyncOperation,
  sanitizeForJson,
} from "./xero-sync";
import {
  XERO_OUTBOX_APPLIED_CREDIT_ALLOCATION_TYPE,
  XERO_OUTBOX_APPLIED_CREDIT_DEALLOCATION_TYPE,
} from "./xero-operation-outbox-payload";
import {
  assertNoAppliedCreditDeallocationFence,
  XeroAppliedCreditDeallocationEventualConsistencyError,
  XeroAppliedCreditOperationBusyError,
} from "./xero-applied-credit-operation-serialization";
import { repairLegacyAppliedCreditNoteAllocationsForBooking } from "./xero-applied-credit-allocation-repair";
import { exactProviderAmountToCents } from "@/lib/money-provider-amount";

const APPLIED_CREDIT_ALLOCATION_ROLE = "APPLIED_CREDIT_ALLOCATION";
const APPLIED_CREDIT_REMAINDER_ALLOCATION_ROLE =
  "APPLIED_CREDIT_REMAINDER_ALLOCATION";

// Bounded backstop for the eventual-consistency requeue path (#1924). Xero's
// read-after-write is not guaranteed, so a stale re-GET immediately after a
// delete+recreate — or on the next retry's top-of-loop guard — is classified
// transient and returned to PENDING (see
// XeroAppliedCreditDeallocationEventualConsistencyError) rather than terminal
// FAILED. Convergence normally happens within seconds; this cap ensures a note
// that never converges still lands FAILED for the operator instead of looping
// forever. The counts are persisted on the operation payload
// (`eventualConsistencyRequeues`) so they survive each PENDING→RUNNING reclaim.
//
// The budget is PER credit note (#1924 review follow-up): the group loop aborts
// on the first stale note, so a single operation-level counter shared across a
// multi-note deallocation could be exhausted by several individually-converging
// notes and land the whole operation terminal FAILED spuriously. Each
// xeroCreditNoteId gets its own 0..MAX budget instead.
const MAX_EVENTUAL_CONSISTENCY_REQUEUES = 10;

interface DeallocationRow {
  id: string;
  xeroCreditNoteId: string;
  amountCents: number;
  createdAt: Date;
}

interface AppliedCreditDeallocationSnapshot {
  desiredAppliedCents: number;
  rows: Array<{
    id: string;
    xeroCreditNoteId: string;
    amountCents: number;
    createdAt: string;
  }>;
}

function snapshotsEqual(
  left: AppliedCreditDeallocationSnapshot,
  right: AppliedCreditDeallocationSnapshot,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function readStoredSnapshot(value: unknown): AppliedCreditDeallocationSnapshot | null {
  const record = metadataRecord(value);
  if (
    !record ||
    !Number.isInteger(record.desiredAppliedCents) ||
    (record.desiredAppliedCents as number) < 0 ||
    !Array.isArray(record.rows)
  ) {
    return null;
  }
  const rows: AppliedCreditDeallocationSnapshot["rows"] = [];
  for (const item of record.rows) {
    const row = metadataRecord(item);
    if (
      typeof row?.id !== "string" ||
      typeof row.xeroCreditNoteId !== "string" ||
      !Number.isInteger(row.amountCents) ||
      (row.amountCents as number) <= 0 ||
      typeof row.createdAt !== "string" ||
      Number.isNaN(new Date(row.createdAt).getTime())
    ) {
      return null;
    }
    rows.push({
      id: row.id,
      xeroCreditNoteId: row.xeroCreditNoteId,
      amountCents: row.amountCents as number,
      createdAt: row.createdAt,
    });
  }
  return {
    desiredAppliedCents: record.desiredAppliedCents as number,
    rows,
  };
}

export interface PlannedAppliedCreditDeallocationGroup {
  xeroCreditNoteId: string;
  currentCents: number;
  targetCents: number;
  rowTargets: Array<{ id: string; currentCents: number; targetCents: number }>;
}

/** Reduce newest slices first; lot order is conservation-neutral. */
export function planAppliedCreditDeallocation(
  rows: DeallocationRow[],
  desiredAppliedCents: number
): PlannedAppliedCreditDeallocationGroup[] {
  const total = rows.reduce((sum, row) => sum + row.amountCents, 0);
  let toRelease = Math.max(0, total - Math.max(0, desiredAppliedCents));
  const targets = new Map<string, number>();
  for (const row of [...rows].sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id)
  )) {
    const released = Math.min(row.amountCents, toRelease);
    targets.set(row.id, row.amountCents - released);
    toRelease -= released;
  }

  const groups = new Map<string, PlannedAppliedCreditDeallocationGroup>();
  for (const row of rows) {
    const targetCents = targets.get(row.id) ?? row.amountCents;
    const group = groups.get(row.xeroCreditNoteId) ?? {
      xeroCreditNoteId: row.xeroCreditNoteId,
      currentCents: 0,
      targetCents: 0,
      rowTargets: [],
    };
    group.currentCents += row.amountCents;
    group.targetCents += targetCents;
    group.rowTargets.push({ id: row.id, currentCents: row.amountCents, targetCents });
    groups.set(row.xeroCreditNoteId, group);
  }
  return [...groups.values()].filter((group) => group.targetCents < group.currentCents);
}

type ProviderAllocation = { allocationID: string; amountCents: number };

type AllocationLinkSnapshot = {
  id: string;
  localModel: string;
  localId: string;
  xeroObjectId: string;
  role: string;
  metadata: unknown;
};

function metadataRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function linkMatchesGroup(
  link: AllocationLinkSnapshot,
  creditNoteId: string,
  invoiceId: string
): boolean {
  const metadata = metadataRecord(link.metadata);
  return (
    metadata?.creditNoteId === creditNoteId && metadata?.invoiceId === invoiceId
  );
}

function linkedCurrentCents(links: AllocationLinkSnapshot[]): number | null {
  if (links.length === 0) return null;
  const byAnchor = new Map<string, number>();
  for (const link of links) {
    const metadata = metadataRecord(link.metadata);
    const value =
      typeof metadata?.rowTargetCents === "number"
        ? metadata.rowTargetCents
        : typeof metadata?.amountCents === "number"
          ? metadata.amountCents
          : null;
    if (value === null || !Number.isInteger(value) || value < 0) return null;
    const anchor = `${link.localModel}:${link.localId}:${link.role}`;
    const existing = byAnchor.get(anchor);
    if (existing !== undefined && existing !== value) return null;
    byAnchor.set(anchor, value);
  }
  return [...byAnchor.values()].reduce((sum, value) => sum + value, 0);
}

async function readAffectedLinks(params: {
  paymentId: string;
  invoiceId: string;
  group: PlannedAppliedCreditDeallocationGroup;
}): Promise<AllocationLinkSnapshot[]> {
  const rowIds = params.group.rowTargets.map((row) => row.id);
  const links = await prisma.xeroObjectLink.findMany({
    where: {
      active: true,
      xeroObjectType: "ALLOCATION",
      OR: [
        {
          localModel: "MemberCreditNoteAllocation",
          localId: { in: rowIds },
          role: APPLIED_CREDIT_ALLOCATION_ROLE,
        },
        {
          localModel: "Payment",
          localId: params.paymentId,
          role: APPLIED_CREDIT_REMAINDER_ALLOCATION_ROLE,
        },
      ],
    },
    select: {
      id: true,
      localModel: true,
      localId: true,
      xeroObjectId: true,
      role: true,
      metadata: true,
    },
  });
  return links.filter((link) =>
    linkMatchesGroup(
      link,
      params.group.xeroCreditNoteId,
      params.invoiceId
    )
  );
}

function centsFromXeroAmount(amount: unknown): number | null {
  // Sub-cent precision is refused rather than rounded: this reads an allocation
  // back from Xero to reconcile it, so inventing a cent would manufacture
  // agreement that does not exist (#2685).
  return exactProviderAmountToCents(amount);
}

async function readInvoiceAllocations(
  creditNoteId: string,
  invoiceId: string
): Promise<ProviderAllocation[]> {
  const { xero, tenantId } = await getAuthenticatedXeroClient();
  const response = await callXeroApi(
    () => xero.accountingApi.getCreditNote(tenantId, creditNoteId),
    {
      operation: "getCreditNote",
      resourceType: "CREDIT_NOTE",
      workflow: "deallocateExcessAppliedCreditForBooking",
      context: `getCreditNote(${creditNoteId})`,
    }
  );
  return (response.body.creditNotes?.[0]?.allocations ?? [])
    .filter((allocation) => allocation.invoice?.invoiceID === invoiceId)
    .map((allocation) => {
      const amountCents = centsFromXeroAmount(allocation.amount);
      if (!allocation.allocationID || amountCents === null) {
        throw new Error(
          `Xero allocation for credit note ${creditNoteId} and invoice ${invoiceId} has no safe ID/integer-cent amount`
        );
      }
      return { allocationID: allocation.allocationID, amountCents };
    });
}

function readCheckpointAllocations(value: unknown): ProviderAllocation[] {
  if (!Array.isArray(value)) return [];
  const result: ProviderAllocation[] = [];
  for (const item of value) {
    const record = metadataRecord(item);
    if (
      typeof record?.allocationID === "string" &&
      Number.isInteger(record.amountCents)
    ) {
      result.push({
        allocationID: record.allocationID,
        amountCents: record.amountCents as number,
      });
    }
  }
  return result;
}

/**
 * Whether an observed provider allocation set is explained purely by Xero
 * eventual consistency relative to a delete+recreate that has already been
 * issued (or checkpointed). Every visible allocation must be either one of the
 * `knownIds` (a just-deleted allocation still listed, or a previously-verified
 * one) or the single recreate of exactly `targetCents` (not yet retired), and
 * the total must be one of the stale projections of that transition:
 *   - `preTotal`               pre-delete state still visible, recreate not yet
 *   - `preTotal + targetCents` pre-delete state visible AND recreate visible
 *   - `0`                      deletes visible, recreate not yet visible
 * A foreign allocation (an unknown ID whose amount is not the recreate) or a
 * total outside these projections is NOT eventual-consistency-shaped and stays
 * fail-closed terminal.
 */
function isEventualConsistencyShapedTotal(params: {
  observed: ProviderAllocation[];
  providerTotal: number;
  knownIds: string[];
  preTotal: number;
  targetCents: number;
}): boolean {
  const { observed, providerTotal, knownIds, preTotal, targetCents } = params;
  const unknown = observed.filter(
    (allocation) => !knownIds.includes(allocation.allocationID),
  );
  const unknownIsSoleRecreate =
    unknown.length === 0 ||
    (unknown.length === 1 &&
      targetCents > 0 &&
      unknown[0].amountCents === targetCents);
  if (!unknownIsSoleRecreate) return false;
  return (
    providerTotal === preTotal ||
    providerTotal === preTotal + targetCents ||
    providerTotal === 0
  );
}

/**
 * Persist a bounded eventual-consistency requeue counter WITHOUT advancing any
 * durable snapshot/checkpoint state, then either raise the transient busy error
 * (so the outbox returns the row to PENDING for a backed-off retry) or, once the
 * cap is exceeded, raise a terminal error so the operation lands FAILED for the
 * operator. Makes no provider calls.
 */
async function requeueForEventualConsistency(params: {
  operationId: string;
  xeroCreditNoteId: string;
  detail: string;
}): Promise<never> {
  const current = await prisma.xeroSyncOperation.findUnique({
    where: { id: params.operationId },
    select: { requestPayload: true },
  });
  const payload = metadataRecord(current?.requestPayload) ?? {};
  // Per-note budget keyed by xeroCreditNoteId. Back-compat rule: a legacy
  // numeric value (the old single operation-level counter) is migrated as the
  // starting count for the note currently being requeued — the note that keeps
  // re-GETting stale is precisely the one that accrued that count, so
  // preserving it keeps a genuinely-stuck operation landing terminal instead of
  // resetting its progress to zero. Any other note starts fresh at 0.
  const rawCounter = payload.eventualConsistencyRequeues;
  const counter: Record<string, number> = {};
  if (typeof rawCounter === "number" && Number.isInteger(rawCounter)) {
    counter[params.xeroCreditNoteId] = rawCounter;
  } else {
    const record = metadataRecord(rawCounter);
    if (record) {
      for (const [note, value] of Object.entries(record)) {
        if (typeof value === "number" && Number.isInteger(value)) {
          counter[note] = value;
        }
      }
    }
  }
  const prior = counter[params.xeroCreditNoteId] ?? 0;
  const next = prior + 1;
  counter[params.xeroCreditNoteId] = next;
  await prisma.xeroSyncOperation.update({
    where: { id: params.operationId },
    data: {
      // Only the per-note counter changes; ledgerSnapshot/checkpoint/history are
      // carried through untouched so a transient outcome never advances
      // convergence state.
      requestPayload: sanitizeForJson({
        ...payload,
        eventualConsistencyRequeues: counter,
      }),
    },
  });
  if (next > MAX_EVENTUAL_CONSISTENCY_REQUEUES) {
    throw new Error(
      `Applied-credit deallocation ${params.operationId} did not converge after ${MAX_EVENTUAL_CONSISTENCY_REQUEUES} eventual-consistency requeues for credit note ${params.xeroCreditNoteId}: ${params.detail}`,
    );
  }
  throw new XeroAppliedCreditDeallocationEventualConsistencyError(
    `${params.detail}; Xero provider read not yet converged (eventual-consistency requeue ${next}/${MAX_EVENTUAL_CONSISTENCY_REQUEUES} for credit note ${params.xeroCreditNoteId})`,
  );
}

async function checkpoint(params: {
  operationId: string;
  bookingId: string;
  group: PlannedAppliedCreditDeallocationGroup;
  phase: "BEFORE_DELETE" | "PROVIDER_VERIFIED";
  providerAllocations: ProviderAllocation[];
  priorLinks: AllocationLinkSnapshot[];
  providerMatch: string;
}) {
  const current = await prisma.xeroSyncOperation.findUnique({
    where: { id: params.operationId },
    select: { requestPayload: true },
  });
  const payload = metadataRecord(current?.requestPayload) ?? {};
  const previousHistory = Array.isArray(payload.history)
    ? payload.history.filter(
        (entry): entry is Record<string, unknown> => metadataRecord(entry) !== null
      )
    : [];
  const entry = {
    creditNoteId: params.group.xeroCreditNoteId,
    currentCents: params.group.currentCents,
    targetCents: params.group.targetCents,
    rowTargets: params.group.rowTargets,
    phase: params.phase,
    providerMatch: params.providerMatch,
    providerAllocations: params.providerAllocations,
    allocationIds: params.providerAllocations.map(
      (allocation) => allocation.allocationID
    ),
    priorLinks: params.priorLinks.map((link) => ({
      id: link.id,
      localModel: link.localModel,
      localId: link.localId,
      xeroObjectId: link.xeroObjectId,
      role: link.role,
      metadata: link.metadata,
    })),
  };
  // Append rather than replace: BEFORE_DELETE and PROVIDER_VERIFIED are both
  // durable evidence, including every row's cents and the provider IDs seen at
  // that phase. This is the recovery/audit trail for multi-note and retry runs.
  const history = [...previousHistory, entry];
  await prisma.xeroSyncOperation.update({
    where: { id: params.operationId },
    data: {
      requestPayload: sanitizeForJson({
        ...payload,
        queueType: XERO_OUTBOX_APPLIED_CREDIT_DEALLOCATION_TYPE,
        bookingId: params.bookingId,
        checkpoint: entry,
        history,
      }),
    },
  });
}

async function applyLocalGroup(params: {
  operationId: string;
  bookingId: string;
  memberId: string;
  paymentId: string;
  invoiceId: string;
  group: PlannedAppliedCreditDeallocationGroup;
  providerAllocations: ProviderAllocation[];
  priorLinks: AllocationLinkSnapshot[];
}) {
  await prisma.$transaction(async (tx) => {
    await lockMemberCreditLedger(params.memberId, tx);
    const current = await tx.memberCreditNoteAllocation.findMany({
      where: { id: { in: params.group.rowTargets.map((row) => row.id) } },
      select: { id: true, amountCents: true },
    });
    const byId = new Map(current.map((row) => [row.id, row.amountCents]));
    const alreadyApplied = params.group.rowTargets.every((row) =>
      row.targetCents === 0 ? !byId.has(row.id) : byId.get(row.id) === row.targetCents
    );
    if (!alreadyApplied) {
      for (const row of params.group.rowTargets) {
        if (byId.get(row.id) !== row.currentCents) {
          throw new Error(`Applied-credit allocation row ${row.id} changed during Xero deallocation`);
        }
      }
      for (const row of params.group.rowTargets) {
        if (row.targetCents === 0) {
          await tx.memberCreditNoteAllocation.delete({ where: { id: row.id } });
        } else if (row.targetCents !== row.currentCents) {
          await tx.memberCreditNoteAllocation.update({
            where: { id: row.id },
            data: { amountCents: row.targetCents },
          });
        }
      }
    }
    const rowIds = params.group.rowTargets.map((row) => row.id);
    await tx.xeroObjectLink.updateMany({
      where: {
        xeroObjectType: "ALLOCATION",
        active: true,
        OR: [
          {
            localModel: "MemberCreditNoteAllocation",
            localId: { in: rowIds },
            role: APPLIED_CREDIT_ALLOCATION_ROLE,
          },
          {
            id: {
              in: params.priorLinks
                .filter(
                  (link) =>
                    link.localModel === "Payment" &&
                    link.role === APPLIED_CREDIT_REMAINDER_ALLOCATION_ROLE
                )
                .map((link) => link.id),
            },
          },
        ],
      },
      data: { active: false },
    });

    if (params.group.targetCents > 0) {
      const hasRemainderAnchor = params.priorLinks.some(
        (link) =>
          link.localModel === "Payment" &&
          link.role === APPLIED_CREDIT_REMAINDER_ALLOCATION_ROLE
      );
      const positiveRows = params.group.rowTargets.filter(
        (row) => row.targetCents > 0
      );
      const anchors = hasRemainderAnchor
        ? [
            {
              localModel: "Payment",
              localId: params.paymentId,
              role: APPLIED_CREDIT_REMAINDER_ALLOCATION_ROLE,
              targetCents: params.group.targetCents,
            },
          ]
        : positiveRows.map((row) => ({
            localModel: "MemberCreditNoteAllocation",
            localId: row.id,
            role: APPLIED_CREDIT_ALLOCATION_ROLE,
            targetCents: row.targetCents,
          }));

      for (const anchor of anchors) {
        for (const allocation of params.providerAllocations) {
          await tx.xeroObjectLink.upsert({
            where: {
              localModel_localId_xeroObjectType_xeroObjectId_role: {
                localModel: anchor.localModel,
                localId: anchor.localId,
                xeroObjectType: "ALLOCATION",
                xeroObjectId: allocation.allocationID,
                role: anchor.role,
              },
            },
            create: {
              localModel: anchor.localModel,
              localId: anchor.localId,
              xeroObjectType: "ALLOCATION",
              xeroObjectId: allocation.allocationID,
              role: anchor.role,
              active: true,
              metadata: sanitizeForJson({
                creditNoteId: params.group.xeroCreditNoteId,
                invoiceId: params.invoiceId,
                amountCents: allocation.amountCents,
                rowTargetCents: anchor.targetCents,
                providerAllocationIdVerified: true,
              }),
            },
            update: {
              active: true,
              metadata: sanitizeForJson({
                creditNoteId: params.group.xeroCreditNoteId,
                invoiceId: params.invoiceId,
                amountCents: allocation.amountCents,
                rowTargetCents: anchor.targetCents,
                providerAllocationIdVerified: true,
              }),
            },
          });
        }
      }
    }

    // Advance the durable fence atomically with each locally-applied provider-
    // verified group. A later group can fail after this commit; retry then sees
    // the advanced snapshot instead of rejecting its own proven local progress
    // as a competing mutation.
    const operation = await tx.xeroSyncOperation.findUnique({
      where: { id: params.operationId },
      select: { requestPayload: true },
    });
    const payload = metadataRecord(operation?.requestPayload) ?? {};
    const priorSnapshot = readStoredSnapshot(payload.ledgerSnapshot);
    if (!priorSnapshot) {
      throw new Error(
        `Applied-credit deallocation ${params.operationId} lost its durable ledger snapshot`,
      );
    }
    const remainingRows = await tx.memberCreditNoteAllocation.findMany({
      where: { appliedToBookingId: params.bookingId },
      select: {
        id: true,
        xeroCreditNoteId: true,
        amountCents: true,
        createdAt: true,
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    await tx.xeroSyncOperation.update({
      where: { id: params.operationId },
      data: {
        requestPayload: sanitizeForJson({
          ...payload,
          ledgerSnapshot: {
            desiredAppliedCents: priorSnapshot.desiredAppliedCents,
            rows: remainingRows.map((row) => ({
              id: row.id,
              xeroCreditNoteId: row.xeroCreditNoteId,
              amountCents: row.amountCents,
              createdAt: row.createdAt.toISOString(),
            })),
          },
        }),
      },
    });
  });
}

/**
 * Converges provider allocations to the current local applied-credit total.
 * GET supplies real Xero allocation IDs; any uncheckpointed mismatch fails
 * loudly rather than deleting a guessed/manual allocation.
 */
export async function deallocateExcessAppliedCreditForBooking(
  bookingId: string,
  options: { syncOperationId: string }
): Promise<void> {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: { payment: true },
  });
  if (
    !booking?.payment ||
    booking.payment.source !== PaymentSource.INTERNET_BANKING ||
    !booking.payment.xeroInvoiceId
  ) {
    await completeXeroSyncOperation(options.syncOperationId, {
      responsePayload: { skipped: true, reason: "No allocated Internet-Banking invoice." },
    });
    return;
  }

  /*
    INV-CONFIG-005 (#3036): deallocation REMOVES credit from an invoice, so it
    raises what is outstanding on it — and Xero emails reminders for an
    outstanding AUTHORISED invoice to the address on its contact, from its own
    servers. This path never touches `findOrCreateXeroContact`, so on a copy
    restored from the club's live database nothing here had ever looked at what
    that contact holds. Checked at the ENTRY POINT, before the fence or any local
    claim, so a refusal leaves nothing half-done.

    THE CONTACT IS THE INVOICE'S, and this module never reads the invoice — so it
    asks. That read is the reason the contact is supplied as a FUNCTION: it runs
    only after the policy says "contain", so the club's live site still spends
    nothing at all here. The first version of this check used the member's link
    instead, which is a different contact after a merge or an admin re-link, and
    therefore proved containment of a contact whose amount due this operation
    does not touch.
  */
  const invoiceIdForContainment = booking.payment.xeroInvoiceId;
  await requireContainedXeroContactForInvoiceOperation({
    resolveXeroContactId: async () => {
      const { xero, tenantId } = await getAuthenticatedXeroClient();
      const response = await callXeroApi(
        () => xero.accountingApi.getInvoice(tenantId, invoiceIdForContainment),
        {
          operation: "getInvoice",
          resourceType: "INVOICE",
          workflow: "deallocateExcessAppliedCreditForBooking",
          context: `containment getInvoice(${invoiceIdForContainment})`,
        }
      );
      return response.body.invoices?.[0]?.contact?.contactID;
    },
    memberId: booking.memberId,
    workflow: "deallocateExcessAppliedCreditForBooking",
  });

  const conflicting = await prisma.xeroSyncOperation.findFirst({
    where: {
      id: { not: options.syncOperationId },
      localModel: "Payment",
      localId: booking.payment.id,
      queueType: {
        in: [
          XERO_OUTBOX_APPLIED_CREDIT_ALLOCATION_TYPE,
          XERO_OUTBOX_APPLIED_CREDIT_DEALLOCATION_TYPE,
        ],
      },
      status: "RUNNING",
    },
    select: { id: true },
  });
  if (conflicting) {
    throw new XeroAppliedCreditOperationBusyError(
      `Applied-credit operation ${conflicting.id} is still running; retrying deallocation`
    );
  }

  const snapshot = await prisma.$transaction(async (tx) => {
    await lockMemberCreditLedger(booking.memberId, tx);
    await assertNoAppliedCreditDeallocationFence(booking.payment!.id, tx, {
      excludeOperationId: options.syncOperationId,
      allowUncheckpointedPending: true,
    });
    await repairLegacyAppliedCreditNoteAllocationsForBooking(
      bookingId,
      booking.payment!.xeroInvoiceId!,
      tx,
    );
    const desiredAppliedCents = await deriveBookingAppliedCreditCents(bookingId, tx);
    const rows = await tx.memberCreditNoteAllocation.findMany({
      where: { appliedToBookingId: bookingId },
      select: {
        id: true,
        xeroCreditNoteId: true,
        amountCents: true,
        createdAt: true,
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    const currentSnapshot: AppliedCreditDeallocationSnapshot = {
      desiredAppliedCents,
      rows: rows.map((row) => ({
        id: row.id,
        xeroCreditNoteId: row.xeroCreditNoteId,
        amountCents: row.amountCents,
        createdAt: row.createdAt.toISOString(),
      })),
    };
    const operation = await tx.xeroSyncOperation.findUnique({
      where: { id: options.syncOperationId },
      select: { requestPayload: true },
    });
    const payload = metadataRecord(operation?.requestPayload) ?? {};
    const storedSnapshot = readStoredSnapshot(payload.ledgerSnapshot);
    if (payload.ledgerSnapshot !== undefined && !storedSnapshot) {
      throw new Error(
        `Applied-credit deallocation ${options.syncOperationId} has a malformed durable ledger snapshot`,
      );
    }
    if (storedSnapshot && !snapshotsEqual(storedSnapshot, currentSnapshot)) {
      throw new Error(
        `Applied-credit ledger changed after deallocation snapshot for operation ${options.syncOperationId}; refusing a stale provider target`,
      );
    }
    if (!storedSnapshot) {
      await tx.xeroSyncOperation.update({
        where: { id: options.syncOperationId },
        data: {
          requestPayload: sanitizeForJson({
            ...payload,
            queueType: XERO_OUTBOX_APPLIED_CREDIT_DEALLOCATION_TYPE,
            bookingId,
            ledgerSnapshot: currentSnapshot,
          }),
        },
      });
    }
    return storedSnapshot ?? currentSnapshot;
  });

  const desiredAppliedCents = snapshot.desiredAppliedCents;
  const rows: DeallocationRow[] = snapshot.rows.map((row) => ({
    ...row,
    createdAt: new Date(row.createdAt),
  }));
  const groups = planAppliedCreditDeallocation(rows, desiredAppliedCents);
  const { xero, tenantId } = await getAuthenticatedXeroClient();

  for (const group of groups) {
    const priorLinks = await readAffectedLinks({
      paymentId: booking.payment.id,
      invoiceId: booking.payment.xeroInvoiceId,
      group,
    });
    let provider = await readInvoiceAllocations(
      group.xeroCreditNoteId,
      booking.payment.xeroInvoiceId
    );
    let providerTotal = provider.reduce((sum, allocation) => sum + allocation.amountCents, 0);
    const operation = await prisma.xeroSyncOperation.findUnique({
      where: { id: options.syncOperationId },
      select: { requestPayload: true },
    });
    const payload = operation?.requestPayload as Record<string, unknown> | null;
    const saved = payload?.checkpoint as Record<string, unknown> | undefined;
    const savedIds = Array.isArray(saved?.allocationIds)
      ? saved.allocationIds.filter((id): id is string => typeof id === "string")
      : [];
    const checkpointMatchesGroup =
      saved?.creditNoteId === group.xeroCreditNoteId &&
      saved?.currentCents === group.currentCents &&
      saved?.targetCents === group.targetCents;
    const currentTotalHasLocalProvenance =
      providerTotal === group.currentCents &&
      linkedCurrentCents(priorLinks) === group.currentCents;
    const targetTotalHasCheckpointProvenance =
      providerTotal === group.targetCents && checkpointMatchesGroup;
    const checkpointedPartial =
      checkpointMatchesGroup &&
      providerTotal < group.currentCents &&
      provider.every((allocation) => savedIds.includes(allocation.allocationID));
    if (
      !currentTotalHasLocalProvenance &&
      !targetTotalHasCheckpointProvenance &&
      !checkpointedPartial
    ) {
      // Symmetric to the post-recreate verification below (#1924): a durable
      // checkpoint for THIS group proves we already issued the delete+recreate,
      // so a top-of-loop re-GET that lists the just-deleted allocations again
      // alongside the recreate (providerTotal > currentCents) — or any other
      // stale projection whose IDs are all checkpointed-or-recreate — is Xero
      // eventual consistency, not a genuine external mutation. Requeue with
      // backoff instead of throwing the terminal ambiguity error. A total or ID
      // set NOT explained by that transition stays fail-closed below.
      const savedProviderTotal = readCheckpointAllocations(
        saved?.providerAllocations,
      ).reduce((sum, allocation) => sum + allocation.amountCents, 0);
      const eventualConsistencyStale =
        checkpointMatchesGroup &&
        savedIds.length > 0 &&
        isEventualConsistencyShapedTotal({
          observed: provider,
          providerTotal,
          knownIds: savedIds,
          preTotal: savedProviderTotal,
          targetCents: group.targetCents,
        }) &&
        providerTotal !== group.targetCents;
      if (eventualConsistencyStale) {
        await requeueForEventualConsistency({
          operationId: options.syncOperationId,
          xeroCreditNoteId: group.xeroCreditNoteId,
          detail: `Stale top-of-loop provider allocations for credit note ${group.xeroCreditNoteId}: provider=${providerTotal}c current=${group.currentCents}c target=${group.targetCents}c`,
        });
      }
      throw new Error(
        `Ambiguous Xero allocation total/provenance for credit note ${group.xeroCreditNoteId}: provider=${providerTotal}c local=${group.currentCents}c target=${group.targetCents}c; no matching active local links or durable checkpoint prove these provider allocation IDs`
      );
    }

    if (providerTotal !== group.targetCents) {
      await checkpoint({
        operationId: options.syncOperationId,
        bookingId,
        group,
        phase: "BEFORE_DELETE",
        providerAllocations: provider,
        priorLinks,
        providerMatch: checkpointedPartial
          ? "CHECKPOINTED_PARTIAL_PROVIDER_IDS"
          : "LOCAL_LINK_TOTAL_AND_XERO_NOTE_INVOICE_MATCH",
      });
      for (const allocation of provider) {
        await callXeroApi(
          () => xero.accountingApi.deleteCreditNoteAllocations(
            tenantId, group.xeroCreditNoteId, allocation.allocationID
          ),
          {
            operation: "deleteCreditNoteAllocations",
            resourceType: "ALLOCATION",
            workflow: "deallocateExcessAppliedCreditForBooking",
            context: `deleteCreditNoteAllocations(${group.xeroCreditNoteId}, ${allocation.allocationID})`,
          }
        );
      }
      if (group.targetCents > 0) {
        // The recreate idempotency key MUST be scoped to this specific
        // deallocation operation. Two distinct operations on the same
        // note/invoice with the same currentCents->targetCents transition
        // (e.g. reprice down -> re-allocate on reprice up -> reprice down
        // again, all within Xero's ~24h idempotency-key retention) would
        // otherwise share a key: the second op's recreate would return the
        // first op's cached response and create nothing, under-clearing the
        // invoice by targetCents and fencing cancellation/IB expiry until the
        // key expires. syncOperationId is fixed when the operation row is
        // created, so it is stable across crash-retries of the SAME operation
        // (the property we need) yet distinct across separate operations.
        if (!options.syncOperationId) {
          throw new Error(
            `Refusing to build a deallocation-recreate idempotency key without a syncOperationId for credit note ${group.xeroCreditNoteId}: an operation-scoped discriminator is required to avoid cross-operation cache collisions`
          );
        }
        const idempotencyKey = buildXeroIdempotencyKey(
          "credit-note", group.xeroCreditNoteId, "invoice", booking.payment.xeroInvoiceId,
          "deallocation-recreate", group.currentCents, group.targetCents,
          "op", options.syncOperationId, "v2"
        );
        // The recreated allocation is dated on the club's calendar, not the UTC
        // day (INV-DATE-019, #2834), read ONCE outside the closure: `callXeroApi`
        // re-invokes its callback on every retry attempt, so a read inside it
        // would send a different date on a retry that crossed club midnight,
        // under the same idempotency key.
        const recreatedAllocationDate = xeroDocumentDateForClubToday(await readClubTimeZoneOutsideRequest());
        await callXeroApi(
          () => xero.accountingApi.createCreditNoteAllocation(
            tenantId,
            group.xeroCreditNoteId,
            { allocations: [{
              invoice: { invoiceID: booking.payment!.xeroInvoiceId! },
              amount: group.targetCents / 100,
              date: recreatedAllocationDate,
            }] },
            undefined,
            idempotencyKey
          ),
          {
            operation: "createCreditNoteAllocation",
            resourceType: "ALLOCATION",
            workflow: "deallocateExcessAppliedCreditForBooking",
            context: `recreateCreditNoteAllocation(${group.xeroCreditNoteId})`,
          }
        );
      }
      // The allocation set we just deleted (its IDs and total) is the provenance
      // basis for classifying the post-recreate re-GET under eventual
      // consistency (#1924).
      const deletedAllocations = provider;
      const deletedIds = deletedAllocations.map(
        (allocation) => allocation.allocationID,
      );
      const deletedTotal = deletedAllocations.reduce(
        (sum, allocation) => sum + allocation.amountCents,
        0,
      );
      provider = await readInvoiceAllocations(group.xeroCreditNoteId, booking.payment.xeroInvoiceId);
      providerTotal = provider.reduce((sum, allocation) => sum + allocation.amountCents, 0);
      if (providerTotal !== group.targetCents) {
        // Xero read-after-write is not guaranteed: an immediate re-GET can still
        // list the just-deleted allocations (alone → providerTotal===deletedTotal,
        // or alongside the recreate → deletedTotal+targetCents), or omit the
        // just-created recreate (→ 0). Every one of those is self-healing, so
        // requeue with backoff rather than failing terminal and fencing
        // cancellation/IB-expiry. A total or ID set NOT explained by this
        // transition (e.g. a foreign allocation) stays fail-closed terminal.
        if (
          isEventualConsistencyShapedTotal({
            observed: provider,
            providerTotal,
            knownIds: deletedIds,
            preTotal: deletedTotal,
            targetCents: group.targetCents,
          })
        ) {
          await requeueForEventualConsistency({
            operationId: options.syncOperationId,
            xeroCreditNoteId: group.xeroCreditNoteId,
            detail: `Post-recreate verification for ${group.xeroCreditNoteId}: provider=${providerTotal}c target=${group.targetCents}c`,
          });
        }
        throw new Error(
          `Xero deallocation verification failed for ${group.xeroCreditNoteId}: provider=${providerTotal}c target=${group.targetCents}c`
        );
      }
    }
    await checkpoint({
      operationId: options.syncOperationId,
      bookingId,
      group,
      phase: "PROVIDER_VERIFIED",
      providerAllocations: provider,
      priorLinks,
      providerMatch:
        providerTotal === group.targetCents
          ? "TARGET_TOTAL_WITH_ACTUAL_XERO_ALLOCATION_IDS"
          : "UNREACHABLE",
    });
    await applyLocalGroup({
      operationId: options.syncOperationId,
      bookingId,
      memberId: booking.memberId,
      paymentId: booking.payment.id,
      invoiceId: booking.payment.xeroInvoiceId,
      group,
      providerAllocations: provider,
      priorLinks,
    });
  }

  await completeXeroSyncOperation(options.syncOperationId, {
    responsePayload: {
      bookingId,
      invoiceId: booking.payment.xeroInvoiceId,
      desiredAppliedCents,
      adjustedCreditNotes: groups.length,
    },
  });
}
