import { prisma } from "@/lib/prisma";
import { readClubTimeZoneOutsideRequest } from "@/lib/club-time-zone-runtime";
import { clubSeasonYear } from "@/lib/financial-year";
import { syncContactsFromXero } from "@/lib/xero-bulk-contact-sync";
import { refreshAllMembershipStatuses } from "@/lib/xero-membership-sync";
import { type IncrementalContactReconciliationResult, type IncrementalMembershipReconciliationResult } from "./types";
import { CONTACT_SYNC_CURSOR_RESOURCE, DEFAULT_CONTACT_RECONCILE_MIN_INTERVAL_MS, DEFAULT_MEMBERSHIP_RECONCILE_MIN_INTERVAL_MS, DEFAULT_XERO_SYNC_SCOPE, DEFAULT_XERO_SYNC_SCOPE_PREFIX, MEMBERSHIP_SYNC_CURSOR_RESOURCE } from "./constants";

function getMembershipSyncCursorScope(seasonYear: number): string {
  return `${DEFAULT_XERO_SYNC_SCOPE_PREFIX}${seasonYear}`;
}

function buildSkippedMembershipReconciliation(
  seasonYear: number,
  cursorFrom: string | null,
  reason: string
): IncrementalMembershipReconciliationResult {
  return {
    seasonYear,
    cursorFrom,
    cursorTo: null,
    changedInvoices: 0,
    changedInvoiceIds: [],
    affectedMembers: 0,
    checked: 0,
    updated: 0,
    errors: 0,
    errorDetails: [],
    skipped: true,
    reason,
  };
}

function buildSkippedContactReconciliation(
  cursorFrom: string | null,
  reason: string
): IncrementalContactReconciliationResult {
  return {
    cursorFrom,
    cursorTo: null,
    total: 0,
    created: 0,
    updated: 0,
    skippedNoChanges: 0,
    skippedNoEmail: 0,
    skippedOther: 0,
    errors: 0,
    skipped: true,
    reason,
  };
}

export async function runIncrementalContactReconciliation(options?: {
  minimumIntervalMs?: number;
}): Promise<IncrementalContactReconciliationResult> {
  const minimumIntervalMs =
    options?.minimumIntervalMs ?? DEFAULT_CONTACT_RECONCILE_MIN_INTERVAL_MS;
  const cursor = await prisma.xeroSyncCursor.findUnique({
    where: {
      resourceType_scope: {
        resourceType: CONTACT_SYNC_CURSOR_RESOURCE,
        scope: DEFAULT_XERO_SYNC_SCOPE,
      },
    },
    select: {
      cursorDateTime: true,
      lastSuccessfulSyncAt: true,
    },
  });

  if (
    minimumIntervalMs > 0 &&
    cursor?.lastSuccessfulSyncAt &&
    Date.now() - cursor.lastSuccessfulSyncAt.getTime() < minimumIntervalMs
  ) {
    return buildSkippedContactReconciliation(
      cursor.cursorDateTime?.toISOString() ?? null,
      "Contact cursor was refreshed recently; skipping duplicate incremental reconcile."
    );
  }

  const report = await syncContactsFromXero();
  const updatedCursor = await prisma.xeroSyncCursor.findUnique({
    where: {
      resourceType_scope: {
        resourceType: CONTACT_SYNC_CURSOR_RESOURCE,
        scope: DEFAULT_XERO_SYNC_SCOPE,
      },
    },
    select: {
      cursorDateTime: true,
    },
  });

  return {
    cursorFrom: cursor?.cursorDateTime?.toISOString() ?? null,
    cursorTo: updatedCursor?.cursorDateTime?.toISOString() ?? null,
    total: report.total,
    created: report.created.length,
    updated: report.updated.length,
    skippedNoChanges: report.skippedNoChanges,
    skippedNoEmail: report.skippedNoEmail.length,
    skippedOther: report.skippedOther.length,
    errors: report.errors.length,
  };
}

export async function runIncrementalMembershipReconciliation(options?: {
  seasonYear?: number;
  minimumIntervalMs?: number;
}): Promise<IncrementalMembershipReconciliationResult> {
  const seasonYear =
    options?.seasonYear ?? clubSeasonYear(await readClubTimeZoneOutsideRequest());
  const minimumIntervalMs =
    options?.minimumIntervalMs ?? DEFAULT_MEMBERSHIP_RECONCILE_MIN_INTERVAL_MS;
  const cursor = await prisma.xeroSyncCursor.findUnique({
    where: {
      resourceType_scope: {
        resourceType: MEMBERSHIP_SYNC_CURSOR_RESOURCE,
        scope: getMembershipSyncCursorScope(seasonYear),
      },
    },
    select: {
      cursorDateTime: true,
      lastSuccessfulSyncAt: true,
    },
  });

  if (
    minimumIntervalMs > 0 &&
    cursor?.lastSuccessfulSyncAt &&
    Date.now() - cursor.lastSuccessfulSyncAt.getTime() < minimumIntervalMs
  ) {
    return buildSkippedMembershipReconciliation(
      seasonYear,
      cursor.cursorDateTime?.toISOString() ?? null,
      "Membership cursor was refreshed recently; skipping duplicate incremental reconcile."
    );
  }

  return refreshAllMembershipStatuses(seasonYear);
}
