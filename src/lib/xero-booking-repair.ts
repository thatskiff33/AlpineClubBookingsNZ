// Entry module for the booking-vs-Xero audit and self-repair tool. This is a
// MANUAL diagnostic/repair tool (invoked only by scripts/xero-booking-repair.ts
// and its test, not on any live route/cron/webhook path). #1208 item 2 split
// its ~2,700 lines of private helpers into cohesive xero-booking-repair-*
// sub-modules; this module keeps the orchestrator + human-summary formatter and
// re-exports the exact public surface so external importers still resolve.
// Import xero source modules directly, never the @/lib/xero facade (#1208).
export {
  XERO_BOOKING_REPAIR_ACTION_TYPES,
  XERO_BOOKING_REPAIR_FINDING_CODES,
} from "./xero-booking-repair-types";
export type {
  BookingXeroRepairAction,
  BookingXeroRepairBookingSummary,
  BookingXeroRepairFinding,
  BookingXeroRepairPassReport,
  BookingXeroRepairRunReport,
  BookingXeroRepairRunSummary,
  BookingXeroRepairScope,
  XeroBookingRepairActionStatus,
  XeroBookingRepairActionType,
  XeroBookingRepairFindingCode,
  XeroBookingRepairSeverity,
} from "./xero-booking-repair-types";

import type {
  BookingXeroRepairPassReport,
  BookingXeroRepairRunReport,
  BookingXeroRepairRunSummary,
  BookingXeroRepairScope,
} from "./xero-booking-repair-types";
import type { RepairDependencies } from "./xero-booking-repair-deps";
import { getDependencies } from "./xero-booking-repair-deps";
import { loadAuditData } from "./xero-booking-repair-load";
import { classifyBookingContext } from "./xero-booking-repair-classify";
import {
  applyActionsForPass,
  buildPassReport,
} from "./xero-booking-repair-passes";
import { createCountMap } from "./xero-booking-repair-utils";

const MAX_APPLY_PASSES = 3;

async function runSinglePass(
  pass: number,
  scope: BookingXeroRepairScope,
  deps: RepairDependencies
) {
  const contexts = await loadAuditData(scope, deps);
  const bookings = contexts.map((context) => classifyBookingContext(context));
  return buildPassReport(pass, bookings);
}

