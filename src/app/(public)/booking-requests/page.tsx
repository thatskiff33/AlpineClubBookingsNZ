"use client";

import type { AgeTier } from "@prisma/client";
import { useCallback, useEffect, useState } from "react";
import { CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useClubIdentity } from "@/components/club-identity-provider";
import { useAgeTierOptions } from "@/lib/use-age-tier-options";
import { formatCents } from "@/lib/utils";

interface RequestGuest {
  firstName: string;
  lastName: string;
  ageTier: AgeTier;
}

function emptyGuest(): RequestGuest {
  return { firstName: "", lastName: "", ageTier: "ADULT" };
}

function todayDateOnly(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function BookingRequestPage() {
  const club = useClubIdentity();
  const ageTierOptions = useAgeTierOptions();
  const [contactFirstName, setContactFirstName] = useState("");
  const [contactLastName, setContactLastName] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [message, setMessage] = useState("");
  const [checkIn, setCheckIn] = useState("");
  const [checkOut, setCheckOut] = useState("");
  const [guests, setGuests] = useState<RequestGuest[]>([emptyGuest()]);
  const [showPricing, setShowPricing] = useState<boolean | null>(null);
  const [indicativePriceCents, setIndicativePriceCents] = useState<number | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/booking-requests/settings")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => setShowPricing(Boolean(data?.showPricingToNonMembers)))
      .catch(() => setShowPricing(false));
  }, []);

  const validGuests = guests.filter((g) => g.firstName.trim() && g.lastName.trim());
  const datesValid = Boolean(checkIn && checkOut && checkOut > checkIn);

  const fetchQuote = useCallback(async () => {
    if (!showPricing || !datesValid || validGuests.length === 0) {
      setIndicativePriceCents(null);
      return;
    }
    setQuoteLoading(true);
    try {
      const res = await fetch("/api/booking-requests/quote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ checkIn, checkOut, guests: validGuests }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setIndicativePriceCents(data.indicativePriceCents ?? null);
      } else {
        setIndicativePriceCents(null);
      }
    } catch {
      setIndicativePriceCents(null);
    } finally {
      setQuoteLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showPricing, checkIn, checkOut, JSON.stringify(validGuests)]);

  useEffect(() => {
    const timer = setTimeout(fetchQuote, 400);
    return () => clearTimeout(timer);
  }, [fetchQuote]);

  function updateGuest(index: number, field: keyof RequestGuest, value: string) {
    setGuests((prev) => prev.map((g, i) => (i === index ? { ...g, [field]: value } : g)));
  }

  function addGuest() {
    if (guests.length >= club.lodgeCapacity) return;
    setGuests((prev) => [...prev, emptyGuest()]);
  }

  function removeGuest(index: number) {
    setGuests((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    if (!datesValid) {
      setError("Check-out must be after check-in.");
      return;
    }
    if (validGuests.length === 0) {
      setError("Please add at least one guest with a name.");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/booking-requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contactFirstName,
          contactLastName,
          contactEmail,
          contactPhone: contactPhone || undefined,
          checkIn,
          checkOut,
          guests: validGuests,
          message: message || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Unable to submit your booking request right now.");
      }
      setSubmitted(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to submit your booking request right now.");
    } finally {
      setSubmitting(false);
    }
  }

  if (submitted) {
    return (
      <Card className="w-full max-w-2xl">
        <CardHeader>
          <CardTitle>Request Sent</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-2 text-emerald-700">
            <CheckCircle2 className="h-6 w-6 shrink-0" />
            <p className="font-medium">Thanks, {contactFirstName} — almost there.</p>
          </div>
          <p className="text-sm text-muted-foreground">
            We&apos;ve sent a confirmation email to {contactEmail}. Please click the link inside
            to confirm your email address — once confirmed, your request will join our review
            queue and {club.lodgeName} will be in touch with pricing and a payment link.
          </p>
        </CardContent>
      </Card>
    );
  }

  const formTitle = showPricing ? "Request to Book" : "Request for Price";

  return (
    <Card className="w-full max-w-2xl">
      <CardHeader>
        <CardTitle>{formTitle}</CardTitle>
        <CardDescription>
          Request a stay at {club.lodgeName} without creating an account. We&apos;ll email you to
          confirm your address, then review and price your request.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-6">
          {error ? (
            <div className="rounded-md bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {error}
            </div>
          ) : null}

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="contactFirstName">First name</Label>
              <Input
                id="contactFirstName"
                value={contactFirstName}
                onChange={(e) => setContactFirstName(e.target.value)}
                required
                maxLength={100}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="contactLastName">Last name</Label>
              <Input
                id="contactLastName"
                value={contactLastName}
                onChange={(e) => setContactLastName(e.target.value)}
                required
                maxLength={100}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="contactEmail">Email</Label>
              <Input
                id="contactEmail"
                type="email"
                value={contactEmail}
                onChange={(e) => setContactEmail(e.target.value)}
                required
                maxLength={200}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="contactPhone">Phone (optional)</Label>
              <Input
                id="contactPhone"
                value={contactPhone}
                onChange={(e) => setContactPhone(e.target.value)}
                maxLength={30}
              />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="checkIn">Check-in</Label>
              <Input
                id="checkIn"
                type="date"
                value={checkIn}
                min={todayDateOnly()}
                onChange={(e) => setCheckIn(e.target.value)}
                required
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="checkOut">Check-out</Label>
              <Input
                id="checkOut"
                type="date"
                value={checkOut}
                min={checkIn || todayDateOnly()}
                onChange={(e) => setCheckOut(e.target.value)}
                required
              />
            </div>
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">
                Guests ({guests.length}/{club.lodgeCapacity} max)
              </h3>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={addGuest}
                disabled={guests.length >= club.lodgeCapacity}
              >
                + Add Guest
              </Button>
            </div>

            {guests.map((guest, index) => (
              <div key={index} className="grid gap-3 rounded-lg border p-3 sm:grid-cols-[1fr_1fr_1fr_auto]">
                <div className="space-y-1">
                  <Label>First name</Label>
                  <Input
                    value={guest.firstName}
                    onChange={(e) => updateGuest(index, "firstName", e.target.value)}
                    maxLength={100}
                  />
                </div>
                <div className="space-y-1">
                  <Label>Last name</Label>
                  <Input
                    value={guest.lastName}
                    onChange={(e) => updateGuest(index, "lastName", e.target.value)}
                    maxLength={100}
                  />
                </div>
                <div className="space-y-1">
                  <Label>Age category</Label>
                  <select
                    value={guest.ageTier}
                    onChange={(e) => updateGuest(index, "ageTier", e.target.value)}
                    className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors"
                  >
                    {ageTierOptions.map((option) => (
                      <option key={option.tier} value={option.tier}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex items-end">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => removeGuest(index)}
                    disabled={guests.length <= 1}
                    className="text-red-500 hover:text-red-700"
                  >
                    Remove
                  </Button>
                </div>
              </div>
            ))}
          </div>

          {showPricing ? (
            <div className="rounded-md border bg-slate-50 p-3 text-sm text-slate-700">
              {quoteLoading ? (
                "Calculating indicative price..."
              ) : indicativePriceCents != null ? (
                <p>
                  Indicative price: <span className="font-semibold">{formatCents(indicativePriceCents)}</span>
                  {" "}— the final price will be confirmed by the club.
                </p>
              ) : (
                <p>Enter your dates and guests to see an indicative price.</p>
              )}
            </div>
          ) : null}

          <div className="space-y-1">
            <Label htmlFor="message">Message (optional)</Label>
            <Textarea
              id="message"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              maxLength={1000}
              placeholder="Anything else we should know about your stay?"
            />
          </div>

          <Button type="submit" disabled={submitting} className="w-full sm:w-auto">
            {submitting ? "Submitting..." : showPricing ? "Request to Book" : "Request for Price"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
