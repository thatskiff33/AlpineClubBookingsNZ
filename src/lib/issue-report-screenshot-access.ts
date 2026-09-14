import type { IssueReportOrigin } from "@prisma/client";

import {
  hasAdminPortalAccess,
  type AdminPermissionInput,
} from "@/lib/admin-permissions";
import { isFullAdmin } from "@/lib/access-roles";
import { ISSUE_REPORT_RETENTION_DELETE_REASON } from "@/lib/issue-report-retention";

/**
 * THE ONE HOME for the #2703 rule: **admin-origin issue-report screenshot
 * pixels are Full-Admin-only**. Ordinary issue-report text and diagnostics keep
 * the normal `support:view` access model.
 *
 * ## Why the rule exists
 *
 * Viewing an issue report needs `support: view`, and `support` is a separate
 * permission area from `membership`. An officer given support access to triage
 * issue reports, and deliberately not given membership access, could read
 * member names, addresses and dates of birth off a screenshot captured on an
 * admin member page. The image walked through a boundary the permission model
 * draws.
 *
 * ## Why origin is DERIVED AND PERSISTED, and what is not authority
 *
 * `pageUrl` is posted by the reporting widget, so it is controllable by anyone
 * who can file a report. The owner rule on #2703 rejects, by name, authorising
 * screenshot access with a client `pageUrl`, route-to-permission
 * reconstruction, DOM masking, signed claimed URLs, reporter-permission replay
 * and generic caller flags. What is left is the only thing a client cannot
 * touch: the reporter's own admin standing, read server-side at the moment the
 * report is created and written to the row. It is never recomputed at read
 * time, so revoking or granting a role later cannot retroactively expose or
 * hide pixels that were already captured.
 *
 * ## Both halves live here on purpose
 *
 * `deriveIssueReportScreenshotOrigin` decides the stored value; the classifier
 * below decides what a caller may see. Splitting them across two modules is how
 * a later change makes one of them disagree with the other.
 */

/** Every terminal state a screenshot can be in, from the caller's point of view. */
export type IssueReportScreenshotDisposition =
  /** No screenshot was ever attached to this report. */
  | "none"
  /** Retained, and this caller is authorised to see the pixels. */
  | "viewed"
  /**
   * Retained, but captured on an admin screen and this caller is not a Full
   * Admin. The caller is told the screenshot exists and is refused the pixels;
   * that authorised-withheld state is what the owner rule permits them to see.
   */
  | "withheld"
  /** Redacted by the 30-day retention sweep. */
  | "expired"
  /** Deleted by an administrator, with a reason. */
  | "deleted";

export type IssueReportScreenshotAccess = {
  disposition: IssueReportScreenshotDisposition;
  /** True only for `viewed`. The single question every read path asks. */
  releasePixels: boolean;
  /** True only for `withheld`. Drives the payload flag and the audit row. */
  withheld: boolean;
  /** True while the pixels are still stored, whoever may see them. */
  retained: boolean;
};

/**
 * Whether this row's pixels are gated.
 *
 * **NULL is ADMIN.** A row written before #2703 carries no classification, and
 * it cannot be reconstructed: the reporter's roles may have changed since, and
 * the one surviving clue — `pageUrl` — is exactly what the rule forbids reading
 * as authority. So the unknown case is treated as the privileged one and fails
 * closed. There is no backfill; the 30-day retention sweep drains the NULL
 * population within a release cycle.
 */
export function isAdminOriginScreenshot(
  screenshotOrigin: IssueReportOrigin | null | undefined,
): boolean {
  return screenshotOrigin !== "MEMBER";
}

/**
 * Classify one report's screenshot for one caller.
 *
 * `retained` is passed in rather than recomputed, because the two read paths
 * answer it slightly differently and always have: the list route never selects
 * the blob and works from `screenshotCapturedAt`, while the detail route holds
 * the blob and also honours `screenshotExpiresAt` in case the retention sweep
 * has not yet run. Recomputing it here would have to pick one of those and
 * would silently change the other.
 */
export function classifyIssueReportScreenshot(params: {
  retained: boolean;
  screenshotOrigin: IssueReportOrigin | null | undefined;
  screenshotCapturedAt: Date | null;
  screenshotDeletedAt: Date | null;
  screenshotDeleteReason: string | null;
  viewerIsFullAdmin: boolean;
}): IssueReportScreenshotAccess {
  if (params.retained) {
    const gated =
      isAdminOriginScreenshot(params.screenshotOrigin) &&
      !params.viewerIsFullAdmin;
    return {
      disposition: gated ? "withheld" : "viewed",
      releasePixels: !gated,
      withheld: gated,
      retained: true,
    };
  }

  const notRetained = { releasePixels: false, withheld: false, retained: false };
  if (params.screenshotDeletedAt) {
    return {
      ...notRetained,
      disposition:
        params.screenshotDeleteReason === ISSUE_REPORT_RETENTION_DELETE_REASON
          ? "expired"
          : "deleted",
    };
  }

  // Nothing deleted it, so either nothing was ever captured or the expiry has
  // passed without the sweep having run yet. `screenshotCapturedAt` separates
  // the two, and it is the one field the list route always has.
  return {
    ...notRetained,
    disposition: params.screenshotCapturedAt ? "expired" : "none",
  };
}

/**
 * Whether this caller may be handed admin-origin pixels.
 *
 * Read off the session `requireAdmin` returns, which is not the JWT's own
 * claim: that guard overwrites `accessRoles` with the roles it has just read
 * from the database, precisely so a downstream separation-of-duties check never
 * trusts a stale token (#1012). `isFullAdmin` is the literal `ADMIN` role, so a
 * custom access role cannot reach this even if a club has given it every area.
 */
export function viewerIsFullAdmin(user: {
  accessRoles?: readonly string[] | null;
}): boolean {
  return isFullAdmin({ accessRoles: user.accessRoles ?? [] });
}

/**
 * The classification to store on a report being created.
 *
 * ADMIN when the reporter could reach any admin area at all — not when they
 * held the area matching some page, which would be route-to-permission
 * reconstruction by another name. Anyone admitted to the admin portal can
 * navigate to screens holding other members' records, so the whole population
 * is classified by the widest admin predicate there is. The cost is that an
 * officer's screenshot of an ordinary member-facing page is gated too; that is
 * the safe direction, and the alternative needs the page address the rule
 * rejects.
 *
 * TWO SOURCES, OR'D, BOTH SERVER-SIDE. `member` is the freshly-read database
 * row with its access-role definitions joined, which is authoritative and
 * catches a role granted since the token was minted. `sessionUser` is the
 * signed session, which catches a role revoked since the token was minted while
 * the holder may still have had an admin screen open. Either saying "admin" is
 * enough, so the classification can only err towards gating.
 */
export function deriveIssueReportScreenshotOrigin(params: {
  member: AdminPermissionInput;
  sessionUser: AdminPermissionInput | null | undefined;
}): IssueReportOrigin {
  const adminByRecord = hasAdminPortalAccess(params.member);
  const adminBySession = params.sessionUser
    ? hasAdminPortalAccess(params.sessionUser)
    : false;
  return adminByRecord || adminBySession ? "ADMIN" : "MEMBER";
}
