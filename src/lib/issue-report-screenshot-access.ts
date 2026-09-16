import type { IssueReportOrigin } from "@prisma/client";

import {
  hasAdminPortalAccess,
  type AdminPermissionInput,
} from "@/lib/admin-permissions";
import { ISSUE_REPORT_RETENTION_DELETE_REASON } from "@/lib/issue-report-retention";

/**
 * THE ONE HOME for `INV-PRIV-021` (#2703): **admin-origin issue-report
 * screenshot pixels are Full-Admin-only**. Ordinary issue-report text and diagnostics keep
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
 *
 * ## What is NOT here, and why
 *
 * `viewerIsFullAdmin` is the repository's existing `isFullAdmin`, called
 * directly by the read routes exactly as five other admin surfaces call it.
 * There was briefly a wrapper here; it named nothing `isFullAdmin` does not
 * already name. The one thing worth knowing is not a function but a fact about
 * its ARGUMENT: the routes pass the session `requireAdmin` returned, and that
 * guard has already replaced `accessRoles` with the roles it read from the
 * database (#1012), so this gate never rests on a stale token.
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

/** The stored screenshot stamps every read path holds, whatever it selects. */
export type IssueReportScreenshotStamps = {
  screenshotCapturedAt: Date | null;
  screenshotExpiresAt: Date | null;
  screenshotDeletedAt: Date | null;
};

/**
 * Whether a report's pixels are still stored and still servable — ONE
 * definition, for every read path.
 *
 * It used to be two. The detail route held the blob and honoured
 * `screenshotExpiresAt`; the list route selected no blob and answered from the
 * capture and deletion stamps alone, even though it selected the expiry as
 * well. So for the hours between an expiry and the nightly sweep reaching it,
 * the queue said "retained" about a screenshot the report itself already
 * refused — and after #2703 the two would have disagreed about `withheld` too.
 *
 * The three stamps are all it reads, deliberately. A caller that ALSO holds
 * `screenshotDataUrl` needs no extra check, because both writers that clear the
 * blob — the retention sweep and the administrator delete — stamp
 * `screenshotDeletedAt` in the same update, so a null blob always carries a
 * deletion stamp. The one consumer of the pixels guards that anyway: the detail
 * payload emits `screenshotDataUrl` only when it is non-null.
 */
export function isIssueReportScreenshotRetained(
  stamps: IssueReportScreenshotStamps,
  now: Date,
): boolean {
  return Boolean(
    stamps.screenshotCapturedAt &&
      !stamps.screenshotDeletedAt &&
      (!stamps.screenshotExpiresAt || stamps.screenshotExpiresAt > now),
  );
}

/**
 * Classify one report's screenshot for one caller.
 *
 * `retained` is COMPUTED here rather than accepted from the caller, so the list
 * and the detail read cannot answer it differently — see
 * `isIssueReportScreenshotRetained` for the divergence that used to exist.
 */
export function classifyIssueReportScreenshot(
  params: IssueReportScreenshotStamps & {
    screenshotOrigin: IssueReportOrigin | null | undefined;
    screenshotDeleteReason: string | null;
    viewerIsFullAdmin: boolean;
    now?: Date;
  },
): IssueReportScreenshotAccess {
  if (isIssueReportScreenshotRetained(params, params.now ?? new Date())) {
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
  // passed without the sweep having reached the row yet.
  return {
    ...notRetained,
    disposition: params.screenshotCapturedAt ? "expired" : "none",
  };
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
