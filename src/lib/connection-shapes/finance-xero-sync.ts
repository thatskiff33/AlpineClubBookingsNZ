/**
 * What each Finance officer action in `catalogue/finance-xero-sync.ts` returns
 * (ALP-721, `INV-MCP-006`): the one place a catalogue entry's `returns`
 * and its route's projection both read (`INV-SSOT`). Money is integer cents.
 *
 * An officer's connection sends what it reads to the officer's AI provider,
 * so each shape keeps what the officer needs and leaves out contact details,
 * tokens, raw provider payloads and free text the answer does not need.
 * Types only: nothing here reaches the database.
 *
 * Common to every shape here: Xero's own object ids, the Xero tenant id,
 * request and response payloads, idempotency and correlation keys, links into
 * Xero (each carries a Xero id) and email addresses are left out. A Xero
 * document number stays, and so does every local record id another action
 * takes as an argument (an operation's or inbound event's `id`, a record's
 * `localModel` and `localId`).
 */
import type { XeroInboundEvent, XeroSyncOperation } from "@prisma/client";

import { connectionShapeFor } from "@/lib/connection-projection";
import type { XeroAdminHealthSnapshot } from "@/lib/xero-admin-health";
import type { getTodaysXeroUsageSummary } from "@/lib/xero-api-usage";
import type { SyncReport } from "@/lib/xero-bulk-contact-sync";
import type { XeroConnectionProbeResult } from "@/lib/xero-connection-probe";
import type { ProcessStoredXeroInboundEventsResult } from "@/lib/xero-inbound/types";
import type { XeroCanonicalLinkCleanupResult, XeroHistoricalBackfillResult } from "@/lib/xero-hardening-types";
import type { XeroRecordActivityData } from "@/lib/xero-record-types";

// --- Connection, health and usage -------------------------------------------

/** `GET /api/admin/xero/status`: whether Xero is connected, and the live check when asked for. */
export const XERO_STATUS_CONNECTION_SHAPE = connectionShapeFor<{
  connected: boolean;
  needsReentry: boolean;
  reentryCause: string;
  tokenExpiresAt: Date | null;
  features: {
    dailyMembershipRefresh: boolean;
    liveMemberGroupLookups: boolean;
    autoLoadContactGroups: boolean;
  };
  probe: XeroConnectionProbeResult;
}>({
  connected: true,
  needsReentry: true,
  reentryCause: true,
  tokenExpiresAt: true,
  features: { dailyMembershipRefresh: true, liveMemberGroupLookups: true, autoLoadContactGroups: true },
  probe: { tokenHealth: true, checkedAt: true, lastErrorMessage: true, cached: true },
});

/** `GET /api/admin/xero/health`: the counts behind the Xero screen's health tiles. */
export const XERO_HEALTH_CONNECTION_SHAPE = connectionShapeFor<XeroAdminHealthSnapshot>({
  webhookHealth: { connected: true, silent: true, hours: true, lastReceivedAt: true },
  unlinkedMembers: { count: true },
  failedOperations: { count: true, legacyCount: true },
  pendingOperations: { count: true },
  staleRunningOperations: { count: true, thresholdMinutes: true },
  staleProcessingInboundEvents: { count: true, thresholdMinutes: true },
  lastMembershipRefresh: { at: true, lastCronStatus: true, lastCronStartedAt: true },
  missingInvoices: { count: true },
  refundsMissingCreditNotes: { count: true, graceHours: true },
  contactGroupMismatches: { count: true, resyncCount: true, reviewByHandCount: true, cacheReady: true },
  contactLinkMismatches: { count: true, cacheReady: true },
  creditNotesSpentOutsideApp: { count: true },
  taxTreatment: { checked: true, problems: true },
  apiBudget: { status: true, usagePercent: true, totalCalls: true, failedCalls: true },
});

const XERO_USAGE_BUCKET = { label: true, count: true, successCount: true, failureCount: true } as const;

