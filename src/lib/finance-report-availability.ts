import {
  type FinanceAccessMember,
  hasFinanceManagerAccess,
} from "@/lib/finance-auth";
import { getFinanceSyncDiagnosticsStatus } from "@/lib/finance-sync-diagnostics";
import { getFinanceXeroRouteStatus } from "@/lib/finance-xero";

interface FinanceReportAvailabilityInput {
  member: FinanceAccessMember;
  reportTitle: string;
  dataLabel: string;
}

function isManager(member: FinanceAccessMember): boolean {
  return hasFinanceManagerAccess(member.financeAccessLevel);
}

function buildMissingMessageFromStatus(
  input: FinanceReportAvailabilityInput,
  syncStatus: Awaited<ReturnType<typeof getFinanceSyncDiagnosticsStatus>>,
  xeroStatus: Awaited<ReturnType<typeof getFinanceXeroRouteStatus>>
): string {
  if (!xeroStatus.canConnect) {
    return isManager(input.member)
      ? `${input.reportTitle} is not ready yet because finance Xero setup is incomplete in this environment. Finish the finance Xero configuration, connect the finance organisation, and run the first sync.`
      : `${input.reportTitle} is not ready yet because finance setup is still being completed. Ask a finance manager to finish the finance Xero connection and first sync.`;
  }

  if (!xeroStatus.connected) {
    return isManager(input.member)
      ? `${input.reportTitle} is waiting for the finance Xero connection. Connect the finance organisation, then run the first sync to load ${input.dataLabel}.`
      : `${input.reportTitle} is waiting for its first finance sync. Ask a finance manager to connect finance Xero and run the first sync.`;
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
      getFinanceXeroRouteStatus(),
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
      getFinanceXeroRouteStatus(),
    ]);

    if (!xeroStatus.canConnect || !xeroStatus.connected || !syncStatus.latestRun) {
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
    ? `${input.reportTitle} could not read its stored finance data right now. Try again shortly, then check finance connection and diagnostics if the problem continues.`
    : `${input.reportTitle} could not be loaded right now. Try again shortly.`;
}
