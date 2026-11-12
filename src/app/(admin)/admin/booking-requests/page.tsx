"use client";

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
import {
  BOOKING_REQUESTS_TABS,
  bookingRequestsTabCounts,
  firstBookingRequestsTabWithWork,
  type BookingRequestsTab,
  type BookingRequestsTabCounts,
} from "@/lib/admin-booking-requests-path";
import type { BookingRequestPendingCounts } from "@/lib/admin-booking-request-pending-counts";

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

const PENDING_COUNT_KEYS = [
  "bookingReviews",
  "lockedPeriodChangeRequests",
  "policyExceptionRequests",
  "publicBookingRequests",
] as const satisfies readonly (keyof BookingRequestPendingCounts)[];

function readPendingCounts(data: unknown): BookingRequestPendingCounts | null {
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  return PENDING_COUNT_KEYS.every((key) => typeof record[key] === "number")
    ? (record as BookingRequestPendingCounts)
    : null;
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

  // One pending count per tab, from the same payload the sidebar badge adds up
  // (#4969), so the four tab badges always sum to it. Null until loaded, and
  // left null if the read fails: the badges are best-effort, and a page with no
  // counts behaves exactly as before (Approvals, no badges).
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

  useEffect(() => {
    let active = true;
    fetch("/api/admin/pending-counts")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        const counts = readPendingCounts(data);
        if (active && counts) {
          setTabCounts(bookingRequestsTabCounts(counts));
        }
      })
      .catch(() => {
        /* badges are best-effort; ignore fetch errors */
      });
    return () => {
      active = false;
    };
  }, []);

  // A bare link to this page (the sidebar's, a bookmark) opens on the first
  // tab with work (#4969), so an officer who followed the sidebar badge never
  // lands on an empty Approvals while the work sits on another tab. Decided
  // once per mount, when the counts arrive: an explicit ?tab= — including one
  // the officer picked while the counts were loading — always wins, and so does
  // a record deep link (bookingId/requestId) or a status filter, which belongs
  // to the tab it was set on and means nothing on another. `replace`, not
  // `push`, so Back still leaves the page in one step.
  const landingTabDecided = useRef(false);
  useEffect(() => {
    if (landingTabDecided.current || tabCounts === null) return;
    landingTabDecided.current = true;
    if (
      searchParams.has("tab") ||
      searchParams.has("bookingId") ||
      searchParams.has("requestId") ||
      searchParams.has("status")
    ) {
      return;
    }
    const landingTab = firstBookingRequestsTabWithWork(tabCounts);
    if (landingTab === "approvals") return;
    const params = new URLSearchParams(searchParams.toString());
    params.set("tab", landingTab);
    router.replace(`/admin/booking-requests?${params.toString()}`, {
      scroll: false,
    });
  }, [tabCounts, searchParams, router]);

  function handleTabChange(value: string) {
    const nextTab = parseBookingRequestsTab(value);
    const params = new URLSearchParams(searchParams.toString());

    params.set("tab", nextTab);

    if (nextTab === "approvals") {
      params.delete("requestId");
      if (params.get("status") === "REQUESTED") {
        params.delete("status");
      }
    } else if (nextTab === "changes") {
      params.delete("bookingId");
      if (params.get("status") === "PENDING") {
        params.delete("status");
      }
    } else if (nextTab === "exceptions") {
      // The exception queue keeps its own in-panel status filter and has no
      // per-record deep link, so nothing from a sibling tab carries over.
      params.delete("bookingId");
      params.delete("requestId");
      params.delete("status");
    } else {
      params.delete("bookingId");
      if (params.get("status") === "PENDING" || params.get("status") === "REQUESTED") {
        params.delete("status");
      }
    }

    router.replace(`/admin/booking-requests?${params.toString()}`, {
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
        <TabsList className="grid w-full grid-cols-2 sm:w-auto sm:grid-cols-4">
          <TabsTrigger value="approvals" className="gap-2">
            Approvals
            <TabCountBadge count={tabCounts?.approvals} />
          </TabsTrigger>
          <TabsTrigger value="changes" className="gap-2">
            Changes
            <TabCountBadge count={tabCounts?.changes} />
          </TabsTrigger>
          <TabsTrigger value="exceptions" className="gap-2">
            Policy Exceptions
            <TabCountBadge count={tabCounts?.exceptions} />
          </TabsTrigger>
          <TabsTrigger value="public" className="gap-2">
            Public Requests
            <TabCountBadge count={tabCounts?.public} />
          </TabsTrigger>
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
