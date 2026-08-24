"use client";

import type { AgeTier } from "@prisma/client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { CheckCircle2, Info, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ClubIdentity } from "@/config/club-identity-types";
import { useAgeTierOptions } from "@/lib/use-age-tier-options";
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

interface RequestGuest {
  firstName: string;
  lastName: string;
  ageTier: AgeTier;
}

function emptyGuest(): RequestGuest {
  return { firstName: "", lastName: "", ageTier: "ADULT" };
}

export function GroupJoinPageClient({
  club,
  code,
}: {
  club: ClubIdentity;
  code: string;
}) {
  const ageTierOptions = useAgeTierOptions();

  const [summary, setSummary] = useState<GroupSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  const [contactFirstName, setContactFirstName] = useState("");
  const [contactLastName, setContactLastName] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [guests, setGuests] = useState<RequestGuest[]>([emptyGuest()]);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/group-bookings/${encodeURIComponent(code)}`)
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) {
          setNotFound(true);
          return;
        }
        setSummary(await res.json());
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

  function updateGuest(index: number, patch: Partial<RequestGuest>) {
    setGuests((prev) => prev.map((g, i) => (i === index ? { ...g, ...patch } : g)));
  }

  const validGuests = guests.filter((g) => g.firstName.trim() && g.lastName.trim());
  const canSubmit =
    contactFirstName.trim() &&
    contactLastName.trim() &&
    contactEmail.trim() &&
    validGuests.length > 0 &&
    !submitting;

  async function submit() {
    setSubmitting(true);
    setError("");
    try {
      const res = await fetch(
        `/api/group-bookings/${encodeURIComponent(code)}/join-request`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            contactFirstName: contactFirstName.trim(),
            contactLastName: contactLastName.trim(),
            contactEmail: contactEmail.trim(),
            contactPhone: contactPhone.trim() || null,
            guests: validGuests,
          }),
        }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Unable to submit your request right now.");
      }
      setSubmitted(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to submit your request right now.");
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div className="mx-auto flex min-h-[60vh] max-w-lg items-center justify-center p-4">
        <Card className="w-full">
          <CardContent className="py-8 text-center text-muted-foreground">Loading...</CardContent>
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
                <p className="font-medium">Almost there — check your email.</p>
              </div>
              <p className="text-sm text-muted-foreground">
                If the details you entered match an open spot, we&apos;ve emailed you a link to
                confirm and finish joining. The link is valid for 48 hours.
              </p>
            </div>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                Add yourself (and anyone coming with you) to {summary.organiserFirstName}&apos;s
                group. We&apos;ll email you a link to confirm.
                {summary.paymentMode === "ORGANISER_PAYS"
                  ? " If a payment is needed, you'll receive a secure link after confirming."
                  : " After you confirm, you'll get a secure link to pay for your beds."}
              </p>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="firstName">Your first name</Label>
                  <Input
                    id="firstName"
                    value={contactFirstName}
                    onChange={(e) => setContactFirstName(e.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="lastName">Your last name</Label>
                  <Input
                    id="lastName"
                    value={contactLastName}
                    onChange={(e) => setContactLastName(e.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="email">Email</Label>
                  <Input
                    id="email"
                    type="email"
                    value={contactEmail}
                    onChange={(e) => setContactEmail(e.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="phone">Phone (optional)</Label>
                  <Input
                    id="phone"
                    value={contactPhone}
                    onChange={(e) => setContactPhone(e.target.value)}
                  />
                </div>
              </div>

              <div className="space-y-3">
                <Label>Who is coming?</Label>
                {guests.map((guest, index) => (
                  <div key={index} className="flex items-end gap-2">
                    <div className="flex-1 space-y-1">
                      <Input
                        aria-label={`Guest ${index + 1} first name`}
                        placeholder="First name"
                        value={guest.firstName}
                        onChange={(e) => updateGuest(index, { firstName: e.target.value })}
                      />
                    </div>
                    <div className="flex-1 space-y-1">
                      <Input
                        aria-label={`Guest ${index + 1} last name`}
                        placeholder="Last name"
                        value={guest.lastName}
                        onChange={(e) => updateGuest(index, { lastName: e.target.value })}
                      />
                    </div>
                    <select
                      aria-label={`Guest ${index + 1} age`}
                      className="h-10 rounded-md border border-input bg-background px-2 text-sm"
                      value={guest.ageTier}
                      onChange={(e) => updateGuest(index, { ageTier: e.target.value as AgeTier })}
                    >
                      {ageTierOptions.map((opt) => (
                        <option key={opt.tier} value={opt.tier}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                    {guests.length > 1 ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={`Remove guest ${index + 1}`}
                        onClick={() => setGuests((prev) => prev.filter((_, i) => i !== index))}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    ) : null}
                  </div>
                ))}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setGuests((prev) => [...prev, emptyGuest()])}
                >
                  <Plus className="mr-1 h-4 w-4" /> Add another guest
                </Button>
              </div>

              {error ? (
                <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {error}
                </div>
              ) : null}

              <Button onClick={submit} disabled={!canSubmit} className="w-full">
                {submitting ? "Submitting..." : "Request to join"}
              </Button>

              <p className="text-center text-xs text-muted-foreground">
                Already a {club.name} member?{" "}
                <Link className="underline" href="/login">
                  Sign in
                </Link>{" "}
                to add yourself and your family from your account.
              </p>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
