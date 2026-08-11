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
import { todayDateOnlyForTimeZone } from "@/lib/date-only";
import { formatCents } from "@/lib/utils";

interface RequestGuest {
  firstName: string;
  lastName: string;
  ageTier: AgeTier;
}

function emptyGuest(): RequestGuest {
  return { firstName: "", lastName: "", ageTier: "ADULT" };
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
  // Active lodges from the public settings endpoint; empty for a
  // single-lodge club, so no lodge copy renders (ADR-002).
  const [lodges, setLodges] = useState<
    Array<{ id: string; name: string; capacity: number }>
  >([]);
  const [lodgeId, setLodgeId] = useState("");
  // Other/partner lodges the requester can say they belong to (#2749). Defaults
  // to "" — the "No" option — which is left blank for backwards compatibility.
  const [otherLodges, setOtherLodges] = useState<
    Array<{ id: string; name: string }>
  >([]);
  const [otherLodgeId, setOtherLodgeId] = useState("");
  const [showPricing, setShowPricing] = useState<boolean | null>(null);
  const [indicativePriceCents, setIndicativePriceCents] = useState<number | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/booking-requests/settings")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        setShowPricing(Boolean(data?.showPricingToNonMembers));
        setLodges(Array.isArray(data?.lodges) ? data.lodges : []);
        setOtherLodges(Array.isArray(data?.otherLodges) ? data.otherLodges : []);
      })
      .catch(() => setShowPricing(false));
  }, []);

  const validGuests = guests.filter((g) => g.firstName.trim() && g.lastName.trim());
  const datesValid = Boolean(checkIn && checkOut && checkOut > checkIn);
  const lodgeChoiceRequired = lodges.length >= 2;
  // Cap guests against the chosen lodge; fall back to the club/default
  // lodge for single-lodge clubs. The server re-validates per lodge.
  const selectedLodge = lodges.find((lodge) => lodge.id === lodgeId) ?? null;
  const effectiveCapacity = selectedLodge?.capacity ?? club.lodgeCapacity;

  // The quote refetch is keyed on the serialized guest list, not the array
  // identity: `validGuests` is a fresh filter result every render, so using it
  // directly would re-arm the debounce timer on unrelated re-renders.
  const validGuestsJson = JSON.stringify(validGuests);

  const fetchQuote = useCallback(async () => {
    const quoteGuests = JSON.parse(validGuestsJson) as RequestGuest[];
    if (
      !showPricing ||
      !datesValid ||
      quoteGuests.length === 0 ||
      (lodgeChoiceRequired && !lodgeId)
    ) {
      setIndicativePriceCents(null);
      return;
    }
    setQuoteLoading(true);
    try {
      const res = await fetch("/api/booking-requests/quote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          checkIn,
          checkOut,
          guests: quoteGuests,
          lodgeId: lodgeChoiceRequired ? lodgeId : undefined,
        }),
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
  }, [showPricing, datesValid, checkIn, checkOut, lodgeChoiceRequired, lodgeId, validGuestsJson]);

  useEffect(() => {
    const timer = setTimeout(fetchQuote, 400);
    return () => clearTimeout(timer);
  }, [fetchQuote]);

  function updateGuest(index: number, field: keyof RequestGuest, value: string) {
    setGuests((prev) => prev.map((g, i) => (i === index ? { ...g, [field]: value } : g)));
  }

  function addGuest() {
    if (guests.length >= effectiveCapacity) return;
    setGuests((prev) => [...prev, emptyGuest()]);
  }

  function removeGuest(index: number) {
    setGuests((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    if (lodgeChoiceRequired && !lodgeId) {
      setError("Please choose a lodge.");
      return;
    }
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
          lodgeId: lodgeChoiceRequired ? lodgeId : undefined,
          otherLodgeId: otherLodgeId || undefined,
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
          <div className="flex items-center gap-2 text-success-11">
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
            <div
              role="alert"
              className="rounded-md bg-destructive/10 px-4 py-3 text-sm text-destructive"
            >
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

          {lodgeChoiceRequired ? (
            <div className="space-y-1">
              <Label htmlFor="lodgeId">Which lodge?</Label>
              <select
                id="lodgeId"
                value={lodgeId}
                onChange={(e) => setLodgeId(e.target.value)}
                required
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors"
              >
                <option value="" disabled>
                  Choose a lodge
                </option>
                {lodges.map((lodge) => (
                  <option key={lodge.id} value={lodge.id}>
                    {lodge.name}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="checkIn">Check-in</Label>
              <Input
                id="checkIn"
                type="date"
                value={checkIn}
                min={todayDateOnlyForTimeZone()}
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
                min={checkIn || todayDateOnlyForTimeZone()}
                onChange={(e) => setCheckOut(e.target.value)}
                required
              />
            </div>
          </div>

          {otherLodges.length > 0 ? (
            <div className="space-y-1">
              <Label htmlFor="otherLodgeId">
                Are you a member of another lodge?
              </Label>
              <select
                id="otherLodgeId"
                value={otherLodgeId}
                onChange={(e) => setOtherLodgeId(e.target.value)}
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors"
              >
                <option value="">No</option>
                {otherLodges.map((lodge) => (
                  <option key={lodge.id} value={lodge.id}>
                    {lodge.name}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">
                Guests ({guests.length}/{effectiveCapacity} max)
              </h3>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={addGuest}
                disabled={guests.length >= effectiveCapacity}
              >
                + Add Guest
              </Button>
            </div>

            {guests.map((guest, index) => (
              <div key={index} className="grid gap-3 rounded-lg border p-3 sm:grid-cols-[1fr_1fr_1fr_auto]">
                <div className="space-y-1">
                  <Label htmlFor={`guest-${index}-firstName`}>First name</Label>
                  <Input
                    id={`guest-${index}-firstName`}
                    value={guest.firstName}
                    onChange={(e) => updateGuest(index, "firstName", e.target.value)}
                    maxLength={100}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`guest-${index}-lastName`}>Last name</Label>
                  <Input
                    id={`guest-${index}-lastName`}
                    value={guest.lastName}
                    onChange={(e) => updateGuest(index, "lastName", e.target.value)}
                    maxLength={100}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`guest-${index}-ageTier`}>Age category</Label>
                  <select
                    id={`guest-${index}-ageTier`}
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
                    className="text-danger-11 hover:text-danger-11"
                  >
                    Remove
                  </Button>
                </div>
              </div>
            ))}
          </div>

          {showPricing ? (
            <div className="rounded-md border bg-muted p-3 text-sm text-muted-foreground">
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
