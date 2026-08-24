"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, AlertTriangle, Clock } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  calendarDateOfDateOnlyInstant,
  formatClubDate,
  parseInstant,
} from "@/lib/club-time";

/**
 * One night of the stay, rendered as the CALENDAR DAY it is (CT-4, #2870).
 *
 * `checkIn`/`checkOut` arrive over `fetch` as serialised `@db.Date` lodge
 * nights, which are calendar days and take no timezone at all: the kernel
 * decodes the UTC-midnight encoding back to the day it encodes and formats it
 * pinned to `UTC`, so the projection is provably the identity for every club.
 * The old `formatNZDate(new Date(value))` projected it through `APP_TIME_ZONE`,
 * which cancels only because New Zealand is east of Greenwich; a club west of it
 * showed the night BEFORE the stay on a page a member reaches from an email.
 *
 * `parseInstant` rather than a bare `new Date`, and the raw value rather than a
 * throw, because nothing validates this payload on the way in and this is a
 * public token landing page: an unhandled throw in a client render replaces the
 * whole screen with an error boundary. THE PREVIOUS CODE THREW TOO —
 * `Intl.DateTimeFormat.format` on an invalid `Date` is a `RangeError`, not the
 * string "Invalid Date", which only `toLocaleDateString` produces — so this
 * fallback is a FIX rather than a preserved behaviour.
 */
function formatStayDay(value: string): string {
  // NOT-A-STRING FIRST, and this order is the whole point: `parseInstant` calls
  // `value.trim()` BEFORE its own nullish check, so `parseInstant(null)` throws a
  // `TypeError` out of the guard that exists to stop a throw. The premise above
  // is that nothing validates this payload on the way in, and a missing field is
  // exactly what an unvalidated payload produces — so the guard has to cover it.
  if (typeof value !== "string") return "";
  const instant = parseInstant(value);
  if (instant === null) return value;
  try {
    return formatClubDate(calendarDateOfDateOnlyInstant(instant));
  } catch {
    return value;
  }
}

type VerifyOutcome = "verified" | "already_verified" | "expired" | "invalid" | "loading" | "error";

interface VerifyResult {
  outcome: VerifyOutcome;
  checkIn?: string;
  checkOut?: string;
  guestCount?: number;
  // Present only when the request names a lodge and the club has two or
  // more active lodges (ADR-002 presentation rule).
  lodgeName?: string;
}

export function BookingRequestVerifyClient({
  token,
  clubLodgeName,
}: {
  token: string;
  clubLodgeName: string;
}) {
  const [result, setResult] = useState<VerifyResult>({ outcome: "loading" });

  useEffect(() => {
    let cancelled = false;

    fetch(`/api/booking-requests/verify/${encodeURIComponent(token)}`)
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (res.status === 404) {
          setResult({ outcome: "invalid" });
        } else if (res.status === 410) {
          setResult({ outcome: "expired" });
        } else if (res.ok) {
          setResult(data);
        } else {
          setResult({ outcome: "error" });
        }
      })
      .catch(() => {
        if (!cancelled) setResult({ outcome: "error" });
      });

    return () => {
      cancelled = true;
    };
  }, [token]);

  return (
    <Card className="w-full max-w-lg">
      <CardHeader>
        <CardTitle>Booking Request Confirmation</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {result.outcome === "loading" ? (
          <p className="text-sm text-muted-foreground">Confirming your email address...</p>
        ) : result.outcome === "verified" || result.outcome === "already_verified" ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-success-11">
              <CheckCircle2 className="h-6 w-6 shrink-0" />
              <p className="font-medium">Your email address is confirmed.</p>
            </div>
            <p className="text-sm text-muted-foreground">
              Thanks for your booking request with {result.lodgeName ?? clubLodgeName}. It has
              been added to our review queue and an officer will be in touch with pricing and a
              payment link.
            </p>
            {result.checkIn && result.checkOut ? (
              <div className="rounded-md border bg-muted p-3 text-sm text-muted-foreground">
                {result.lodgeName ? <p className="mb-1">Lodge: {result.lodgeName}</p> : null}
                <p>
                  Dates: {formatStayDay(result.checkIn)} to{" "}
                  {formatStayDay(result.checkOut)}
                </p>
                {typeof result.guestCount === "number" ? (
                  <p className="mt-1">Guests: {result.guestCount}</p>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : result.outcome === "expired" ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-warning-11">
              <Clock className="h-6 w-6 shrink-0" />
              <p className="font-medium">This confirmation link has expired.</p>
            </div>
            <p className="text-sm text-muted-foreground">
              Confirmation links are valid for 48 hours. Please submit a new booking request and
              confirm it from the email we send you.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-warning-11">
              <AlertTriangle className="h-6 w-6 shrink-0" />
              <p className="font-medium">This confirmation link is not valid.</p>
            </div>
            <p className="text-sm text-muted-foreground">
              If you submitted a booking request, please check your email for the most recent
              confirmation link, or contact the club for help.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
