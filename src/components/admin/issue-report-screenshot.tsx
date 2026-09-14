"use client";

import { Badge } from "@/components/ui/badge";

/**
 * How an issue report's screenshot is presented to the officer looking at it.
 *
 * Lifted out of `/admin/issue-reports` when `INV-PRIV-020` (#2703) gave the
 * screenshot a third state. The queue badge and the detail panel have to agree
 * about what "withheld" looks like and what it is called, and they sat two
 * hundred lines apart in the page; here they are adjacent and there is one
 * wording of the explanation rather than two.
 */

export type IssueReportScreenshotState = {
  deletedAt: string | null;
  retained: boolean;
  /**
   * The screenshot is stored, but the reporter had admin access when they
   * captured it and this viewer is not a Full Admin. The API sends no pixels at
   * all, so the panel explains itself rather than showing an empty frame.
   */
  withheld: boolean;
};

export function IssueReportScreenshotBadge({
  screenshot,
}: {
  screenshot: IssueReportScreenshotState;
}) {
  if (screenshot.withheld) {
    return (
      <Badge className="border-warning-6 bg-warning-3 text-warning-11">
        Screenshot withheld
      </Badge>
    );
  }
  if (screenshot.retained) {
    return (
      <Badge className="border-info-6 bg-info-3 text-info-11">
        Screenshot retained
      </Badge>
    );
  }
  if (screenshot.deletedAt) {
    return (
      <Badge className="border-border bg-muted text-muted-foreground">
        Screenshot deleted
      </Badge>
    );
  }
  return <Badge variant="outline">No screenshot</Badge>;
}

export function IssueReportScreenshotPanel({
  screenshot,
}: {
  screenshot: IssueReportScreenshotState & { dataUrl: string | null };
}) {
  if (screenshot.withheld) {
    return (
      <div className="rounded-md border border-warning-6 bg-warning-3 p-4 text-sm text-warning-11">
        <p className="font-medium">Screenshot withheld</p>
        <p className="mt-1">
          The person who reported this had admin access when they captured it,
          so the picture may show another member&apos;s personal details. Full
          Admin access is needed to view it. The rest of the report is
          unaffected, and you can still delete the screenshot.
        </p>
      </div>
    );
  }

  if (screenshot.dataUrl) {
    return (
      <div className="overflow-hidden rounded-md border border-border bg-muted">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={screenshot.dataUrl}
          alt="Issue report screenshot"
          className="max-h-[520px] w-full object-contain"
        />
      </div>
    );
  }

  return (
    <div className="rounded-md border border-dashed border-border bg-muted p-4 text-sm text-muted-foreground">
      Screenshot is not retained for this report.
    </div>
  );
}
