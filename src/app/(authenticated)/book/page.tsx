"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { BookingCalendar } from "@/components/booking-calendar";
import { GuestForm, type GuestData } from "@/components/guest-form";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LODGE_CAPACITY } from "@/lib/capacity";
import { PromoCodeInput, type PromoResult } from "@/components/promo-code-input";

interface FamilyMember {
  id: string;
  firstName: string;
  lastName: string;
  ageTier: "ADULT" | "YOUTH" | "CHILD";
  relationship: "self" | "partner" | "dependent";
}

interface PriceQuote {
  guests: {
    ageTier: string;
    isMember: boolean;
    nights: number;
    priceCents: number;
  }[];
  totalPriceCents: number;
}

export default function BookPage() {
  const router = useRouter();
  const [step, setStep] = useState<"dates" | "guests" | "review">("dates");
  const [checkIn, setCheckIn] = useState<Date | null>(null);
  const [checkOut, setCheckOut] = useState<Date | null>(null);
  const [guests, setGuests] = useState<GuestData[]>([]);
  const [notes, setNotes] = useState("");
  const [priceQuote, setPriceQuote] = useState<PriceQuote | null>(null);
  const [priceLoading, setPriceLoading] = useState(false);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [availableBeds, setAvailableBeds] = useState(LODGE_CAPACITY);
  const [appliedPromo, setAppliedPromo] = useState<PromoResult | null>(null);
  const [familyMembers, setFamilyMembers] = useState<FamilyMember[]>([]);

  useEffect(() => {
    fetch("/api/members/family")
      .then((res) => res.ok ? res.json() : { familyMembers: [] })
      .then((data) => setFamilyMembers(data.familyMembers || []))
      .catch(() => {});
  }, []);

  function addFamilyMemberAsGuest(fm: FamilyMember) {
    if (guests.some((g) => g.memberId === fm.id)) return;
    if (guests.length >= availableBeds) return;
    setGuests([
      ...guests,
      {
        firstName: fm.firstName,
        lastName: fm.lastName,
        ageTier: fm.ageTier,
        isMember: true,
        memberId: fm.id,
      },
    ]);
  }

  async function handleDateSelect(ci: Date, co: Date) {
    setCheckIn(ci);
    setCheckOut(co);
    setError("");

    // Fetch availability for selected range
    const res = await fetch(
      `/api/availability/check?checkIn=${ci.toISOString()}&checkOut=${co.toISOString()}`
    );
    if (res.ok) {
      const data = await res.json();
      setAvailableBeds(data.minAvailable);
    }
    setStep("guests");
  }

  async function handleGuestsDone() {
    if (guests.length === 0) {
      setError("Add at least one guest");
      return;
    }

    // Validate guest names
    for (const g of guests) {
      if (!g.firstName.trim() || !g.lastName.trim()) {
        setError("All guests must have first and last names");
        return;
      }
    }

    if (guests.length > availableBeds) {
      setError(`Only ${availableBeds} beds available for your dates`);
      return;
    }

    setError("");
    setPriceLoading(true);

    // Fetch price quote
    const res = await fetch("/api/bookings/quote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        checkIn: checkIn!.toISOString(),
        checkOut: checkOut!.toISOString(),
        guests: guests.map((g) => ({ ageTier: g.ageTier, isMember: g.isMember })),
      }),
    });

    if (res.ok) {
      const data = await res.json();
      setPriceQuote(data);
      setStep("review");
    } else {
      const data = await res.json();
      setError(data.error || "Failed to calculate price");
    }
    setPriceLoading(false);
  }

  async function handleSubmit() {
    setSubmitting(true);
    setError("");

    const res = await fetch("/api/bookings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        checkIn: checkIn!.toISOString(),
        checkOut: checkOut!.toISOString(),
        guests,
        notes: notes || undefined,
        promoCode: appliedPromo?.code || undefined,
      }),
    });

    if (res.ok) {
      const data = await res.json();
      router.push(`/bookings/${data.id}`);
    } else {
      const data = await res.json();
      setError(data.error || "Failed to create booking");
      setSubmitting(false);
    }
  }

  const nights = checkIn && checkOut
    ? Math.ceil((checkOut.getTime() - checkIn.getTime()) / (1000 * 60 * 60 * 24))
    : 0;

  function formatCents(cents: number) {
    return `$${(cents / 100).toFixed(2)}`;
  }

  return (
    <div className="max-w-3xl space-y-6">
      <h1 className="text-3xl font-bold">Book a Stay</h1>

      {error && (
        <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</div>
      )}

      {/* Step indicator */}
      <div className="flex items-center gap-2 text-sm">
        <span className={step === "dates" ? "font-bold text-blue-600" : "text-gray-400"}>
          1. Select Dates
        </span>
        <span className="text-gray-300">&rarr;</span>
        <span className={step === "guests" ? "font-bold text-blue-600" : "text-gray-400"}>
          2. Add Guests
        </span>
        <span className="text-gray-300">&rarr;</span>
        <span className={step === "review" ? "font-bold text-blue-600" : "text-gray-400"}>
          3. Review & Confirm
        </span>
      </div>

      {/* Step 1: Dates */}
      {step === "dates" && (
        <Card>
          <CardHeader>
            <CardTitle>Select Your Dates</CardTitle>
          </CardHeader>
          <CardContent>
            <BookingCalendar
              onDateSelect={handleDateSelect}
              selectedCheckIn={checkIn}
              selectedCheckOut={checkOut}
            />
          </CardContent>
        </Card>
      )}

      {/* Step 2: Guests */}
      {step === "guests" && (
        <Card>
          <CardHeader>
            <CardTitle>
              Add Guests
              {checkIn && checkOut && (
                <span className="ml-2 text-sm font-normal text-gray-500">
                  {checkIn.toLocaleDateString("en-NZ")} - {checkOut.toLocaleDateString("en-NZ")} ({nights} night{nights !== 1 ? "s" : ""})
                </span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {familyMembers.length > 0 && (
              <div className="space-y-2">
                <p className="text-sm font-medium text-muted-foreground">Quick add family members</p>
                <div className="flex flex-wrap gap-2">
                  {familyMembers.map((fm) => {
                    const alreadyAdded = guests.some((g) => g.memberId === fm.id);
                    const label = fm.relationship === "self"
                      ? `${fm.firstName} ${fm.lastName} (You)`
                      : `${fm.firstName} ${fm.lastName} (${fm.ageTier})`;
                    return (
                      <Button
                        key={fm.id}
                        type="button"
                        variant={alreadyAdded ? "secondary" : fm.relationship === "self" ? "default" : "outline"}
                        size="sm"
                        disabled={alreadyAdded || guests.length >= availableBeds}
                        onClick={() => addFamilyMemberAsGuest(fm)}
                      >
                        {alreadyAdded ? "\u2713 " : "+ "}
                        {label}
                      </Button>
                    );
                  })}
                </div>
              </div>
            )}
            <GuestForm
              guests={guests}
              onGuestsChange={setGuests}
              maxGuests={availableBeds}
            />
            <div className="flex justify-between pt-4">
              <Button variant="outline" onClick={() => setStep("dates")}>
                Back
              </Button>
              <Button onClick={handleGuestsDone} disabled={priceLoading || guests.length === 0}>
                {priceLoading ? "Calculating price..." : "Continue"}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Step 3: Review */}
      {step === "review" && priceQuote && (
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Booking Summary</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <span className="text-gray-500">Check-in:</span>{" "}
                  <span className="font-medium">
                    {checkIn!.toLocaleDateString("en-NZ", {
                      weekday: "short", day: "numeric", month: "short", year: "numeric",
                    })}
                  </span>
                </div>
                <div>
                  <span className="text-gray-500">Check-out:</span>{" "}
                  <span className="font-medium">
                    {checkOut!.toLocaleDateString("en-NZ", {
                      weekday: "short", day: "numeric", month: "short", year: "numeric",
                    })}
                  </span>
                </div>
                <div>
                  <span className="text-gray-500">Nights:</span>{" "}
                  <span className="font-medium">{nights}</span>
                </div>
                <div>
                  <span className="text-gray-500">Guests:</span>{" "}
                  <span className="font-medium">{guests.length}</span>
                </div>
              </div>

              <div className="border-t pt-4">
                <h4 className="font-medium mb-2">Guests</h4>
                {guests.map((g, i) => (
                  <div key={i} className="flex justify-between text-sm py-1">
                    <span>
                      {g.firstName} {g.lastName} ({g.ageTier}, {g.isMember ? "Member" : "Non-member"})
                    </span>
                    <span className="font-medium">
                      {formatCents(priceQuote.guests[i]?.priceCents || 0)}
                    </span>
                  </div>
                ))}
              </div>

              {appliedPromo && appliedPromo.discountCents > 0 ? (
                <>
                  <div className="border-t pt-4 flex justify-between text-sm">
                    <span>Subtotal</span>
                    <span>{formatCents(priceQuote.totalPriceCents)}</span>
                  </div>
                  <div className="flex justify-between text-sm text-green-600">
                    <span>Discount ({appliedPromo.code})</span>
                    <span>-{formatCents(appliedPromo.discountCents)}</span>
                  </div>
                  <div className="flex justify-between font-bold text-lg">
                    <span>Total</span>
                    <span>{formatCents(priceQuote.totalPriceCents - appliedPromo.discountCents)}</span>
                  </div>
                </>
              ) : (
                <div className="border-t pt-4 flex justify-between font-bold text-lg">
                  <span>Total</span>
                  <span>{formatCents(priceQuote.totalPriceCents)}</span>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6 space-y-4">
              <div className="space-y-2">
                <Label htmlFor="notes">Notes (optional)</Label>
                <Input
                  id="notes"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Any special requirements..."
                />
              </div>
              <PromoCodeInput
                checkIn={checkIn!}
                checkOut={checkOut!}
                guests={guests}
                onPromoApplied={setAppliedPromo}
                appliedPromo={appliedPromo}
              />
            </CardContent>
          </Card>

          {guests.some((g) => !g.isMember) && (
            <div className="rounded-md bg-yellow-50 p-4 text-sm text-yellow-800">
              <strong>Note:</strong> This booking includes non-member guests.
              {" Your booking may be held as PENDING until closer to check-in. Members have priority \u2014 your booking may be bumped if the lodge fills up."}
            </div>
          )}

          <div className="flex justify-between">
            <Button variant="outline" onClick={() => setStep("guests")}>
              Back
            </Button>
            <Button onClick={handleSubmit} disabled={submitting} size="lg">
              {submitting ? "Creating booking..." : "Confirm Booking"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