export async function runBookingXeroRepair(options?: {
  scope?: BookingXeroRepairScope;
  apply?: boolean;
  /**
   * #1491: exact action keys (from a prior dry-run report) an operator has
   * confirmed and wants executed even though they are not safeToAutoApply —
   * e.g. a verified genuine late capture's AUTO_REFUND_LATE_CAPTURED_PAYMENT.
   * Only honored in apply mode.
   */
  applyActionKeys?: string[];
  dependencies?: Partial<RepairDependencies>;
}): Promise<BookingXeroRepairRunReport> {
  const scope = options?.scope ?? { all: true };
  const apply = options?.apply ?? false;
  const forcedActionKeys = new Set(apply ? options?.applyActionKeys ?? [] : []);
  const deps = getDependencies(options?.dependencies);
  const startedAt = new Date();
  const xeroConnectionAvailable = await deps.isXeroConnected().catch(() => false);

  const passes: BookingXeroRepairPassReport[] = [];
  const maxPasses = apply ? MAX_APPLY_PASSES : 1;

  for (let pass = 1; pass <= maxPasses; pass += 1) {
    const passReport = await runSinglePass(pass, scope, deps);
    passes.push(passReport);

    if (!apply) {
      break;
    }

    const hasPlannedActions = passReport.bookings.some((booking) =>
      booking.actions.some(
        (action) =>
          (action.safeToAutoApply || forcedActionKeys.has(action.key)) &&
          action.status === "planned"
      )
    );
    if (!hasPlannedActions) {
      break;
    }

    const hasStateChanges = await applyActionsForPass(
      passReport.bookings,
      deps,
      xeroConnectionAvailable,
      forcedActionKeys
    );
    if (!hasStateChanges) {
      break;
    }
  }

  // `maxPasses` is at least one, so the loop above always recorded a pass. A
  // report with no pass would have no scan to summarise and no findings to
  // count, and there is nothing to put in its place (#2800).
  const finalPass = passes.at(-1);
  if (finalPass === undefined) {
    throw new Error(
      "Booking Xero repair produced no pass report; the pass budget must be at least one.",
    );
  }
  const finalBookingsWithFindings = finalPass.bookings.filter(
    (booking) => booking.findings.length > 0
  );
  const allActions = passes.flatMap((pass) =>
    pass.bookings.flatMap((booking) => booking.actions)
  );
  const summary: BookingXeroRepairRunSummary = {
    bookingsScanned: finalPass.bookingsScanned,
    bookingsWithFindings: finalPass.bookingsWithFindings,
    findingsByCode: createCountMap(
      finalPass.bookings.flatMap((booking) =>
        booking.findings.map((finding) => finding.code)
      )
    ),
    actionsByType: createCountMap(allActions.map((action) => action.type)),
    actionStatuses: createCountMap(allActions.map((action) => action.status)),
    unmatchedForcedActionKeys: [...forcedActionKeys].filter(
      (key) => !allActions.some((action) => action.key === key)
    ),
    manualReviewBookings: finalBookingsWithFindings
      .filter((booking) =>
        booking.findings.some((finding) => finding.severity === "manual_review")
      )
      .map((booking) => booking.bookingId),
    xeroConnectionAvailable,
  };

  return {
    mode: apply ? "apply" : "dry-run",
    scope: {
      bookingId: scope.bookingId ?? null,
      // #2868: the scope now CARRIES the operator's `yyyy-MM-dd` days, so the
      // echo is the answer they gave rather than a re-derivation of it. It used
      // to run the scope's local-midnight `Date` back through `formatDateOnly`
      // — the canonical DATE-ONLY encoder, explicitly not for an instant — so a
      // sweep asked for `[1 Jul, 31 Jul]` under the `TZ=Pacific/Auckland` pin
      // printed `from=2026-06-30, to=2026-07-30` in its own header.
      from: scope.from ?? null,
      to: scope.to ?? null,
      all: Boolean(scope.all || (!scope.bookingId && !scope.from && !scope.to)),
    },
    startedAt: startedAt.toISOString(),
    completedAt: new Date().toISOString(),
    passes,
    summary,
  };
}

export function formatBookingXeroRepairHumanSummary(
  report: BookingXeroRepairRunReport
) {
  const lines: string[] = [];
  lines.push(`Mode: ${report.mode}`);
  lines.push(
    `Scope: booking=${report.scope.bookingId ?? "all"}, from=${report.scope.from ?? "-"}, to=${report.scope.to ?? "-"}`
  );
  lines.push(`Bookings scanned: ${report.summary.bookingsScanned}`);
  lines.push(`Bookings with findings: ${report.summary.bookingsWithFindings}`);
  lines.push(
    `Xero connected: ${report.summary.xeroConnectionAvailable ? "yes" : "no"}`
  );

  if (Object.keys(report.summary.findingsByCode).length > 0) {
    lines.push("");
    lines.push("Findings:");
    for (const [code, count] of Object.entries(report.summary.findingsByCode)) {
      lines.push(`- ${code}: ${count}`);
    }
  }

  if (Object.keys(report.summary.actionStatuses).length > 0) {
    lines.push("");
    lines.push("Action Statuses:");
    for (const [status, count] of Object.entries(report.summary.actionStatuses)) {
      lines.push(`- ${status}: ${count}`);
    }
  }

  const actionableBookings = report.passes[report.passes.length - 1]?.bookings.filter(
    (booking) => booking.findings.length > 0
  ) ?? [];

  if (actionableBookings.length > 0) {
    lines.push("");
    lines.push("Bookings:");
    for (const booking of actionableBookings) {
      lines.push(
        `- ${booking.bookingId} (${booking.memberName}, ${booking.bookingStatus}, payment=${booking.paymentStatus ?? "none"})`
      );
      for (const finding of booking.findings) {
        lines.push(`  ${finding.code}: ${finding.summary}`);
      }
      for (const action of booking.actions) {
        // #1491: non-auto planned actions print their exact key so an
        // operator can hand-apply them with --apply --apply-action <key>.
        const keyHint =
          !action.safeToAutoApply && action.status === "planned"
            ? ` [--apply-action ${action.key}]`
            : "";
        lines.push(`  action ${action.type}: ${action.status}${action.resultMessage ? ` - ${action.resultMessage}` : ""}${keyHint}`);
      }
    }
  }

  return lines.join("\n");
}