/** `GET /api/admin/xero/usage`: today's Xero API calls against the daily budget. */
export const XERO_USAGE_CONNECTION_SHAPE = connectionShapeFor<Awaited<ReturnType<typeof getTodaysXeroUsageSummary>>>({
  budget: { limit: true, thresholds: { fraction: true, callCount: true } },
  today: {
    usageDate: true,
    totalCalls: true,
    successfulCalls: true,
    failedCalls: true,
    dayRateLimitHits: true,
    minuteRateLimitHits: true,
    lastRateLimitCategory: true,
    lastRateLimitAt: true,
    usagePercent: true,
    budgetStatus: true,
  },
  byOperation: XERO_USAGE_BUCKET,
  topWorkflows: XERO_USAGE_BUCKET,
  // The message is stored redacted and truncated (`xero-api-usage.ts`).
  recentFailures: {
    operation: true,
    workflow: true,
    resourceType: true,
    rateLimitCategory: true,
    statusCode: true,
    errorMessage: true,
    createdAt: true,
  },
  lastDailyLimitEvent: { operation: true, workflow: true, resourceType: true, statusCode: true, createdAt: true },
});

// --- The sync queue ---------------------------------------------------------

/** `GET /api/admin/xero/operations`: one page of the sync queue, newest first. */
export const XERO_OPERATIONS_CONNECTION_SHAPE = connectionShapeFor<{
  data: Array<
    XeroSyncOperation & {
      supported: boolean;
      reason: string | null;
      failureState: string | null;
      failureStateReason: string | null;
      staleRunning: boolean;
      resolveAsksCreditNoteNumber: boolean;
      resolveCreditNoteAmountCents: number | null;
      resolveRefusal: string | null;
    }
  >;
  total: number;
  hiddenFailedCount: number;
  page: number;
  pageSize: number;
}>({
  data: {
    id: true,
    direction: true,
    entityType: true,
    operationType: true,
    localModel: true,
    localId: true,
    status: true,
    attemptCount: true,
    replayable: true,
    lastErrorCode: true,
    lastErrorMessage: true,
    xeroObjectType: true,
    xeroObjectNumber: true,
    startedAt: true,
    completedAt: true,
    manuallyResolvedAt: true,
    manuallyResolvedReason: true,
    createdAt: true,
    updatedAt: true,
    supported: true,
    reason: true,
    failureState: true,
    failureStateReason: true,
    staleRunning: true,
    resolveAsksCreditNoteNumber: true,
    resolveCreditNoteAmountCents: true,
    resolveRefusal: true,
  },
  total: true,
  hiddenFailedCount: true,
  page: true,
  pageSize: true,
});

/** `POST .../operations/[id]/retry` and `.../requeue`: the queued retry. */
export const XERO_OPERATION_QUEUED_CONNECTION_SHAPE = connectionShapeFor<{
  ok: boolean;
  message: string;
  queueOperationId: string;
}>({ ok: true, message: true, queueOperationId: true });

/** `POST .../operations/[id]/mark-failed`, `.../mark-non-replayable` and `.../resolve`. */
export const XERO_OPERATION_MARKED_CONNECTION_SHAPE = connectionShapeFor<{
  ok: boolean;
  message: string;
}>({ ok: true, message: true });

/** `POST .../operations/reset-stale-running`: how many stuck rows were reset, and to what. */
export const XERO_STALE_RUNNING_RESET_CONNECTION_SHAPE = connectionShapeFor<{
  ok: boolean;
  count: number;
  failed: number;
  partial: number;
  message: string;
}>({ ok: true, count: true, failed: true, partial: true, message: true });

/** `POST .../operations/retry-all`: what was queued and what was skipped, with why. */
export const XERO_RETRY_ALL_CONNECTION_SHAPE = connectionShapeFor<{
  ok: boolean;
  found: number;
  queued: number;
  skipped: number;
  legacySkipped: number;
  skippedOperations: Array<{ id: string; reason: string }>;
  message: string;
}>({
  ok: true,
  found: true,
  queued: true,
  skipped: true,
  legacySkipped: true,
  skippedOperations: { id: true, reason: true },
  message: true,
});

