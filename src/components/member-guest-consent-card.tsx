"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * The consent card — the member's own answer to "can I be added to this
 * booking?" ("+ Add Member Guest", epic #2305, MG2 #2307).
 *
 * Renders on `/bookings/[id]` immediately above the #2250 self-removal card,
 * under the `#consent` anchor the request email deep-links to. Owner decision
 * D-11 gives the pending member the whole booking page, so this card sits
 * inside the real page rather than replacing it.
 *
 * REFUSALS FOLLOW #2250 EXACTLY (owner decision D-14, mockup section 4).
 * `refusalWarning` is the server-composed warning for a refusal that is
 * PREDICTABLE before the click — when set, the "No thanks" button is not
 * rendered at all and the warning explains who can act instead. The
 * settled-payment refusal is NOT predictable, so both buttons stay on the page
 * and the server's 400 message is repeated word for word if it is refused.
 *
 * NO `router.refresh()` ON EITHER SUCCESS, deliberately, on the #2250 card's
 * reasoning. A successful DECLINE deletes the viewer's guest row, so
 * re-rendering the server component would redirect them to /bookings and
 * replace the confirmation they just earned with a list. A successful APPROVE
 * keeps their access, but a refresh would unmount this card mid-confirmation —
 * so both outcomes keep the confirmation on screen and say plainly that the
 * details above show the booking as it was.
 */
