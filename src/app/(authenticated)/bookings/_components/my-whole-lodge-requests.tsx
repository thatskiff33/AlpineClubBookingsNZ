"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import type {
  MyWholeLodgeRequestItem,
  MyWholeLodgeRequestStatus,
} from "@/lib/member-whole-lodge-requests";
import { calendarDateOfSerialisedDbDate, formatClubDate } from "@/lib/club-time";

/*
  #2263 — "My requests" on My bookings.

  Every word a member reads about a request comes from this file and from the
  four-value status the server already reduced it to. In particular the DECLINED
  row's sentence is FIXED here: the officer's note is never persisted on a
  member-origin request and never reaches this component, so there is no path by
  which a note that mentions another group's booking could be rendered.

  The section is hidden entirely when the member has no requests (D3), so the
  ordinary member never meets a feature they are not using.
*/

const STATUS_LABEL: Record<MyWholeLodgeRequestStatus, string> = {
  pending: "With the booking officer",
  approved: "Approved",
  declined: "Not available",
  withdrawn: "Withdrawn",
};

const STATUS_BADGE_CLASS: Record<MyWholeLodgeRequestStatus, string> = {
  pending: "border-info/30 bg-info-muted text-info",
  approved: "border-success/30 bg-success-muted text-success",
  declined: "border-muted-foreground/30 bg-muted text-muted-foreground",
  withdrawn: "border-muted-foreground/30 bg-muted text-muted-foreground",
};

/** The one sentence a declined request ever says. No note, no reason, no dates. */
const DECLINED_COPY =
  "The booking officer was not able to offer the whole lodge for those dates. Give them a call if you would like to talk through other options.";

function formatRange(checkIn: string, checkOut: string) {
  // Date-only lodge nights, which are CALENDAR DATES and take no zone at all
  // (CT-4, #2870): the kernel reads the day out of the serialised value's first
  // ten characters and formats it pinned to `UTC`, so no viewer's clock and no
  // club's setting can move it. `formatNZDate` projected it through
  // `APP_TIME_ZONE`, which cancelled only because New Zealand is east of
  // Greenwich.
  const format = (value: string) =>
    formatClubDate(calendarDateOfSerialisedDbDate(value));
  return `${format(checkIn)} – ${format(checkOut)}`;
}

export function MyWholeLodgeRequests({
  requests,
}: {
  requests: MyWholeLodgeRequestItem[];
}) {
  const router = useRouter();
  const [withdrawingId, setWithdrawingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (requests.length === 0) return null;

  async function handleWithdraw(id: string) {
    setError(null);
    setWithdrawingId(id);
    try {
      const response = await fetch(
        `/api/booking-requests/whole-lodge/${id}/withdraw`,
        { method: "POST" }
      );
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(data.error || "Could not withdraw this request");
      }
      router.refresh();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not withdraw this request"
      );
    } finally {
      setWithdrawingId(null);
    }
  }

  return (
    <section className="space-y-3" aria-labelledby="my-whole-lodge-requests">
      <div className="space-y-1">
        <h2 id="my-whole-lodge-requests" className="text-xl font-semibold">
          My requests
        </h2>
        <p className="text-sm text-muted-foreground">
          Whole-lodge requests you have sent to the booking officer. Requests
          that were declined or withdrawn are removed after 90 days.
        </p>
      </div>

      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}

      <div className="space-y-3">
        {requests.map((request) => (
          <Card key={request.id}>
            <CardContent className="flex flex-col gap-3 pt-6 sm:flex-row sm:items-start sm:justify-between">
              <div className="space-y-1">
                <p className="font-medium">
                  {formatRange(request.checkIn, request.checkOut)}
                </p>
                <p className="text-sm text-muted-foreground">
                  Whole lodge · about {request.headcount}{" "}
                  {request.headcount === 1 ? "person" : "people"}
                </p>
                {request.status === "declined" && (
                  <p className="max-w-prose text-sm text-muted-foreground">
                    {DECLINED_COPY}
                  </p>
                )}
              </div>

              <div className="flex shrink-0 flex-col items-start gap-2 sm:items-end">
                <Badge
                  variant="outline"
                  className={STATUS_BADGE_CLASS[request.status]}
                >
                  {STATUS_LABEL[request.status]}
                </Badge>
                {request.status === "approved" && request.bookingId && (
                  <Button asChild size="sm" variant="outline">
                    <Link href={`/bookings/${request.bookingId}`}>
                      Open booking
                    </Link>
                  </Button>
                )}
                {request.canWithdraw && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={withdrawingId === request.id}
                    onClick={() => void handleWithdraw(request.id)}
                  >
                    {withdrawingId === request.id
                      ? "Withdrawing..."
                      : "Withdraw"}
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </section>
  );
}
