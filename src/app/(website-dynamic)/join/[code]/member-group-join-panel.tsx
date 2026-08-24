"use client";

import type { AgeTier } from "@prisma/client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, CreditCard, Info, Landmark } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  getFamilyMemberBookingActionLabel,
  getFamilyMemberBookingBlockMessage,
  type BookingFamilyMember,
} from "@/lib/family-booking";
import { buildInternetBankingPaymentReference } from "@/lib/booking-payment-methods";
import {
  renderClientBookingMessage,
  type BookingMessageClubTokens,
} from "@/lib/booking-message-definitions";
import {
  calendarDateOfDateOnlyInstant,
  formatClubDate,
  parseInstant,
} from "@/lib/club-time";

/**
 * One stay night, or the join deadline, rendered as the CALENDAR DAY it is
 * (CT-4 group E, #2870; epic #2988; INV-CONFIG-002).
 *
 * ALL THREE VALUES THIS PAGE FORMATS ARE `@db.Date` COLUMNS — `GroupBooking`'s
 * `checkIn`, `checkOut` and `joinDeadline` — serialised by
 * `/api/group-bookings/[code]` with `.toISOString()`. A calendar day has no
 * timezone: 16 April 2026 is a Thursday everywhere on earth. So this page needs
 * NO club zone at all, and does not mount `useClubTime()`; the kernel decodes
 * the UTC-midnight encoding back to the day it encodes and formats it pinned to
 * `UTC`, which is provably the identity for every club.
 *
 * What it replaced was `formatNZDate(new Date(value))`, which projected the
 * encoding through `APP_TIME_ZONE`. That cancels only because New Zealand is
 * east of Greenwich; for a club west of it this page — which a guest reaches
 * from a link the organiser texted them — named the night BEFORE the stay.
 *
 * `parseInstant` rather than a bare `new Date`, and the raw value rather than a
 * throw, because nothing validates this payload on the way in and this is a
 * public landing page: an unhandled throw in a client render
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

type PaymentMethod = "stripe" | "internet_banking";

interface GroupSummary {
  code: string;
  status: string;
  paymentMode: "EACH_PAYS_OWN" | "ORGANISER_PAYS";
  organiserFirstName: string;
  lodgeName: string;
  checkIn: string;
  checkOut: string;
  joinDeadline: string | null;
  isJoinable: boolean;
}

interface FamilyMember extends BookingFamilyMember {
  id: string;
  firstName: string;
  lastName: string;
  ageTier: AgeTier;
}

/**
 * Logged-in member self-add for a group booking. Mirrors the family quick-add on
 * the book page: the member picks themselves and any bookable family members and
 * POSTs to the authenticated /join endpoint. Non-member friends still use the
 * public request form (GroupJoinPageClient); this panel only adds members.
 *
 * It reads no client session context (neither public layout has a SessionProvider)
 * — the server component renders it only for a logged-in visitor, and the join +
 * family fetches ride the session cookie.
 */
