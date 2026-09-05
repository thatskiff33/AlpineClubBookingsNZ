import { hasFinanceManagerAccess } from "@/lib/admin-permissions";
import type { FinanceAccessMember } from "@/lib/finance-auth";
import { getFinanceSyncDiagnosticsStatus } from "@/lib/finance-sync-diagnostics";
import { getXeroConnectionStatus } from "@/lib/xero";

interface FinanceReportAvailabilityInput {
  member: FinanceAccessMember;
  reportTitle: string;
  dataLabel: string;
}

// Structural subset of getXeroConnectionStatus: `connected` is readability-based
// (tokens decrypt), and `needsReentry` is true when a token row exists but can no
// longer be decrypted — the operator must reconnect, not run a first sync (#2079).
interface XeroConnectionSignal {
  connected: boolean;
  needsReentry: boolean;
}

function isManager(member: FinanceAccessMember): boolean {
  return hasFinanceManagerAccess(member);
}

function buildMissingMessageFromStatus(
  input: FinanceReportAvailabilityInput,
  syncStatus: Awaited<ReturnType<typeof getFinanceSyncDiagnosticsStatus>>,
  xero: XeroConnectionSignal
): string {
  if (xero.needsReentry) {
    return isManager(input.member)
      ? `${input.reportTitle} is waiting for Xero to be reconnected. The stored Xero connection can no longer be read — reconnect Xero from the admin Xero page, then run the finance sync to load ${input.dataLabel}.`
      : `${input.reportTitle} is waiting for Xero to be reconnected. Ask an administrator to reconnect Xero and run the finance sync.`;
  }

  if (!xero.connected) {
    return isManager(input.member)
      ? `${input.reportTitle} is waiting for the Xero connection. Connect Xero from the admin Xero page, then run the first finance sync to load ${input.dataLabel}.`
      : `${input.reportTitle} is waiting for its first finance sync. Ask an administrator to connect Xero and run the first finance sync.`;
  }

  if (!syncStatus.latestRun) {
    return isManager(input.member)
      ? `${input.reportTitle} does not have any synced finance data yet. Run the first finance sync to load ${input.dataLabel}.`
      : `${input.reportTitle} will appear after the first finance sync completes.`;
  }

  if (syncStatus.latestRun.status === "FAILED") {
    return isManager(input.member)
      ? `The latest finance sync failed before ${input.dataLabel} could be stored for ${input.reportTitle}. Review the finance diagnostics, fix the sync failure, and run the sync again.`
      : `${input.reportTitle} is temporarily unavailable because the latest finance sync failed. Please ask a finance manager to review the finance sync.`;
  }

  if (syncStatus.latestRun.status === "PARTIAL") {
    return isManager(input.member)
      ? `The latest finance sync completed with issues, and ${input.dataLabel} are not available for ${input.reportTitle} yet. Review the finance diagnostics and run the sync again after the failing datasets are fixed.`
      : `${input.reportTitle} is temporarily unavailable while the latest finance sync issues are being fixed.`;
  }

  if (syncStatus.latestRun.status === "RUNNING") {
    return `${input.reportTitle} is waiting for a finance sync that is currently running. Refresh this page in a few minutes.`;
  }

  return isManager(input.member)
    ? `${input.reportTitle} is connected, but ${input.dataLabel} have not been stored yet. Check the finance sync dataset coverage and rerun the sync if this report should already be populated.`
    : `${input.reportTitle} is not available yet because the required finance data has not been stored.`;
}

export async function buildFinanceSnapshotMissingMessage(
  input: FinanceReportAvailabilityInput
): Promise<string> {
  try {
    const [syncStatus, xeroStatus] = await Promise.all([
      getFinanceSyncDiagnosticsStatus(),
      getXeroConnectionStatus(),
    ]);

    return buildMissingMessageFromStatus(input, syncStatus, xeroStatus);
  } catch {
    return `The setup status for ${input.reportTitle} could not be checked right now. Try again shortly.`;
  }
}

export async function buildFinanceSnapshotLoadErrorMessage(
  input: FinanceReportAvailabilityInput
): Promise<string> {
  try {
    const [syncStatus, xeroStatus] = await Promise.all([
      getFinanceSyncDiagnosticsStatus(),
      getXeroConnectionStatus(),
    ]);

    if (!xeroStatus.connected || !syncStatus.latestRun) {
      return buildMissingMessageFromStatus(input, syncStatus, xeroStatus);
    }

    if (syncStatus.latestRun.status === "FAILED") {
      return isManager(input.member)
        ? `${input.reportTitle} could not read usable data because the latest finance sync failed. Review the finance diagnostics and rerun the sync after the failure is fixed.`
        : `${input.reportTitle} is temporarily unavailable while the latest finance sync failure is being fixed.`;
    }
  } catch {
    // Fall through to the generic storage-read message below.
  }

  return isManager(input.member)
    ? `${input.reportTitle} could not read its stored finance data right now. Try again shortly, then check the Xero connection and finance diagnostics if the problem continues.`
    : `${input.reportTitle} could not be loaded right now. Try again shortly.`;
}