export function MemberGuestConsentCard({
  bookingId,
  guestId,
  bookerName,
  bookerFirstName,
  lodgeName,
  stayLabel,
  nightsLabel,
  nightsCountLabel,
  answerByLabel,
  lapseByLabel,
  party,
  quotePriced,
  refusalWarning,
}: {
  bookingId: string;
  /** The viewer's own `BookingGuest` row on this booking. */
  guestId: string;
  bookerName: string;
  bookerFirstName: string;
  lodgeName: string;
  /** "Sat 8 Aug – Mon 10 Aug 2026 (2 nights)" */
  stayLabel: string;
  /** "Sat 8 Aug, Sun 9 Aug" — the viewer's own nights. */
  nightsLabel: string;
  /** "two nights" / "one night" — the intro sentence's own-night count. */
  nightsCountLabel: string;
  /** "Fri 7 Aug 2026" — the facts-table deadline. */
  answerByLabel: string;
  /** "Fri 7 Aug" — the lapse sentence's short deadline. */
  lapseByLabel: string;
  party: { name: string; isViewer: boolean }[];
  /** Swaps the heading to the booking-request wording (mockup variant C). */
  quotePriced: boolean;
  /** Pre-composed predictable-refusal warning, or null when declining is offered. */
  refusalWarning: string | null;
}) {
  const [step, setStep] = useState<
    "idle" | "approving" | "declining" | "approved" | "declined" | "error"
  >("idle");
  const [errorMessage, setErrorMessage] = useState("");
  // The outcome renders away from the clicked button, so move focus to it for
  // keyboard and screen-reader users (same shape as the #2250 card).
  const outcomeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (step === "approved" || step === "declined" || step === "error") {
      outcomeRef.current?.focus();
    }
  }, [step]);

  const busy = step === "approving" || step === "declining";

  async function answer(action: "APPROVE" | "DECLINE") {
    setErrorMessage("");
    setStep(action === "APPROVE" ? "approving" : "declining");
    try {
      const res = await fetch(
        `/api/bookings/${bookingId}/guests/${guestId}/consent`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action }),
        },
      );
      const data = (await res.json().catch(() => ({}))) as {
        error?: unknown;
      };
      if (!res.ok) {
        // D-14: the server's refusal goes back to the member VERBATIM — this is
        // the unpredictable settled case #2250 already handles the same way.
        setErrorMessage(
          typeof data.error === "string"
            ? data.error
            : "We could not record your answer. Please try again.",
        );
        setStep("error");
        return;
      }
      setStep(action === "APPROVE" ? "approved" : "declined");
    } catch {
      setErrorMessage("We could not record your answer. Please try again.");
      setStep("error");
    }
  }

  if (step === "approved") {
    return (
      <Card className="border-success-6 bg-success-3">
        <CardHeader>
          <CardTitle headingLevel={2} className="text-success-11">
            You&apos;re on this booking
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-success-11">
          <div
            ref={outcomeRef}
            tabIndex={-1}
            role="status"
            className="space-y-3 outline-none"
          >
            <p>
              Thanks — your place is confirmed, and {bookerFirstName} will be
              emailed. You do not need to do anything else.
            </p>
            <p>
              The details above may still show this request as waiting until the
              page is next loaded.
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (step === "declined") {
    return (
      <Card className="border-success-6 bg-success-3">
        <CardHeader>
          <CardTitle headingLevel={2} className="text-success-11">You&apos;ve said no</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-success-11">
          <div
            ref={outcomeRef}
            tabIndex={-1}
            role="status"
            className="space-y-3 outline-none"
          >
            <p>
              The bed that was held for you has been released, and{" "}
              {bookerFirstName} will be emailed. You do not need to do anything
              else.
            </p>
            <p>
              The booking details above still show the party as it was before
              your answer — open your bookings to see the change.
            </p>
          </div>
          <Button asChild variant="outline" size="sm">
            <Link href="/bookings">Back to my bookings</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-primary">
      <CardHeader className="space-y-2">
        <div>
          <Badge
            variant="outline"
            className="border-warning-6 bg-warning-3 text-warning-11"
          >
            Waiting for your answer
          </Badge>
        </div>
        <CardTitle headingLevel={2}>
          {quotePriced
            ? `${bookerName} has added you to a booking request`
            : `${bookerName} has added you to this booking`}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {refusalWarning ? (
          <p className="rounded-md border border-warning-6 bg-warning-3 px-3 py-2 text-warning-11">
            {refusalWarning}
          </p>
        ) : null}
        {step === "error" ? (
          <div
            ref={outcomeRef}
            tabIndex={-1}
            role="alert"
            className="rounded-md border border-danger-6 bg-danger-3 px-3 py-2 text-danger-11 outline-none"
          >
            {errorMessage}
          </div>
        ) : null}

        <p className="text-muted-foreground">
          You have been put down for {nightsCountLabel} at{" "}
          <span className="font-medium text-foreground">{lodgeName}</span>.
          Nothing is settled until you answer. A bed is being held for you in
          the meantime.
        </p>

        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
          <dt className="text-muted-foreground">Booked by</dt>
          <dd className="font-medium">{bookerName}</dd>
          <dt className="text-muted-foreground">Lodge</dt>
          <dd className="font-medium">{lodgeName}</dd>
          <dt className="text-muted-foreground">Stay</dt>
          <dd className="font-medium">{stayLabel}</dd>
          <dt className="text-muted-foreground">Your nights</dt>
          <dd className="font-medium">{nightsLabel}</dd>
          <dt className="text-muted-foreground">Answer by</dt>
          <dd className="font-medium">{answerByLabel}</dd>
        </dl>

        <div>
          <p className="mb-1 text-muted-foreground">Everyone on the booking:</p>
          <ul className="space-y-0.5">
            {party.map((member, index) => (
              <li key={index}>
                <span className="text-muted-foreground">·</span> {member.name}
                {member.isViewer ? " — that's you" : ""}
              </li>
            ))}
          </ul>
        </div>

        {/*
          The release is stated as the USUAL case, not as a promise. Letting a
          request lapse runs the same removal path a decline does, so the same
          blockers apply — the only guest on the booking, a hand-priced booking,
          a status that forbids guest changes — and those rows go to the club's
          exception list still holding their bed. Saying "the held bed is
          released" flatly would promise the member something the server
          sometimes cannot deliver.
        */}
        <p className="text-muted-foreground">
          If you do not answer by{" "}
          <span className="font-medium text-foreground">{lapseByLabel}</span>{" "}
          the request lapses on its own and {bookerFirstName} is told. You do not
          have to do anything to decline. In most cases the held bed is released
          at the same time; occasionally it cannot be — when there would be
          nobody left on the booking, for example — and the club sorts that out
          by hand.
        </p>

        {refusalWarning ? (
          <p className="text-muted-foreground">You can still say yes.</p>
        ) : null}

        <div className="flex flex-wrap items-center gap-3">
          <Button disabled={busy} onClick={() => void answer("APPROVE")}>
            {step === "approving" ? "Adding you..." : "Yes, add me"}
          </Button>
          {refusalWarning ? null : (
            <Button
              variant="outline"
              className="border-danger-6 text-danger-11 hover:bg-danger-3"
              disabled={busy}
              onClick={() => void answer("DECLINE")}
            >
              {step === "declining" ? "Recording your answer..." : "No thanks"}
            </Button>
          )}
        </div>
        <p aria-live="polite" className="sr-only">
          {step === "approving"
            ? "Adding you to this booking..."
            : step === "declining"
              ? "Recording your answer..."
              : ""}
        </p>
      </CardContent>
    </Card>
  );
}
