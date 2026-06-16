"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { BookingApprovalsPanel } from "@/components/admin/booking-requests/booking-approvals-panel";
import { BookingChangeRequestsPanel } from "@/components/admin/booking-requests/booking-change-requests-panel";
import { PublicBookingRequestsPanel } from "@/components/admin/booking-requests/public-booking-requests-panel";
import type { BookingRequestsTab } from "@/lib/admin-booking-requests-path";

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
  if (value === "changes") return "changes";
  if (value === "public") return "public";
  return "approvals";
}

export default function BookingRequestsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const activeTab = parseBookingRequestsTab(searchParams.get("tab"));

  // Pending public-request count, so admins can see at a glance that
  // verified non-member requests are waiting on the Public Requests tab
  // (issue #779 — they previously looked under Approvals/Bookings/Waitlist).
  const [publicQueueCount, setPublicQueueCount] = useState(0);

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
          requests, and public booking requests from non-members.
        </p>
      </div>

      <Tabs value={activeTab} onValueChange={handleTabChange}>
        <TabsList className="grid w-full grid-cols-3 sm:w-auto">
          <TabsTrigger value="approvals">Approvals</TabsTrigger>
          <TabsTrigger value="changes">Changes</TabsTrigger>
          <TabsTrigger value="public" className="gap-2">
            Public Requests
            {publicQueueCount > 0 && (
              <Badge
                variant="secondary"
                className="border-amber-200 bg-amber-100 text-amber-800"
              >
                {publicQueueCount}
              </Badge>
            )}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="approvals" className="mt-6">
          {activeTab === "approvals" ? (
            <BookingApprovalsPanel
              fixedSearchParams={APPROVALS_SEARCH_PARAMS}
              showHeading={false}
            />
          ) : null}
        </TabsContent>
        <TabsContent value="changes" className="mt-6">
          {activeTab === "changes" ? (
            <BookingChangeRequestsPanel
              fixedSearchParams={CHANGES_SEARCH_PARAMS}
              showHeading={false}
            />
          ) : null}
        </TabsContent>
        <TabsContent value="public" className="mt-6">
          {activeTab === "public" ? (
            <div className="space-y-4">
              <p className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600">
                How a non-member request flows: the requester submits it and
                confirms their email, then it appears here under{" "}
                <span className="font-medium">Queue</span>. Price it, approve
                it, and it becomes a booking. Verified requests only show on
                this tab, not under Approvals, the Bookings list, or the
                Waitlist.
              </p>
              <PublicBookingRequestsPanel
                fixedSearchParams={PUBLIC_SEARCH_PARAMS}
                showHeading={false}
              />
            </div>
          ) : null}
        </TabsContent>
      </Tabs>
    </div>
  );
}
