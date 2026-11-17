"use client";

import { adminHref } from "@/lib/admin-hubs";
import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { AdminViewOnlyNotice } from "@/components/admin/view-only-action";
import { CopyField } from "@/components/admin/integration-wizard";
import { BookingApprovalsPanel } from "@/components/admin/booking-requests/booking-approvals-panel";
import { BookingChangeRequestsPanel } from "@/components/admin/booking-requests/booking-change-requests-panel";
import { PolicyExceptionRequestsPanel } from "@/components/admin/booking-requests/policy-exception-requests-panel";
import { PublicBookingRequestsPanel } from "@/components/admin/booking-requests/public-booking-requests-panel";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import { useAdminQueueRefresh } from "@/hooks/use-admin-queue-refresh";
import {
  BOOKING_REQUEST_PENDING_COUNTS_PATH,
  BOOKING_REQUESTS_STATUS_PARAM,
  BOOKING_REQUESTS_TABS,
  bookingRequestsTabCounts,
  firstBookingRequestsTabWithWork,
  readBookingRequestPendingCounts,
  type BookingRequestsTab,
  type BookingRequestsTabCounts,
} from "@/lib/admin-booking-requests-path";
import { setAdminListPageParam } from "@/lib/admin-list-page";

const APPROVALS_SEARCH_PARAMS = { tab: "approvals" } satisfies Record<
  string,
  string
>;
const CHANGES_SEARCH_PARAMS = { tab: "changes" } satisfies Record<
  string,
  string
>;
const PUBLIC_SEARCH_PARAMS = { tab: "public" } satisfies Record<
  string,
  string
>;

function parseBookingRequestsTab(value: string | null): BookingRequestsTab {
  // Reads the shared BOOKING_REQUESTS_TABS array — the same authority the
  // diagnostics page-context allowlist imports (#2812) — so a new tab added
  // there is parsed here on the same edit, instead of silently mapping its
  // ?tab= value to approvals while the allowlist already admits it.
  return value !== null &&
    (BOOKING_REQUESTS_TABS as readonly string[]).includes(value)
    ? (value as BookingRequestsTab)
    : "approvals";
}

/**
 * The tab triggers, rendered by walking BOOKING_REQUESTS_TABS, so the order an
 * officer sees is the order the landing rule ("the first tab with work") reads.
 * Typed over the tab union, so a new tab cannot be added without a label.
 */
const TAB_LABELS: Record<BookingRequestsTab, string> = {
  approvals: "Approvals",
  changes: "Changes",
  exceptions: "Policy Exceptions",
  public: "Public Requests",
};

/**
 * Whether the URL already says where to open: a tab (other than `allowedTab`,
 * the one a panel may have written for itself), a record, or a status filter.
 */
function hasLandingTarget(
  searchParams: URLSearchParams,
  allowedTab?: BookingRequestsTab,
): boolean {
  const tab = searchParams.get("tab");
  return (
    (tab !== null && tab !== allowedTab) ||
    searchParams.has("bookingId") ||
    searchParams.has("requestId") ||
    searchParams.has(BOOKING_REQUESTS_STATUS_PARAM)
  );
}

function TabCountBadge({ count }: { count: number | undefined }) {
  if (!count || count <= 0) return null;
  return (
    <Badge
      variant="secondary"
      className="border-warning-6 bg-warning-3 text-warning-11"
    >
      {count}
    </Badge>
  );
}

