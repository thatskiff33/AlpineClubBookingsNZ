"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  MEMBER_EXCEPTION_REPLACE_NOTICE,
  MEMBER_EXCEPTION_STATUS_EXPLANATIONS,
  MEMBER_EXCEPTION_STATUS_LABELS,
  memberExceptionCapacityWording,
  memberExceptionRuleLabel,
  type MemberExceptionRequestItem,
  type MemberExceptionRequestStatus,
} from "@/lib/member-exception-requests";
import { useClubTime } from "@/components/club-time-provider";
import { formatClubDate, parseCalendarDate } from "@/lib/club-time";

/**
 * "My booking-rule requests" — the member's request-management area (#2562).
 *
 * Every word a member reads about one of their exception requests comes from this
 * file and from the DTO the server already reduced the row to
 * (`src/lib/member-exception-requests.ts`). The officer's INTERNAL note is not a
 * field on that DTO, is not selected by the read behind it, and therefore cannot
 * be rendered here by accident — which is the point of the split.
 *
 * The section shows every state the owner's decision lists, and keeps two of them
 * apart that a shorter status list would merge: a request nobody has looked at yet
 * and a request an officer HAS tried to apply and the lodge stopped. It also
 * carries the two lifecycle actions in the same place the status is read, because
 * "withdraw" and "replace" are the only two things a member can actually do about
 * an open request, and sending them elsewhere to do them is how a member ends up
 * phoning the club instead.
 *
 * Empty states are deliberately absent: the page mounts this only when the member
 * has at least one request, so an ordinary member never meets a feature they are
 * not using (the #2263 precedent, D3).
 */

const STATUS_BADGE_CLASS: Record<MemberExceptionRequestStatus, string> = {
  pending: "border-info-6 bg-info-3 text-info-11",
  // Warning, not danger: the request is alive and an officer is still on it. A
  // red badge would read as a refusal, which is exactly the false decision the
  // owner's acceptance criteria forbid inventing.
  "pending-capacity-conflict": "border-warning-6 bg-warning-3 text-warning-11",
  approved: "border-success-6 bg-success-3 text-success-11",
  refused: "border-border bg-muted text-muted-foreground",
  withdrawn: "border-border bg-muted text-muted-foreground",
  superseded: "border-border bg-muted text-muted-foreground",
  expired: "border-border bg-muted text-muted-foreground",
};

/**
 * One proposed lodge night, which is a CALENDAR DAY and takes no timezone at all
 * (CT-4, #2870). Every night on this DTO is a `YYYY-MM-DD` key
 * (`src/lib/member-exception-requests.ts`), so it is already the day it means;
 * the kernel's calendar-date formatter pins `UTC` over the UTC-midnight
 * encoding, which is provably the identity for every club. `formatNZDate` used
 * to project it through `APP_TIME_ZONE`, and that cancelled only because New
 * Zealand is east of Greenwich.
 *
 * `parseCalendarDate` rather than `requireCalendarDate`: a malformed key here
 * would throw inside a member's booking list and blank the whole page, where
 * echoing the raw value shows the member something and loses nothing.
 */
function formatNight(value: string) {
  const night = parseCalendarDate(value);
  return night === null ? value : formatClubDate(night);
}

/**
 * Where the member goes to correct a request.
 *
 * A replacement is NOT an edit of the stored proposal — the officer decides the
 * exact proposal that was frozen — so the member is taken back to the wizard that
 * built it, with the request id carried along. The wizard hands that id to the
 * create call as `supersedeRequestId`, and the service claims the old request
 * REQUESTED -> SUPERSEDED in the same transaction that creates the replacement, so
 * a lost claim creates nothing at all.
 */
export function replaceRequestHref(request: MemberExceptionRequestItem): string {
  if (request.source === "MODIFICATION" && request.bookingId) {
    return `/bookings/${request.bookingId}?replaceRequest=${encodeURIComponent(request.id)}`;
  }
  return `/book?replaceRequest=${encodeURIComponent(request.id)}`;
}

/**
 * The endpoint that withdraws one request. Two paths, because the two flavours
 * live in different tables behind different route trees; both are the guarded
 * REQUESTED -> CANCELLED claim, and both answer 409 when the claim is lost.
 */
function withdrawPath(request: MemberExceptionRequestItem): string | null {
  if (request.source === "NEW_BOOKING") {
    return `/api/bookings/exception-requests/${request.id}`;
  }
  return request.bookingId
    ? `/api/bookings/${request.bookingId}/exception-requests/${request.id}`
    : null;
}

