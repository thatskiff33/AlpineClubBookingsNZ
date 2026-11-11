"use client";

import { adminHref } from "@/lib/admin-hubs";
import { useEffect, useState } from "react";
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
  type BookingRequestsTab,
} from "@/lib/admin-booking-requests-path";

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

export default function BookingRequestsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const activeTab = parseBookingRequestsTab(searchParams.get("tab"));
  const canEditBookings = useAdminAreaEditAccess("bookings");

  // Pending public-request count, so admins can see at a glance that
  // verified non-member requests are waiting on the Public Requests tab
  // (issue #779 — they previously looked under Approvals/Bookings/Waitlist).
  const [publicQueueCount, setPublicQueueCount] = useState(0);

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

  // Pending booking-policy exception count (#2526), so an officer can see at a
  // glance that a member is waiting on a decision that gates a real booking.
  const [exceptionQueueCount, setExceptionQueueCount] = useState(0);

  useEffect(() => {
    let active = true;
    fetch("/api/admin/booking-exception-requests?status=REQUESTED&pageSize=1")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (active && data && typeof data.total === "number") {
          setExceptionQueueCount(data.total);
        }
      })
      .catch(() => {
        /* badge is best-effort; ignore fetch errors */
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    fetch("/api/admin/booking-requests?status=QUEUE&pageSize=1")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (active && data && typeof data.total === "number") {
          setPublicQueueCount(data.total);
        }
      })
      .catch(() => {
        /* badge is best-effort; ignore fetch errors */
      });
    return () => {
      active = false;
    };
  }, []);

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
        <TabsList className="grid w-full grid-cols-2 sm:w-auto sm:grid-cols-4">
          <TabsTrigger value="approvals">Approvals</TabsTrigger>
          <TabsTrigger value="changes">Changes</TabsTrigger>
          <TabsTrigger value="exceptions" className="gap-2">
            Policy Exceptions
            {exceptionQueueCount > 0 && (
              <Badge
                variant="secondary"
                className="border-warning-6 bg-warning-3 text-warning-11"
              >
                {exceptionQueueCount}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="public" className="gap-2">
            Public Requests
            {publicQueueCount > 0 && (
              <Badge
                variant="secondary"
                className="border-warning-6 bg-warning-3 text-warning-11"
              >
                {publicQueueCount}
              </Badge>
            )}
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
