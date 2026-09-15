"use client";

import type { IssueReportScreenshotDisposition } from "@/lib/issue-report-screenshot-access";
import { Badge } from "@/components/ui/badge";

/**
 * How an issue report's screenshot is presented to the officer looking at it.
 *
 * Lifted out of `/admin/issue-reports` when `INV-PRIV-021` (#2703) gave the
 * screenshot a third state. The queue badge and the detail panel have to agree
 * about what each state looks like and what it is called, and they sat two
 * hundred lines apart in the page; here they are adjacent and there is one
 * wording of each.
 *
 * ## One field, not four booleans
 *
 * Both routes now send `disposition` — the server's own classification — and
 * these switch on it. They used to re-derive the state on the client from
 * `retained` / `deletedAt` / `withheld`, which is a second copy of a decision
 * the server had already made, and it was already wrong in one case: an expired
 * screenshot and one an administrator deleted both fell to the same branch and
 * read "Screenshot deleted", so the page could not tell an officer that a
 * picture had simply aged out.
 *
 * The import is `import type`, so nothing from the access module — which
 * reaches Prisma through the retention helper — survives into the client
 * bundle.
 */

export type IssueReportScreenshotState = {
  disposition: IssueReportScreenshotDisposition;
};

const BADGE_CLASS: Record<IssueReportScreenshotDisposition, string> = {
  viewed: "border-info-6 bg-info-3 text-info-11",
  withheld: "border-warning-6 bg-warning-3 text-warning-11",
  expired: "border-border bg-muted text-muted-foreground",
  deleted: "border-border bg-muted text-muted-foreground",
  none: "",
};

const BADGE_LABEL: Record<IssueReportScreenshotDisposition, string> = {
  viewed: "Screenshot retained",
  withheld: "Screenshot withheld",
  expired: "Screenshot expired",
  deleted: "Screenshot deleted",
  none: "No screenshot",
};

export function IssueReportScreenshotBadge({
  screenshot,
}: {
  screenshot: IssueReportScreenshotState;
}) {
  if (screenshot.disposition === "none") {
    return <Badge variant="outline">{BADGE_LABEL.none}</Badge>;
  }
  return (
    <Badge className={BADGE_CLASS[screenshot.disposition]}>
      {BADGE_LABEL[screenshot.disposition]}
    </Badge>
  );
}

function NotShown({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-dashed border-border bg-muted p-4 text-sm text-muted-foreground">
      {children}
    </div>
  );
}

export function IssueReportScreenshotPanel({
  screenshot,
}: {
  screenshot: IssueReportScreenshotState & { dataUrl: string | null };
}) {
  if (screenshot.disposition === "withheld") {
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

  if (screenshot.disposition === "viewed") {
    // `dataUrl` is present on every `viewed` payload the routes build. The
    // fallback is belt: a null blob here would mean a row whose pixels were
    // cleared without the deletion stamp both writers set, and an empty image
    // frame is a worse way to find that out than a sentence.
    return screenshot.dataUrl ? (
      <div className="overflow-hidden rounded-md border border-border bg-muted">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={screenshot.dataUrl}
          alt="Issue report screenshot"
          className="max-h-[520px] w-full object-contain"
        />
      </div>
    ) : (
      <NotShown>Screenshot is not available for this report.</NotShown>
    );
  }

  if (screenshot.disposition === "expired") {
    return (
      <NotShown>
        Screenshot reached its 30-day retention limit and was removed
        automatically.
      </NotShown>
    );
  }

  if (screenshot.disposition === "deleted") {
    return <NotShown>Screenshot was deleted by an administrator.</NotShown>;
  }

  return <NotShown>No screenshot was attached to this report.</NotShown>;
}
