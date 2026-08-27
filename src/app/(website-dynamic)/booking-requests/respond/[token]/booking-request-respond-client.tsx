"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, HelpCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useConfirm } from "@/components/confirm-dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useClubTime } from "@/components/club-time-provider";
import {
  calendarDateOfDateOnlyInstant,
  formatClubDate,
  parseInstant,
  type BoundClubTime,
} from "@/lib/club-time";
import { formatCents } from "@/lib/utils";

interface QuoteOption {
  id: string;
  label: string;
  cateringOption: "CATERED" | "NON_CATERED" | null;
  totalCents: number;
  guestBreakdown: Array<{
    guestIndex: number;
    firstName: string;
    lastName: string;
    ageTier: string;
    isMember: boolean;
    nightCount: number;
    rateCents: number | null;
    totalCents: number;
  }>;
}

interface QuoteContext {
  requestId: string;
  quoteId: string;
  version: number;
  type: "GENERAL" | "SCHOOL";
  schoolName: string | null;
  // Non-null only when the request names a lodge and the club has two or
  // more active lodges (ADR-002 presentation rule).
  lodgeName: string | null;
  contactFirstName: string;
  checkIn: string;
  checkOut: string;
  guestCount: number;
  message: string | null;
  expiresAt: string;
  options: QuoteOption[];
}

type LoadState = "loading" | "ready" | "invalid" | "expired" | "error";
type Action = "ACCEPT" | "CANCEL" | "MODIFY" | "QUERY";

/**
 * One end of the requested stay, rendered as the CALENDAR DAY it is (CT-4,
 * #2870; epic #2988).
 *
 * `BookingRequest.checkIn`/`checkOut` are `@db.Date` lodge nights, serialised by
 * `getBookingRequestQuoteContext`. A calendar day has no timezone, so this
 * consults none: the kernel decodes the UTC-midnight encoding and pins `UTC`
 * over it, provably the identity for every club. The legacy helper projected the
 * encoding through `APP_TIME_ZONE`, which cancels only east of Greenwich — west
 * of it this quote named the night before the one being priced.
 *
 * `parseInstant` and the raw value rather than a throw: a public token landing
 * page whose payload nothing validates on the way in, where an unhandled throw in a client render
 * replaces the whole screen with an error boundary. THE PREVIOUS CODE THREW
 * TOO — `Intl.DateTimeFormat.format` on an invalid `Date` is a `RangeError`,
 * not the string "Invalid Date", which only `toLocaleDateString` produces — so
 * this fallback is a FIX rather than a preserved behaviour.
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

/**
 * When the quote stops being valid, spelled in the CLUB's zone (CT-4, #2870;
 * INV-CONFIG-002).
 *
 * FAIL-SOFT FOR THE SAME REASON `formatStayDay` IS, which is the half that was
 * missing: it sits nine lines below one whose docblock justifies its own
 * try/catch by "a public token landing page whose payload nothing validates on
 * the way in", and then handed `new Date(...)` straight to a formatter.
 * `Intl.DateTimeFormat.format` on an invalid `Date` is a `RangeError`, and an
 * unhandled throw in a client render replaces the whole screen with an error
 * boundary — over a line that only says when the quote lapses.
 */
function formatQuoteExpiry(value: string, club: BoundClubTime): string {
  if (typeof value !== "string") return "";
  const instant = parseInstant(value);
  if (instant === null) return value;
  try {
    return club.instantDateTime(instant);
  } catch {
    return value;
  }
}

