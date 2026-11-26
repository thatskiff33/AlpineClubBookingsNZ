import { getAppBaseUrl, rebaseOntoAppOrigin } from "@/lib/app-url";

/** `IssueReport.pageUrl` is `VarChar(2048)`. */
export const ISSUE_REPORT_PAGE_URL_MAX_LENGTH = 2048;

/**
 * The page address stored for a new issue report: the page of this site the
 * member named, on the configured origin (GHSA-q9f4-243m-6f54). `null` when
 * what was submitted is not a web address, or when the result would not fit
 * the column: placing a short host's path on a longer origin, or encoding its
 * characters, can lengthen it past what the member sent.
 */
export function issueReportPageUrlToStore(submitted: string): string | null {
  const pageUrl = rebaseOntoAppOrigin(submitted);
  if (!pageUrl || pageUrl.length > ISSUE_REPORT_PAGE_URL_MAX_LENGTH) {
    return null;
  }
  return pageUrl;
}

/**
 * The page address shown to an officer for a stored report. Held to the same
 * rule as a new report, because a row written before that rule existed may
 * carry another host and this is the link an officer clicks. A stored value
 * that is not a web address shows the site's own address instead.
 */
export function issueReportPageUrlToShow(stored: string): string {
  return rebaseOntoAppOrigin(stored) ?? getAppBaseUrl();
}
