/**
 * What each Finance officer action on reports, booking metrics and the
 * finance sync returns (ALP-721, `INV-MCP-006`): the one place a catalogue
 * entry's `returns` and its route's projection both read (`INV-SSOT`). Money
 * is integer cents. Types only: nothing here reaches the database.
 */
import { connectionShapeFor, eachEntry } from "@/lib/connection-projection";
import type { FinanceBookingMetricsResult } from "@/lib/finance-booking-metrics";
import type { FinanceSyncDiagnosticsStatus } from "@/lib/finance-sync-diagnostics";
import type { FinanceSyncExecutionResult } from "@/lib/finance-sync-service";

/** `GET /api/admin/reports`: the report window's bookings, money, members and occupancy figures. */
export const ADMIN_REPORTS_CONNECTION_SHAPE = connectionShapeFor<{
  summary: {
    totalBookings: number;
    moneyReconciliation: {
      totalBookings: number;
      byState: { RECONCILED: number; UNRECONCILED: number };
      byReason: Record<string, number>;
    };
    totalRevenueCents: number;
    netCollectedCents: number;
    refundsOwedCents: number;
    creditsOwedCents: number;
    additionalLedgerGapCents: number;
    additionalLedgerGapBookings: number;
    outstandingAdditionalCents: number;
    outstandingAdditionalBookings: number;
    totalGuests: number;
    avgOccupancyRate: number;
    memberGuests: number;
    nonMemberGuests: number;
  };
  statusBreakdown: {
    pending: number;
    paymentPending: number;
    confirmed: number;
    paid: number;
    awaitingReview: number;
    completed: number;
  };
  memberStats: {
    totalActiveMembers: number;
    paidMembers: number;
    unpaidMembers: number;
    overdueMembers: number;
    newMembers: number;
    currentSeasonYear: number;
    currentSeasonLabel: string;
  };
  occupancy: Array<{ date: string; occupiedBeds: number; availableBeds: number; occupancyRate: number }>;
  revenueGranularity: string;
  revenue: Array<{
    periodStart: string;
    periodEnd: string;
    label: string;
    tooltipLabel: string;
    revenueCents: number;
    bookingCount: number;
  }>;
  trends: Array<{
    week: string;
    total: number;
    pending: number;
    paymentPending: number;
    confirmed: number;
    paid: number;
    awaitingReview: number;
    completed: number;
  }>;
}>({
  summary: {
    totalBookings: true,
    moneyReconciliation: {
      totalBookings: true,
      byState: { RECONCILED: true, UNRECONCILED: true },
      byReason: eachEntry(true),
    },
    totalRevenueCents: true,
    netCollectedCents: true,
    refundsOwedCents: true,
    creditsOwedCents: true,
    additionalLedgerGapCents: true,
    additionalLedgerGapBookings: true,
    outstandingAdditionalCents: true,
    outstandingAdditionalBookings: true,
    totalGuests: true,
    avgOccupancyRate: true,
    memberGuests: true,
    nonMemberGuests: true,
  },
  statusBreakdown: {
    pending: true,
    paymentPending: true,
    confirmed: true,
    paid: true,
    awaitingReview: true,
    completed: true,
  },
  memberStats: {
    totalActiveMembers: true,
    paidMembers: true,
    unpaidMembers: true,
    overdueMembers: true,
    newMembers: true,
    currentSeasonYear: true,
    currentSeasonLabel: true,
  },
  occupancy: { date: true, occupiedBeds: true, availableBeds: true, occupancyRate: true },
  revenueGranularity: true,
  revenue: {
    periodStart: true,
    periodEnd: true,
    label: true,
    tooltipLabel: true,
    revenueCents: true,
    bookingCount: true,
  },
  trends: {
    week: true,
    total: true,
    pending: true,
    paymentPending: true,
    confirmed: true,
    paid: true,
    awaitingReview: true,
    completed: true,
  },
});


const FINANCE_METRICS_WINDOW_SHAPE = { from: true, to: true, effectiveFrom: true, effectiveTo: true, dayCount: true } as const;
const FINANCE_METRICS_STATUS_SHAPE = { bookingCount: true, bookingNights: true, guestNights: true, bookedRevenueCents: true } as const;
const FINANCE_METRICS_BUCKET_SHAPE = {
  ...FINANCE_METRICS_STATUS_SHAPE,
  occupancy: { occupiedBedNights: true, capacityBedNights: true, occupancyRate: true },
} as const;
const FINANCE_METRICS_DAY_SHAPE = {
  date: true,
  bookingCount: true,
  guestNights: true,
  occupiedBeds: true,
  availableBeds: true,
  occupancyRate: true,
  bookedRevenueCents: true,
} as const;

/**
 * `GET /api/finance/bookings/metrics`: the finance workspace's booking
 * figures for a realised (past stays) window, a forward (bookings ahead)
 * window, or both, with the payment and money-reconciliation summaries.
 * Aggregates only, in integer cents.
 */