export function MemberGroupJoinPanel({
  code,
}: {
  code: string;
}) {
  const router = useRouter();

  const [summary, setSummary] = useState<GroupSummary | null>(null);
  const [familyMembers, setFamilyMembers] = useState<FamilyMember[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState("");
  const [internetBankingEnabled, setInternetBankingEnabled] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("stripe");
  const [ibReference, setIbReference] = useState<string | null>(null);
  const [bookingMessages, setBookingMessages] = useState<Record<string, string>>({});
  // #2919 review: what this panel's message tokens resolve to. Without them an
  // operator's {{CLUB_LODGE_NAME}} reached the joiner as literal braces.
  const [messageTokens, setMessageTokens] =
    useState<BookingMessageClubTokens | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch(`/api/group-bookings/${encodeURIComponent(code)}`).then(async (res) =>
        res.ok ? ((await res.json()) as GroupSummary) : null
      ),
      fetch("/api/members/family")
        .then((res) => (res.ok ? res.json() : { familyMembers: [] }))
        .then((data) => (data.familyMembers || []) as FamilyMember[])
        .catch(() => [] as FamilyMember[]),
    ])
      .then(([summaryData, family]) => {
        if (cancelled) return;
        if (!summaryData) {
          setNotFound(true);
          return;
        }
        setSummary(summaryData);
        setFamilyMembers(family);
        // Pre-select the member themselves (the common self-add case).
        const self = family.find((fm) => fm.relationship === "self");
        if (self && self.canBeBooked !== false) {
          setSelectedIds(new Set([self.id]));
        }
      })
      .catch(() => {
        if (!cancelled) setNotFound(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [code]);

  // Internet Banking is an optional module; only offer it when it's on.
  useEffect(() => {
    const params = new URLSearchParams();
    if (summary?.checkIn) {
      params.set("checkIn", summary.checkIn.slice(0, 10));
    }
    const query = params.toString();
    fetch(`/api/payments/options${query ? `?${query}` : ""}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) =>
        setInternetBankingEnabled(
          Boolean(data?.methods?.internetBanking?.enabled)
        )
      )
      .catch(() => setInternetBankingEnabled(false));
  }, [summary?.checkIn]);

  useEffect(() => {
    fetch("/api/booking-messages")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        setBookingMessages(data?.messages ?? {});
        setMessageTokens(data?.tokens ?? null);
      })
      .catch(() => {
        setBookingMessages({});
        setMessageTokens(null);
      });
  }, []);

  function toggle(id: string) {
    setError("");
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  const selectedMembers = familyMembers.filter((fm) => selectedIds.has(fm.id));
  const canSubmit = selectedMembers.length > 0 && !submitting;
  // The payment-method choice only applies when the joiner pays for their own
  // beds (EACH_PAYS_OWN) and the Internet Banking module is on.
  const showPaymentMethodChoice =
    summary?.paymentMode === "EACH_PAYS_OWN" && internetBankingEnabled;

  async function submit() {
    setSubmitting(true);
    setError("");
    const usingInternetBanking =
      showPaymentMethodChoice && paymentMethod === "internet_banking";
    try {
      const res = await fetch(
        `/api/group-bookings/${encodeURIComponent(code)}/join`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            guests: selectedMembers.map((fm) => ({
              firstName: fm.firstName,
              lastName: fm.lastName,
              ageTier: fm.ageTier,
              isMember: true,
              memberId: fm.id,
            })),
            paymentMethod: usingInternetBanking ? "internet_banking" : "stripe",
          }),
        }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Unable to join right now.");
      }
      // Internet Banking: the Xero invoice is emailed; confirm in place with the
      // payment reference instead of opening the card flow.
      if (usingInternetBanking && data.bookingId) {
        setIbReference(buildInternetBankingPaymentReference(data.bookingId));
        setSubmitted(true);
        return;
      }
      // EACH_PAYS_OWN card joiners owe for their beds — send them to the booking
      // to pay. ORGANISER_PAYS (and $0) joins are done, so confirm in place.
      if (data.requiresPayment && data.bookingId) {
        router.push(`/bookings/${data.bookingId}`);
        return;
      }
      setSubmitted(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to join right now.");
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div className="mx-auto flex min-h-[60vh] max-w-lg items-center justify-center p-4">
        <Card className="w-full">
          <CardContent className="py-8 text-center text-muted-foreground">
            Loading...
          </CardContent>
        </Card>
      </div>
    );
  }

  if (notFound || !summary) {
    return (
      <div className="mx-auto flex min-h-[60vh] max-w-lg items-center justify-center p-4">
        <Card className="w-full">
          <CardHeader>
            <CardTitle>Group booking not found</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            We couldn&apos;t find a group booking for this link. Please check you copied the whole
            link from the organiser, or ask them to share it again.
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-lg p-4">
      <Card>
        <CardHeader>
          <CardTitle>
            Join {summary.organiserFirstName}&apos;s group at {summary.lodgeName}
          </CardTitle>
          <CardDescription>
            {formatStayDay(summary.checkIn)} to {formatStayDay(summary.checkOut)}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {!summary.isJoinable ? (
            <div className="flex items-start gap-2 rounded-md border border-warning-6 bg-warning-3 px-3 py-2 text-sm text-warning-11">
              <Info className="h-5 w-5 shrink-0" />
              <p>
                This group is no longer accepting new joiners
                {summary.joinDeadline
                  ? ` (the deadline was ${formatStayDay(summary.joinDeadline)})`
                  : ""}
                . Please contact the organiser if you think this is a mistake.
              </p>
            </div>
          ) : submitted ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-success-11">
                <CheckCircle2 className="h-6 w-6 shrink-0" />
                <p className="font-medium">You&apos;re in!</p>
              </div>
              {ibReference ? (
                <>
                  <p className="text-sm text-muted-foreground">
                    {/* #2919 review: every token this body may carry, with the
                        group's OWN lodge standing in for CLUB_LODGE_NAME. */}
                    {renderClientBookingMessage({
                      template:
                        bookingMessages["paymentLink.internetBanking.description"],
                      fallback:
                        "Use reference {{paymentReference}} when making a direct transfer. The booking will be confirmed after the Xero invoice payment is reconciled.",
                      clubTokens: messageTokens,
                      lodgeName: summary.lodgeName,
                      data: { paymentReference: ibReference },
                    })}
                  </p>
                  <div className="rounded-md border border-border p-3 text-sm">
                    <p className="font-medium text-foreground">Payment reference</p>
                    <p className="mt-1 font-mono text-foreground">{ibReference}</p>
                  </div>
                </>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {summary.paymentMode === "ORGANISER_PAYS"
                    ? `${summary.organiserFirstName} is settling the beds for this group, so there's nothing more to pay. We've added you to the group.`
                    : "You've been added to the group."}
                </p>
              )}
              <Button variant="outline" onClick={() => router.push("/bookings")}>
                View my bookings
              </Button>
            </div>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                Add yourself and your family to {summary.organiserFirstName}&apos;s group.
                {summary.paymentMode === "ORGANISER_PAYS"
                  ? ` ${summary.organiserFirstName} is paying for the group, so you won't be charged.`
                  : " You'll be taken to pay for your beds after joining."}
              </p>

              <div className="space-y-2">
                <p className="text-sm font-medium text-muted-foreground">Who is coming?</p>
                <div className="grid gap-2">
                  {familyMembers.map((fm) => {
                    const selected = selectedIds.has(fm.id);
                    const blocked = fm.canBeBooked === false;
                    const label =
                      fm.relationship === "self"
                        ? `${fm.firstName} ${fm.lastName} (You)`
                        : `${fm.firstName} ${fm.lastName} (${fm.ageTier})`;
                    const blockMessage = getFamilyMemberBookingBlockMessage(fm);
                    const actionLabel = getFamilyMemberBookingActionLabel(fm);
                    return (
                      <div
                        key={fm.id}
                        className={blocked ? "rounded-md border border-warning-6 bg-warning-3 p-3" : ""}
                      >
                        <Button
                          type="button"
                          variant={selected ? "default" : "outline"}
                          size="sm"
                          disabled={blocked}
                          onClick={() => toggle(fm.id)}
                          className="w-full justify-start"
                        >
                          {selected ? "✓ " : "+ "}
                          {label}
                        </Button>
                        {blocked && blockMessage && (
                          <p className="mt-2 text-sm text-warning-11">{blockMessage}</p>
                        )}
                        {blocked && actionLabel && (
                          <p className="mt-1 text-xs font-medium text-warning-11">{actionLabel}</p>
                        )}
                      </div>
                    );
                  })}
                </div>
                <p className="text-xs text-muted-foreground">
                  Bringing a non-member friend? They can join with the same link without signing in.
                </p>
              </div>

              {showPaymentMethodChoice ? (
                <div className="space-y-2">
                  <p className="text-sm font-medium text-muted-foreground">How would you like to pay?</p>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <button
                      type="button"
                      onClick={() => setPaymentMethod("stripe")}
                      className={`flex min-h-16 items-start gap-3 rounded-md border p-3 text-left text-sm ${
                        paymentMethod === "stripe"
                          ? "border-info-7 bg-info-3 text-info-11"
                          : "border-border bg-card text-muted-foreground hover:border-border"
                      }`}
                    >
                      <CreditCard className="mt-0.5 h-4 w-4 shrink-0" />
                      <span>
                        <span className="block font-medium">Card</span>
                        <span className="block text-xs opacity-80">
                          {/* #2919 review: a template like every other body here
                              — render it, do not print it. */}
                          {renderClientBookingMessage({
                            template:
                              bookingMessages["booking.payment.card.description"],
                            fallback: "Pay now and secure the booking immediately.",
                            clubTokens: messageTokens,
                            lodgeName: summary.lodgeName,
                          })}
                        </span>
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setPaymentMethod("internet_banking")}
                      className={`flex min-h-16 items-start gap-3 rounded-md border p-3 text-left text-sm ${
                        paymentMethod === "internet_banking"
                          ? "border-info-7 bg-info-3 text-info-11"
                          : "border-border bg-card text-muted-foreground hover:border-border"
                      }`}
                    >
                      <Landmark className="mt-0.5 h-4 w-4 shrink-0" />
                      <span>
                        <span className="block font-medium">Internet Banking</span>
                        <span className="block text-xs opacity-80">
                          {renderClientBookingMessage({
                            template:
                              bookingMessages[
                                "booking.payment.internetBanking.description"
                              ],
                            fallback: "Receive a Xero invoice by email.",
                            clubTokens: messageTokens,
                            lodgeName: summary.lodgeName,
                          })}
                        </span>
                      </span>
                    </button>
                  </div>
                </div>
              ) : null}

              {error ? (
                <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {error}
                </div>
              ) : null}

              <Button onClick={submit} disabled={!canSubmit} className="w-full">
                {submitting
                  ? "Joining..."
                  : summary.paymentMode === "ORGANISER_PAYS"
                    ? "Join group"
                    : showPaymentMethodChoice && paymentMethod === "internet_banking"
                      ? "Join (invoice by email)"
                      : "Join and pay"}
              </Button>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