// --- Inbound events ---------------------------------------------------------

/** `GET /api/admin/xero/inbound-events`: one page of what Xero told the club, newest first. */
export const XERO_INBOUND_EVENTS_CONNECTION_SHAPE = connectionShapeFor<{
  data: Array<XeroInboundEvent & { canReplay: boolean }>;
  total: number;
  page: number;
  pageSize: number;
}>({
  data: {
    id: true,
    source: true,
    eventCategory: true,
    eventType: true,
    eventCreatedAt: true,
    status: true,
    errorMessage: true,
    processedAt: true,
    createdAt: true,
    updatedAt: true,
    canReplay: true,
  },
  total: true,
  page: true,
  pageSize: true,
});

/** `POST .../inbound-events/[id]/replay`: the run's counts and where the event ended up. */
export const XERO_INBOUND_EVENT_REPLAYED_CONNECTION_SHAPE = connectionShapeFor<{
  ok: boolean;
  message: string;
  replay: {
    result: ProcessStoredXeroInboundEventsResult;
    event: { id: string; status: string; errorMessage: string | null; processedAt: Date | null };
  };
}>({
  ok: true,
  message: true,
  replay: {
    result: { found: true, processed: true, succeeded: true, failed: true, skipped: true },
    event: { id: true, status: true, errorMessage: true, processedAt: true },
  },
});

// --- One record's Xero activity ---------------------------------------------

const XERO_RECORD_REFERENCE = { localModel: true, localId: true, label: true, relation: true } as const;

/** `GET /api/admin/xero/records/[localModel]/[localId]`: the record's operations, links and events. */
export const XERO_RECORD_ACTIVITY_CONNECTION_SHAPE = connectionShapeFor<{ data: XeroRecordActivityData }>({
  data: {
    rootRecord: XERO_RECORD_REFERENCE,
    scopeRecords: XERO_RECORD_REFERENCE,
    relatedRecords: XERO_RECORD_REFERENCE,
    summary: {
      totalOperations: true,
      failedOperations: true,
      pendingOperations: true,
      partialOperations: true,
      activeLinks: true,
    },
    operations: {
      id: true,
      direction: true,
      entityType: true,
      operationType: true,
      localModel: true,
      localId: true,
      localLabel: true,
      status: true,
      attemptCount: true,
      replayable: true,
      lastErrorCode: true,
      lastErrorMessage: true,
      xeroObjectType: true,
      xeroObjectNumber: true,
      startedAt: true,
      completedAt: true,
      createdAt: true,
      updatedAt: true,
      supported: true,
      reason: true,
    },
    links: {
      localModel: true,
      localId: true,
      localLabel: true,
      xeroObjectType: true,
      xeroObjectNumber: true,
      role: true,
      active: true,
      createdAt: true,
      updatedAt: true,
    },
    inboundEvents: {
      id: true,
      source: true,
      eventCategory: true,
      eventType: true,
      status: true,
      errorMessage: true,
      processedAt: true,
      createdAt: true,
      canReplay: true,
    },
  },
});

// --- Runs an officer starts -------------------------------------------------

/** `POST /api/admin/xero/sync-now` for one member or one booking. */
export const XERO_SYNC_NOW_RECORD_CONNECTION_SHAPE = connectionShapeFor<{
  changed: number;
  invoices: number;
  creditNotes: number;
  contactFields: number;
  message: string;
}>({ changed: true, invoices: true, creditNotes: true, contactFields: true, message: true });

/** `POST /api/admin/xero/sync-now` for the whole club: the counts, not the run's raw result. */
export const XERO_SYNC_NOW_CLUB_CONNECTION_SHAPE = connectionShapeFor<{
  message: string;
  events: number;
  records: number;
  invoices: number;
  writtenDown: number;
  restored: number;
}>({ message: true, events: true, records: true, invoices: true, writtenDown: true, restored: true });