export function MyExceptionRequests({
  requests,
}: {
  requests: MemberExceptionRequestItem[];
}) {
  const router = useRouter();
  /*
    `createdAt`, `reviewedAt` and `lastConflictAt` are real INSTANTS, so they
    have no civil date until a zone is chosen — and the one to choose is the
    club's PERSISTED setting, delivered to this browser as data by
    `ClubTimeProvider` (CT-4, #2870; INV-CONFIG-002). It used to be
    `APP_TIME_ZONE`, the container's `TZ`. Same shape, only the AUTHORITY moved.
  */
  const clubTime = useClubTime();
  const [withdrawingId, setWithdrawingId] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (requests.length === 0) return null;

  async function handleWithdraw(request: MemberExceptionRequestItem) {
    const path = withdrawPath(request);
    if (!path) {
      setError(
        "This request cannot be withdrawn from here. Ask the club to close it for you.",
      );
      return;
    }
    setError(null);
    setWithdrawingId(request.id);
    try {
      const response = await fetch(path, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "cancel" }),
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(
          data.error ||
            "This request could not be withdrawn. Reload the page and look at its status.",
        );
      }
      setConfirmingId(null);
      router.refresh();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "This request could not be withdrawn. Reload the page and look at its status.",
      );
    } finally {
      setWithdrawingId(null);
    }
  }

  return (
    <section
      className="space-y-3"
      id="booking-rule-requests"
      aria-labelledby="my-exception-requests"
    >
      <div className="space-y-1">
        <h2 id="my-exception-requests" className="text-xl font-semibold">
          My booking-rule requests
        </h2>
        <p className="text-sm text-muted-foreground">
          Times you have asked a Booking Officer to let a booking past one of the
          club&apos;s rules. A request is not a booking, and approval is at the
          officer&apos;s discretion.
        </p>
      </div>

      {error && (
        <p role="alert" className="text-sm text-danger-11">
          {error}
        </p>
      )}

      <div className="space-y-3">
        {requests.map((request) => {
          const capacity = memberExceptionCapacityWording({
            source: request.source,
            status: request.status,
            capacityHeld: request.capacityHeld,
            // The frozen mode, so a NO_HOLD change that DOES need beds is never
            // told it needs none (#2562 review).
            capacityMode: request.capacityMode,
            // The CREATED booking's own answer on an approved new booking. An
            // approval lands the booking on PENDING or PAYMENT_PENDING, which
            // holds no bed until it is paid, so this row must not tell the member
            // their beds are secured (#2562 review).
            createdBookingHoldsCapacity: request.createdBookingHoldsCapacity,
            // Whether that booking can still be paid (#2562 re-review). "Holds no
            // beds" is equally true of an unpaid booking and a cancelled one, and
            // only one of them is worth opening the wallet for.
            createdBookingAwaitsPayment: request.createdBookingAwaitsPayment,
          });
          const isConfirming = confirmingId === request.id;
          return (
            <Card key={request.id} data-testid="exception-request-row">
              <CardContent className="flex flex-col gap-4 pt-6 lg:flex-row lg:items-start lg:justify-between">
                <div className="min-w-0 space-y-3 text-sm">
                  <div className="space-y-1">
                    <p className="font-medium">
                      {request.source === "NEW_BOOKING"
                        ? "A new booking"
                        : "A change to a booking"}
                      {request.proposal.checkIn && request.proposal.checkOut
                        ? ` · ${formatNight(request.proposal.checkIn)} to ${formatNight(request.proposal.checkOut)}`
                        : ""}
                    </p>
                    <p className="text-muted-foreground">
                      Asked on {clubTime.instantDateTime(new Date(request.createdAt))}
                      {request.reviewedAt
                        ? ` · decided ${clubTime.instantDateTime(new Date(request.reviewedAt))}`
                        : ""}
                    </p>
                  </div>

                  <p>{MEMBER_EXCEPTION_STATUS_EXPLANATIONS[request.status]}</p>

                  {/* The recorded conflict, in the member's words. Shown for an
                      OPEN request, which is the only time it is still live news —
                      the DTO already withholds the state for a decided row. */}
                  {request.status === "pending-capacity-conflict" &&
                  request.lastConflictReason ? (
                    <p className="rounded-md border border-warning-6 bg-warning-3 p-2 text-warning-11">
                      What the lodge said last time: {request.lastConflictReason}
                      {request.lastConflictAt
                        ? ` (${clubTime.instantDateTime(new Date(request.lastConflictAt))})`
                        : ""}
                    </p>
                  ) : null}

                  <p className="text-muted-foreground">{capacity}</p>

                  {/* The exact frozen proposal — what the officer decides, read
                      back to the member rather than summarised. */}
                  <div className="rounded-md border border-border p-3">
                    <p className="font-medium">What you asked for</p>
                    {request.proposal.baseCheckIn &&
                    request.proposal.baseCheckOut ? (
                      <p className="mt-1 text-muted-foreground">
                        The booking today: {formatNight(request.proposal.baseCheckIn)}{" "}
                        to {formatNight(request.proposal.baseCheckOut)}
                        {request.proposal.baseGuestNights !== null
                          ? ` · ${request.proposal.baseGuestNights} guest nights`
                          : ""}
                      </p>
                    ) : null}
                    <p className="mt-1 text-muted-foreground">
                      {request.proposal.guestNights} guest nights across{" "}
                      {request.proposal.guests.length}{" "}
                      {request.proposal.guests.length === 1 ? "guest" : "guests"}
                    </p>
                    {request.proposal.guests.length > 0 ? (
                      <ul className="mt-2 space-y-1 text-muted-foreground">
                        {request.proposal.guests.map((guest, index) => (
                          <li key={`${guest.firstName}-${guest.lastName}-${index}`}>
                            {guest.firstName} {guest.lastName}
                            {guest.isMember ? " (member)" : ""}
                            {guest.nights.length > 0
                              ? ` · ${guest.nights.length} ${guest.nights.length === 1 ? "night" : "nights"} (${guest.nights
                                  .map(formatNight)
                                  .join(", ")})`
                              : ""}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="mt-2 text-danger-11">
                        The saved details of this request cannot be read. Withdraw
                        it and ask again, or give the club a call.
                      </p>
                    )}
                  </div>

                  {request.rules.length > 0 ? (
                    <div className="rounded-md border border-border p-3">
                      <p className="font-medium">
                        {request.rules.length === 1
                          ? "The rule you asked to be let past"
                          : "The rules you asked to be let past"}
                      </p>
                      <ul className="mt-2 space-y-1 text-muted-foreground">
                        {request.rules.map((rule, index) => (
                          <li key={`${rule.reasonCode}-${index}`}>
                            {memberExceptionRuleLabel(rule.reasonCode)}
                            {rule.message ? ` — ${rule.message}` : ""}
                            {rule.affectedNights.length > 0
                              ? ` (${rule.affectedNights.map(formatNight).join(", ")})`
                              : ""}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}

                  {request.memberMessage ? (
                    <div className="rounded-md border border-border p-3">
                      <p className="font-medium">What you told the officer</p>
                      <p className="mt-1 whitespace-pre-wrap text-muted-foreground">
                        {request.memberMessage}
                      </p>
                    </div>
                  ) : null}

                  {/* The officer's MEMBER-FACING explanation, and only ever that.
                      The internal note has no field on this DTO. */}
                  {request.decisionExplanation ? (
                    <div className="rounded-md border border-border p-3">
                      <p className="font-medium">
                        What the Booking Officer said
                      </p>
                      <p className="mt-1 whitespace-pre-wrap text-muted-foreground">
                        {request.decisionExplanation}
                      </p>
                    </div>
                  ) : null}

                  {request.canReplace ? (
                    <p className="text-xs text-muted-foreground">
                      {MEMBER_EXCEPTION_REPLACE_NOTICE}
                    </p>
                  ) : null}
                </div>

                <div className="flex shrink-0 flex-col items-start gap-2 lg:items-end">
                  <Badge
                    variant="outline"
                    className={STATUS_BADGE_CLASS[request.status]}
                  >
                    {MEMBER_EXCEPTION_STATUS_LABELS[request.status]}
                  </Badge>

                  {request.createdBookingId ? (
                    <Button asChild size="sm" variant="outline">
                      <Link href={`/bookings/${request.createdBookingId}`}>
                        Open the booking
                      </Link>
                    </Button>
                  ) : null}
                  {request.source === "MODIFICATION" && request.bookingId ? (
                    <Button asChild size="sm" variant="outline">
                      <Link href={`/bookings/${request.bookingId}`}>
                        Open the booking
                      </Link>
                    </Button>
                  ) : null}

                  {request.canReplace ? (
                    <Button asChild size="sm" variant="outline">
                      <Link href={replaceRequestHref(request)}>
                        Replace with a corrected request
                      </Link>
                    </Button>
                  ) : null}

                  {request.canWithdraw ? (
                    isConfirming ? (
                      <div className="flex flex-col items-start gap-2 lg:items-end">
                        <p className="max-w-56 text-xs text-muted-foreground">
                          Withdraw this request? The officer stops looking at it and
                          nothing is booked or changed. You can ask again afterwards.
                        </p>
                        <div className="flex gap-2">
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={withdrawingId === request.id}
                            onClick={() => void handleWithdraw(request)}
                          >
                            {withdrawingId === request.id
                              ? "Withdrawing..."
                              : "Yes, withdraw it"}
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            disabled={withdrawingId === request.id}
                            onClick={() => setConfirmingId(null)}
                          >
                            Keep it
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setError(null);
                          setConfirmingId(request.id);
                        }}
                      >
                        Withdraw
                      </Button>
                    )
                  ) : null}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </section>
  );
}