export default function BookingRequestsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const activeTab = parseBookingRequestsTab(searchParams.get("tab"));
  const canEditBookings = useAdminAreaEditAccess("bookings");

  // One pending count per tab, from the same helper the sidebar badge adds up
  // (#4969), so the four tab badges are counted exactly as it is. Null until
  // the first read succeeds, and left null if it fails: the badges are
  // best-effort, and a page with no counts behaves exactly as before
  // (Approvals, no badges). A later failed read keeps the last good counts.
  const [tabCounts, setTabCounts] = useState<BookingRequestsTabCounts | null>(
    null,
  );

  // The public request form is UNLISTED BY DEFAULT (#2421, #2818 decision 1):
  // its page ships with an empty menu title, so no page a visitor can browse to
  // links to it and search engines are told to ignore it, until the club decides
  // otherwise under Site Appearance & Content -> Page Content. Either way an
  // admin needs the direct URL to hand to a guest the club has agreed to host.
  // `window.location.origin` is client-only, so it is resolved after mount (same
  // shape as /admin/display/devices) and the field shows its emptyHint until
  // then.
  const [publicRequestUrl, setPublicRequestUrl] = useState("");

  useEffect(() => {
    setPublicRequestUrl(`${window.location.origin}/booking-requests`);
  }, []);

  // Read when the page opens, and again on the triggers the sidebar's badge
  // uses (#4962): a decision on any panel here, window focus, the tab becoming
  // visible. Without that the sidebar would drop a decided request while this
  // tab's badge kept it, and the four badges would stop adding up to the
  // sidebar's. A failed read keeps the last good badges, as the sidebar keeps
  // its last good counts. Loads never overlap, so an older response cannot
  // overwrite a newer one. A reread never moves the officer: the landing tab
  // below is decided once, by the first read to settle. If that first read
  // fails, the page stays where it opened, so counts that arrive later (say
  // after the officer has approved something) cannot move them.
  const landingTabDecided = useRef(false);
  const refreshTabCounts = useAdminQueueRefresh(async (isMounted) => {
    let counts: ReturnType<typeof readBookingRequestPendingCounts> = null;
    try {
      const res = await fetch(BOOKING_REQUEST_PENDING_COUNTS_PATH, {
        cache: "no-store",
      });
      counts = readBookingRequestPendingCounts(res.ok ? await res.json() : null);
    } catch {
      /* badges are best-effort; the last good ones stay */
    }
    if (!isMounted()) return;
    if (counts) {
      setTabCounts(bookingRequestsTabCounts(counts));
    } else {
      landingTabDecided.current = true;
    }
  });
  useEffect(() => {
    refreshTabCounts();
  }, [refreshTabCounts]);

  // A link that opens this page with no tab (the sidebar's from another page,
  // the dashboard card's, a typed address) opens on the first tab with work
  // (#4969), so an officer who followed the sidebar badge never lands on an
  // empty Approvals while the work sits on another tab. Decided once per
  // mount, when the first read settles (no move at all if it failed), and only for a link that named no
  // tab, record (bookingId/requestId) or status filter — a status filter
  // belongs to the tab it was set on and means nothing on another. Once the
  // page has opened, the address names the tab (a bookmark taken from it keeps
  // that tab), and the sidebar link followed from this same page goes to
  // Approvals as it always has, with the tab badges showing where the work is.
  //
  // The link is judged as it was opened, not as it reads when the counts
  // arrive: the Approvals panel mounts at once and writes `?tab=approvals`
  // into the URL as its own canonical address, so the live URL never looks
  // bare by then. What does block the move is the officer acting first —
  // choosing a tab, or a filter or record on Approvals, while the counts load.
  // `replace`, not `push`, so Back still leaves the page in one step.
  const openedFromBareLink = useRef(!hasLandingTarget(searchParams));
  const officerChoseTab = useRef(false);
  useEffect(() => {
    if (landingTabDecided.current || tabCounts === null) return;
    landingTabDecided.current = true;
    if (!openedFromBareLink.current || officerChoseTab.current) return;
    if (hasLandingTarget(searchParams, "approvals")) return;
    const landingTab = firstBookingRequestsTabWithWork(tabCounts);
    if (landingTab === "approvals") return;
    const params = new URLSearchParams(searchParams.toString());
    params.set("tab", landingTab);
    router.replace(`${adminHref("booking-requests")}?${params.toString()}`, {
      scroll: false,
    });
  }, [tabCounts, searchParams, router]);

  function handleTabChange(value: string) {
    officerChoseTab.current = true;
    const nextTab = parseBookingRequestsTab(value);
    const params = new URLSearchParams(searchParams.toString());
    const status = params.get(BOOKING_REQUESTS_STATUS_PARAM);

    params.set("tab", nextTab);
    // Each tab's queue pages on its own (INV-OPS-020); a page from one tab
    // means nothing on another.
    setAdminListPageParam(params, 1);

    if (nextTab === "approvals") {
      params.delete("requestId");
      if (status === "REQUESTED") {
        params.delete(BOOKING_REQUESTS_STATUS_PARAM);
      }
    } else if (nextTab === "changes") {
      params.delete("bookingId");
      if (status === "PENDING") {
        params.delete(BOOKING_REQUESTS_STATUS_PARAM);
      }
    } else if (nextTab === "exceptions") {
      // The exception queue keeps its own in-panel status filter and has no
      // per-record deep link, so nothing from a sibling tab carries over.
      params.delete("bookingId");
      params.delete("requestId");
      params.delete(BOOKING_REQUESTS_STATUS_PARAM);
    } else {
      params.delete("bookingId");
      if (status === "PENDING" || status === "REQUESTED") {
        params.delete(BOOKING_REQUESTS_STATUS_PARAM);
      }
    }

    router.replace(`${adminHref("booking-requests")}?${params.toString()}`, {
      scroll: false,
    });
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Booking Requests</h1>
        <p className="mt-1 text-muted-foreground">
          Review new booking approvals, locked-period booking change
          requests, booking-policy exception requests, and public booking
          requests from non-members.
        </p>
      </div>

      {!canEditBookings ? (
        <AdminViewOnlyNotice canEdit={canEditBookings}>
          Your admin role can view booking requests but cannot approve, reject,
          price, hold, or convert them.
        </AdminViewOnlyNotice>
      ) : null}

      <Tabs value={activeTab} onValueChange={handleTabChange}>
        <TabsList className="grid h-auto w-full grid-cols-2 sm:w-auto sm:grid-cols-4">
          {BOOKING_REQUESTS_TABS.map((tabValue) => (
            <TabsTrigger key={tabValue} value={tabValue} className="gap-2">
              {TAB_LABELS[tabValue]}
              <TabCountBadge count={tabCounts?.[tabValue]} />
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="approvals" className="mt-6">
          {activeTab === "approvals" && canEditBookings !== undefined ? (
            <BookingApprovalsPanel
              fixedSearchParams={APPROVALS_SEARCH_PARAMS}
              showHeading={false}
              canEdit={canEditBookings}
            />
          ) : null}
        </TabsContent>
        <TabsContent value="changes" className="mt-6">
          {activeTab === "changes" && canEditBookings !== undefined ? (
            <BookingChangeRequestsPanel
              fixedSearchParams={CHANGES_SEARCH_PARAMS}
              showHeading={false}
              canEdit={canEditBookings}
            />
          ) : null}
        </TabsContent>
        <TabsContent value="exceptions" className="mt-6">
          {activeTab === "exceptions" && canEditBookings !== undefined ? (
            <PolicyExceptionRequestsPanel canEdit={canEditBookings} />
          ) : null}
        </TabsContent>
        <TabsContent value="public" className="mt-6">
          {activeTab === "public" ? (
            <div className="space-y-4">
              {/* Read-only affordance: sharing the link is not a booking write,
                  so it stays available to view-only admins (no edit gate). */}
              <CopyField
                label="Guest request form link"
                value={publicRequestUrl}
                emptyHint="Loading the site address…"
                description="Share this link directly with guests the club is willing to host. By default nothing on the public site links to the form and search engines are told to ignore it, so this is how a guest gets to it (the only other way in is the rebook button on a payment link the club emails a past requester). To put the form in your site menu instead, give its page a menu title under Site Appearance &amp; Content → Page Content — that also lets search engines list it."
              />
              <p className="rounded-md border border-border bg-muted p-3 text-sm text-muted-foreground">
                How a non-member request flows: the requester submits it and
                confirms their email, then it appears here under{" "}
                <span className="font-medium">Queue</span>. Price it, approve
                it, and it becomes a booking. Verified requests only show on
                this tab, not under Approvals, the Bookings list, or the
                Waitlist.
              </p>
              {canEditBookings !== undefined ? (
                <PublicBookingRequestsPanel
                  fixedSearchParams={PUBLIC_SEARCH_PARAMS}
                  showHeading={false}
                  canEdit={canEditBookings}
                />
              ) : null}
            </div>
          ) : null}
        </TabsContent>
      </Tabs>
    </div>
  );
}