export function BookingRequestRespondClient({ token }: { token: string }) {
  /*
    The quote's `expiresAt` is a real INSTANT, so it has no civil date and time
    until a zone is chosen — the club's PERSISTED one, delivered to this browser
    as data by `ClubTimeProvider` (CT-4, #2870; INV-CONFIG-002). It used to be
    `APP_TIME_ZONE`, the container's `TZ`. The countdown beside it is a DURATION
    and is deliberately left alone: elapsed milliseconds are the same number in
    every zone.
  */
  const clubTime = useClubTime();
  const [state, setState] = useState<LoadState>("loading");
  const [context, setContext] = useState<QuoteContext | null>(null);
  // Sampled when the quote context arrives so the expiry label below can be
  // derived without calling Date.now() mid-render.
  const [contextLoadedAt, setContextLoadedAt] = useState<number | null>(null);
  const [selectedOptionId, setSelectedOptionId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [actioning, setActioning] = useState<Action | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    fetch(`/api/booking-requests/respond/${encodeURIComponent(token)}`)
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (res.status === 410) {
          setState("expired");
        } else if (res.status === 404) {
          setState("invalid");
        } else if (res.ok) {
          setContext(data);
          setContextLoadedAt(Date.now());
          setSelectedOptionId(data.options?.[0]?.id ?? null);
          setState("ready");
        } else {
          setError(data.error || "Unable to load this quote.");
          setState("error");
        }
      })
      .catch(() => {
        if (!cancelled) setState("error");
      });

    return () => {
      cancelled = true;
    };
  }, [token]);

  const selectedOption = useMemo(
    () => context?.options.find((option) => option.id === selectedOptionId) ?? null,
    [context, selectedOptionId],
  );

  const expiresInLabel = useMemo(() => {
    if (!context || contextLoadedAt === null) return null;
    const remainingMs = new Date(context.expiresAt).getTime() - contextLoadedAt;
    if (remainingMs <= 0) return "expired";
    const days = Math.ceil(remainingMs / (24 * 60 * 60 * 1000));
    return days <= 1 ? "expires today" : `expires in ${days} days`;
  }, [context, contextLoadedAt]);

  const { confirm, confirmDialog } = useConfirm();

  async function cancelWithConfirmation() {
    // Cancel Request is destructive and fires from a token link with no undo, so
    // gate it behind an explicit confirmation (#1371 F28 — previously one click).
    const confirmed = await confirm({
      title: "Cancel this booking request?",
      description:
        "This withdraws your quote and tells the booking team you no longer want this booking. You cannot undo this from this link.",
      confirmLabel: "Cancel request",
      cancelLabel: "Keep request",
      destructive: true,
    });
    if (confirmed) {
      void respond("CANCEL");
    }
  }

  async function respond(action: Action) {
    setActioning(action);
    setError(null);
    setResult(null);
    try {
      const res = await fetch(`/api/booking-requests/respond/${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          optionId: selectedOptionId,
          message: message.trim() || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Unable to send your response.");
      }
      if (data.outcome === "accepted") {
        setResult("Quote accepted. We have sent the next steps by email.");
      } else if (data.outcome === "cancelled") {
        setResult("Quote cancelled. We have let the booking team know.");
      } else if (data.outcome === "modification_requested") {
        setResult("Change request sent. The booking team will review it and send a new quote.");
      } else {
        setResult("Question sent. The booking team will reply or send an updated quote.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to send your response.");
    } finally {
      setActioning(null);
    }
  }

  return (
    <Card className="w-full max-w-2xl">
      <CardHeader>
        <CardTitle>Booking Quote</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        {state === "loading" ? (
          <p className="text-sm text-muted-foreground">Loading quote...</p>
        ) : state === "invalid" ? (
          <div className="flex gap-3 text-warning-11">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
            <div className="space-y-1">
              <p className="font-medium">This quote link is not valid.</p>
              <p className="text-sm text-muted-foreground">
                Please check the most recent quote email or contact the club.
              </p>
            </div>
          </div>
        ) : state === "expired" ? (
          <div className="flex gap-3 text-warning-11">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
            <div className="space-y-1">
              <p className="font-medium">This quote has expired.</p>
              <p className="text-sm text-muted-foreground">
                Quotes are only valid for a limited time. Please contact the club
                to ask for an updated quote, and we will send you a fresh link.
              </p>
            </div>
          </div>
        ) : state === "error" || !context ? (
          <div className="flex gap-3 text-warning-11">
            <HelpCircle className="mt-0.5 h-5 w-5 shrink-0" />
            <p>{error || "Unable to load this quote right now."}</p>
          </div>
        ) : result ? (
          <div className="flex gap-3 text-success-11">
            <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0" />
            <p className="font-medium">{result}</p>
          </div>
        ) : (
          <>
            <div className="grid gap-3 rounded-md border bg-muted p-3 text-sm sm:grid-cols-2">
              {context.type === "SCHOOL" && context.schoolName ? (
                <p>
                  <span className="text-muted-foreground">School:</span>{" "}
                  {context.schoolName}
                </p>
              ) : null}
              {context.lodgeName ? (
                <p>
                  <span className="text-muted-foreground">Lodge:</span>{" "}
                  {context.lodgeName}
                </p>
              ) : null}
              <p>
                <span className="text-muted-foreground">Dates:</span>{" "}
                {formatStayDay(context.checkIn)} to{" "}
                {formatStayDay(context.checkOut)}
              </p>
              <p>
                <span className="text-muted-foreground">Guests:</span>{" "}
                {context.guestCount}
              </p>
              <p>
                <span className="text-muted-foreground">Expires:</span>{" "}
                {formatQuoteExpiry(context.expiresAt, clubTime)}
                {expiresInLabel ? (
                  <span className="text-muted-foreground"> ({expiresInLabel})</span>
                ) : null}
              </p>
            </div>

            {context.message ? (
              <div className="rounded-md border bg-card p-3 text-sm text-muted-foreground">
                {context.message}
              </div>
            ) : null}

            <div className="space-y-3">
              <p className="text-sm font-medium">Options</p>
              {context.options.map((option) => (
                <label
                  key={option.id}
                  className={`block cursor-pointer rounded-md border p-3 ${
                    selectedOptionId === option.id
                      ? "border-primary bg-primary/5"
                      : "border-border"
                  }`}
                >
                  <div className="flex items-start gap-3">
                    <input
                      type="radio"
                      name="quote-option"
                      value={option.id}
                      checked={selectedOptionId === option.id}
                      onChange={() => setSelectedOptionId(option.id)}
                      className="mt-1"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="font-medium">{option.label}</p>
                        <Badge variant="secondary">{formatCents(option.totalCents)}</Badge>
                      </div>
                      <div className="mt-2 flex flex-wrap gap-1">
                        {option.guestBreakdown.map((guest) => (
                          <Badge key={guest.guestIndex} variant="outline">
                            {guest.firstName} {guest.lastName}:{" "}
                            {formatCents(guest.totalCents)}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  </div>
                </label>
              ))}
            </div>

            <div className="space-y-2">
              <Label htmlFor="quote-message">Message</Label>
              <Textarea
                id="quote-message"
                maxLength={2000}
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                placeholder="Add a note if you are asking a question or requesting a change"
              />
            </div>

            {error ? (
              <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </div>
            ) : null}

            <div className="flex flex-wrap gap-2">
              <Button
                onClick={() => respond("ACCEPT")}
                disabled={!selectedOption || Boolean(actioning)}
              >
                Accept Quote
              </Button>
              <Button
                variant="outline"
                onClick={() => respond("QUERY")}
                disabled={Boolean(actioning)}
              >
                Send Question
              </Button>
              <Button
                variant="outline"
                onClick={() => respond("MODIFY")}
                disabled={Boolean(actioning)}
              >
                Request Changes
              </Button>
              <Button
                variant="destructive"
                onClick={() => void cancelWithConfirmation()}
                disabled={Boolean(actioning)}
              >
                Cancel Request
              </Button>
            </div>
          </>
        )}
      </CardContent>
      {confirmDialog}
    </Card>
  );
}