/**
 * `POST /api/admin/xero/sync-contacts`: the report, by member name, without
 * emails or Xero contact ids. An update is told by the fields it changed
 * (`xeroContactChangedFields`, added by the route), not the screen's "Phone
 * set to …" lines, which carry the new values.
 */
export const XERO_SYNC_CONTACTS_CONNECTION_SHAPE = connectionShapeFor<{
  syncReport: Omit<SyncReport, "updated"> & {
    updated: Array<SyncReport["updated"][number] & { changedFields: string[] }>;
  };
}>({
  syncReport: {
    created: { name: true, group: true },
    updated: { name: true, memberId: true, changedFields: true },
    skippedNoChanges: true,
    skippedNameMismatch: { memberId: true, memberName: true, xeroContactName: true, reasons: true },
    skippedNoEmail: { name: true },
    skippedOther: { name: true, reason: true },
    errors: { name: true, error: true },
    total: true,
  },
});

/**
 * `POST /api/admin/xero/sync-memberships`: the refresh's counts. Each error's
 * `member` label carries the member's email, so only the error is kept, and
 * the changed invoices are counted rather than listed by Xero id.
 */
export const XERO_SYNC_MEMBERSHIPS_CONNECTION_SHAPE = connectionShapeFor<{
  seasonYear: number;
  cursorFrom: string | null;
  cursorTo: string | null;
  changedInvoices: number;
  affectedMembers: number;
  checked: number;
  updated: number;
  errors: number;
  errorDetails: Array<{ member: string; error: string }>;
  mode: string;
}>({
  seasonYear: true,
  cursorFrom: true,
  cursorTo: true,
  changedInvoices: true,
  affectedMembers: true,
  checked: true,
  updated: true,
  errors: true,
  errorDetails: { error: true },
  mode: true,
});

/** `POST /api/admin/xero/force-sync` with `syncType: "CONTACT"`. */
export const XERO_FORCE_SYNC_CONTACT_CONNECTION_SHAPE = connectionShapeFor<{
  ok: boolean;
  syncType: string;
  message: string;
  memberId: string;
}>({ ok: true, syncType: true, message: true, memberId: true });

/** `POST /api/admin/xero/force-sync` with `syncType: "MEMBERSHIP"`. */
export const XERO_FORCE_SYNC_MEMBERSHIP_CONNECTION_SHAPE = connectionShapeFor<{
  ok: boolean;
  syncType: string;
  message: string;
  memberId: string;
  status: string;
}>({ ok: true, syncType: true, message: true, memberId: true, status: true });

/** `POST /api/admin/xero/force-sync` with `syncType: "INVOICE"`. */
export const XERO_FORCE_SYNC_INVOICE_CONNECTION_SHAPE = connectionShapeFor<{
  ok: boolean;
  syncType: string;
  bookingId: string;
  queueOperationId: string | null;
  message: string;
}>({ ok: true, syncType: true, bookingId: true, queueOperationId: true, message: true });

/** `POST /api/admin/xero/link-maintenance`: what the backfill and the cleanup did, as counts. */
export const XERO_LINK_MAINTENANCE_CONNECTION_SHAPE = connectionShapeFor<{
  ok: boolean;
  message: string;
  warning: string;
  backfill: XeroHistoricalBackfillResult;
  cleanup: XeroCanonicalLinkCleanupResult;
}>({
  ok: true,
  message: true,
  warning: true,
  backfill: { totals: { scanned: true, createdLinks: true, createdOperations: true } },
  cleanup: {
    scannedActiveLinks: true,
    keptActiveLinks: true,
    deactivatedLinks: true,
    preservedStripeRefundCreditNoteLinks: true,
    healedCancelledRefundCreditNoteMirrors: true,
    releasedInactiveRefundNotePointers: true,
    byCategory: {
      memberContacts: true,
      paymentInvoices: true,
      paymentRefundCreditNotes: true,
      subscriptionInvoices: true,
      otherCanonicalLinks: true,
    },
  },
});