export const FINANCE_BOOKING_METRICS_CONNECTION_SHAPE = connectionShapeFor<FinanceBookingMetricsResult>({
  generatedAt: true,
  bookingCount: true,
  moneyReconciliation: {
    totalBookings: true,
    byState: { RECONCILED: true, UNRECONCILED: true },
    byReason: eachEntry(true),
  },
  paymentSummary: {
    bookingCount: true,
    bookingsWithPayment: true,
    bookingsWithoutPayment: true,
    paymentStatusBreakdown: eachEntry(true),
    additionalPaymentStatusBreakdown: eachEntry(true),
    capturedGrossCents: true,
    capturedAdditionalCents: true,
    outstandingAdditionalCents: true,
    outstandingAdditionalBookings: true,
    additionalLedgerGapCents: true,
    additionalLedgerGapBookings: true,
    refundedCents: true,
    handBackOwedCents: true,
    cardRefundOwedCents: true,
    lateCaptureOwedCents: true,
    lateCashCreditedCents: true,
    keptCreditCents: true,
    netCollectedCents: true,
    refundsOwedCents: true,
    creditsOwedCents: true,
    creditAppliedCents: true,
    changeFeeCents: true,
  },
  realized: {
    window: { ...FINANCE_METRICS_WINDOW_SHAPE, cutoffDate: true },
    totals: { ...FINANCE_METRICS_BUCKET_SHAPE, averageNightlyRevenueCents: true },
    statusBreakdown: eachEntry(FINANCE_METRICS_STATUS_SHAPE),
    byDate: FINANCE_METRICS_DAY_SHAPE,
  },
  forward: {
    window: { ...FINANCE_METRICS_WINDOW_SHAPE, asOfDate: true },
    totals: {
      committed: { ...FINANCE_METRICS_BUCKET_SHAPE, statusBreakdown: eachEntry(FINANCE_METRICS_STATUS_SHAPE) },
      atRisk: { ...FINANCE_METRICS_BUCKET_SHAPE, statusBreakdown: eachEntry(FINANCE_METRICS_STATUS_SHAPE) },
      totalPipeline: FINANCE_METRICS_BUCKET_SHAPE,
    },
    byDate: {
      date: true,
      committed: FINANCE_METRICS_DAY_SHAPE,
      atRisk: FINANCE_METRICS_DAY_SHAPE,
      totalPipeline: FINANCE_METRICS_DAY_SHAPE,
    },
  },
});

const FINANCE_SYNC_RUN_SUMMARY_SHAPE = {
  id: true,
  workflow: true,
  trigger: true,
  status: true,
  startedAt: true,
  completedAt: true,
  durationMs: true,
  snapshotCount: true,
  totalRowCount: true,
  datasetCount: true,
  successfulDatasetCount: true,
  failedDatasetCount: true,
  datasets: { datasetKey: true, snapshotCount: true, totalRowCount: true, snapshotTypes: true, errorMessage: true },
  errorSummary: true,
  failureDetails: { stage: true, datasetKey: true, message: true },
} as const;

const FINANCE_SYNC_CRON_RUN_SHAPE = {
  id: true,
  jobName: true,
  status: true,
  startedAt: true,
  completedAt: true,
  durationMs: true,
  financeSyncRunId: true,
  financeSyncStatus: true,
  snapshotCount: true,
  totalRowCount: true,
  datasetCount: true,
  failedDatasetCount: true,
  error: true,
  reason: true,
} as const;

/**
 * `GET /api/finance/sync/status`: the latest finance sync from Xero, its
 * nightly schedule and recent failures. The Xero organisation id and the
 * requesting member's id stay behind.
 */
export const FINANCE_SYNC_STATUS_CONNECTION_SHAPE = connectionShapeFor<FinanceSyncDiagnosticsStatus>({
  workflow: true,
  latestRun: FINANCE_SYNC_RUN_SUMMARY_SHAPE,
  cron: { jobName: true, schedule: true, timezone: true, latestRun: FINANCE_SYNC_CRON_RUN_SHAPE },
  recentFailures: { syncRuns: FINANCE_SYNC_RUN_SUMMARY_SHAPE, cronRuns: FINANCE_SYNC_CRON_RUN_SHAPE },
});

type FinanceSyncDatasetResult = FinanceSyncExecutionResult["datasetResults"][number];

const FINANCE_SYNC_DATASET_RESULT_SHAPE = {
  datasetKey: true,
  snapshotCount: true,
  totalRowCount: true,
  snapshotTypes: true,
  factRowCount: true,
  unresolvedFactRowCount: true,
  errorMessage: true,
} as const;

/**
 * `POST /api/finance/sync/run`, as a connection is answered (the browser is
 * redirected): `completed` or `partial` with the run's figures.
 */
export const FINANCE_SYNC_RUN_CONNECTION_SHAPE = connectionShapeFor<{
  outcome: "completed" | "partial";
  runId: string;
  status: string;
  startedAt: string;
  completedAt: string;
  snapshotCount: number;
  totalRowCount: number;
  datasetResults: FinanceSyncDatasetResult[];
}>({
  outcome: true,
  runId: true,
  status: true,
  startedAt: true,
  completedAt: true,
  snapshotCount: true,
  totalRowCount: true,
  datasetResults: FINANCE_SYNC_DATASET_RESULT_SHAPE,
});

/** `POST /api/finance/sync/backfill-monthly-facts`: the backfill run and what each report gave. */
export const FINANCE_BACKFILL_MONTHLY_FACTS_CONNECTION_SHAPE = connectionShapeFor<{
  runId: string;
  status: string;
  snapshotCount: number;
  totalRowCount: number;
  datasetResults: FinanceSyncDatasetResult[];
}>({
  runId: true,
  status: true,
  snapshotCount: true,
  totalRowCount: true,
  datasetResults: FINANCE_SYNC_DATASET_RESULT_SHAPE,
});
