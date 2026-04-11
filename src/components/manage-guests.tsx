"use client";

import type { AgeTier } from "@prisma/client";
import { useState } from "react";
import { useAgeTierOptions } from "@/lib/use-age-tier-options";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { formatCents } from "@/lib/utils";
import StripeProvider from "@/components/stripe/StripeProvider";
import PaymentForm from "@/components/stripe/PaymentForm";

interface Guest {
  id: string;
  firstName: string;
  lastName: string;
  ageTier: string;
  isMember: boolean;
  priceCents: number;
}

interface ManageGuestsProps {
  bookingId: string;
  guests: Guest[];
  checkIn: string;
  checkOut: string;
}

interface AddGuestQuote {
  newFinalPriceCents: number;
  priceDiffCents: number;
  capacityAvailable: boolean;
}

interface RemoveGuestQuote {
  newFinalPriceCents: number;
  priceDiffCents: number;
}

export function ManageGuests({ bookingId, guests, checkIn, checkOut }: ManageGuestsProps) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-gray-500">Manage Guests</span>
        <AddGuestDialog bookingId={bookingId} checkIn={checkIn} checkOut={checkOut} />
      </div>
      {guests.map((guest) => (
        <div key={guest.id} className="flex items-center justify-between py-2">
          <div>
            <p className="font-medium">
              {guest.firstName} {guest.lastName}
            </p>
            <p className="text-sm text-gray-500">
              {guest.ageTier} &middot; {guest.isMember ? "Member" : "Non-member"}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <span className="font-medium">{formatCents(guest.priceCents)}</span>
            {guests.length > 1 && (
              <RemoveGuestButton
                bookingId={bookingId}
                guest={guest}
              />
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function AddGuestDialog({
  bookingId,
  checkIn,
  checkOut,
}: {
  bookingId: string;
  checkIn: string;
  checkOut: string;
}) {
  const router = useRouter();
  const ageTierOptions = useAgeTierOptions();
  const [open, setOpen] = useState(false);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [ageTier, setAgeTier] = useState<AgeTier>("ADULT");
  const [isMember, setIsMember] = useState(false);
  const [quote, setQuote] = useState<AddGuestQuote | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Additional payment state
  const [additionalPaymentClientSecret, setAdditionalPaymentClientSecret] = useState<string | null>(null);
  const [additionalAmountCents, setAdditionalAmountCents] = useState(0);
  const [paymentComplete, setPaymentComplete] = useState(false);

  function resetForm() {
    setFirstName("");
    setLastName("");
    setAgeTier("ADULT");
    setIsMember(false);
    setQuote(null);
    setError("");
    setAdditionalPaymentClientSecret(null);
    setAdditionalAmountCents(0);
    setPaymentComplete(false);
  }

  async function fetchQuote() {
    setError("");
    setQuote(null);
    setQuoteLoading(true);
    try {
      const res = await fetch(`/api/bookings/${bookingId}/modify-quote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          addGuests: [{ firstName, lastName, ageTier, isMember }],
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Failed to get quote");
        return;
      }
      setQuote(data);
    } catch {
      setError("Failed to get quote");
    } finally {
      setQuoteLoading(false);
    }
  }

  async function handleAdd() {
    setError("");
    setSubmitting(true);
    try {
      const res = await fetch(`/api/bookings/${bookingId}/guests`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          guests: [{ firstName, lastName, ageTier, isMember }],
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Failed to add guest");
        return;
      }

      if (data.additionalPaymentClientSecret) {
        // Guest added, but additional payment required
        setAdditionalPaymentClientSecret(data.additionalPaymentClientSecret);
        setAdditionalAmountCents(data.additionalAmountCents);
      } else {
        setOpen(false);
        resetForm();
        router.refresh();
      }
    } catch {
      setError("Failed to add guest");
    } finally {
      setSubmitting(false);
    }
  }

  async function handlePaymentSuccess(paymentIntentId: string) {
    try {
      await fetch(`/api/bookings/${bookingId}/confirm-modification-payment`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paymentIntentId }),
      });
    } catch {
      // Non-fatal: webhook will also confirm
    }
    setPaymentComplete(true);
    setTimeout(() => {
      setOpen(false);
      resetForm();
      router.refresh();
    }, 1500);
  }

  function handleOpenChange(isOpen: boolean) {
    setOpen(isOpen);
    if (isOpen) resetForm();
  }

  const formValid = firstName.trim() && lastName.trim();
  const returnUrl = typeof window !== "undefined"
    ? `${window.location.origin}/bookings/${bookingId}`
    : `/bookings/${bookingId}`;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          + Add Guest
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add Guest</DialogTitle>
          <DialogDescription>
            {additionalPaymentClientSecret
              ? "Complete payment to confirm the guest addition."
              : `Add a new guest to this booking (${checkIn} to ${checkOut}).`}
          </DialogDescription>
        </DialogHeader>

        {additionalPaymentClientSecret ? (
          <div className="space-y-4">
            {paymentComplete ? (
              <div className="rounded-md bg-green-50 p-4 text-sm text-green-700">
                <p className="font-medium">Payment successful!</p>
                <p className="mt-1">Guest added and payment processed.</p>
              </div>
            ) : (
              <>
                <div className="rounded-md bg-amber-50 p-3 text-sm text-amber-800">
                  <p className="font-medium">Additional payment required</p>
                  <p className="mt-1">
                    Guest has been added. Please pay the additional{" "}
                    {formatCents(additionalAmountCents)} to complete the modification.
                  </p>
                </div>
                <StripeProvider clientSecret={additionalPaymentClientSecret}>
                  <PaymentForm
                    bookingId={bookingId}
                    amountCents={additionalAmountCents}
                    returnUrl={returnUrl}
                    onSuccess={handlePaymentSuccess}
                    onError={(err) => setError(err)}
                  />
                </StripeProvider>
                {error && (
                  <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</div>
                )}
              </>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="add-guest-first">First Name</Label>
                <Input
                  id="add-guest-first"
                  value={firstName}
                  onChange={(e) => {
                    setFirstName(e.target.value);
                    setQuote(null);
                  }}
                  placeholder="First name"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="add-guest-last">Last Name</Label>
                <Input
                  id="add-guest-last"
                  value={lastName}
                  onChange={(e) => {
                    setLastName(e.target.value);
                    setQuote(null);
                  }}
                  placeholder="Last name"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="add-guest-age">Age Category</Label>
                <select
                  id="add-guest-age"
                  value={ageTier}
                  onChange={(e) => {
                    setAgeTier(e.target.value as AgeTier);
                    setQuote(null);
                  }}
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
                >
                  {ageTierOptions.map((option) => (
                    <option key={option.tier} value={option.tier}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="add-guest-member">Membership</Label>
                <select
                  id="add-guest-member"
                  value={isMember ? "true" : "false"}
                  onChange={(e) => {
                    setIsMember(e.target.value === "true");
                    setQuote(null);
                  }}
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
                >
                  <option value="true">Member</option>
                  <option value="false">Non-member</option>
                </select>
              </div>
            </div>

            {formValid && !quote && (
              <Button onClick={fetchQuote} disabled={quoteLoading} className="w-full">
                {quoteLoading ? "Checking..." : "Check Price Impact"}
              </Button>
            )}

            {error && (
              <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</div>
            )}

            {quote && (
              <div className="rounded-md bg-gray-50 p-3 space-y-1 text-sm">
                {!quote.capacityAvailable ? (
                  <p className="text-red-700 font-medium">Not enough beds available to add this guest.</p>
                ) : (
                  <>
                    <div className="flex justify-between">
                      <span>New total</span>
                      <span className="font-medium">{formatCents(quote.newFinalPriceCents)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Price increase</span>
                      <span className="font-medium text-red-600">+{formatCents(quote.priceDiffCents)}</span>
                    </div>
                    <p className="text-xs text-gray-500 pt-1">
                      Additional payment will be collected after confirming.
                    </p>
                  </>
                )}
              </div>
            )}
          </div>
        )}

        {!additionalPaymentClientSecret && (
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleAdd}
              disabled={!quote || !quote.capacityAvailable || submitting}
            >
              {submitting ? "Adding..." : "Add Guest"}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

function RemoveGuestButton({
  bookingId,
  guest,
}: {
  bookingId: string;
  guest: Guest;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [quote, setQuote] = useState<RemoveGuestQuote | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [error, setError] = useState("");
  const [removing, setRemoving] = useState(false);

  async function fetchQuote() {
    setError("");
    setQuote(null);
    setQuoteLoading(true);
    try {
      const res = await fetch(`/api/bookings/${bookingId}/modify-quote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ removeGuestIds: [guest.id] }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Failed to get quote");
        return;
      }
      setQuote(data);
    } catch {
      setError("Failed to get quote");
    } finally {
      setQuoteLoading(false);
    }
  }

  async function handleRemove() {
    setError("");
    setRemoving(true);
    try {
      const res = await fetch(`/api/bookings/${bookingId}/guests/${guest.id}`, {
        method: "DELETE",
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Failed to remove guest");
        return;
      }
      setOpen(false);
      router.refresh();
    } catch {
      setError("Failed to remove guest");
    } finally {
      setRemoving(false);
    }
  }

  function handleOpenChange(isOpen: boolean) {
    setOpen(isOpen);
    if (isOpen) {
      setQuote(null);
      setError("");
      fetchQuote();
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" className="text-red-500 hover:text-red-700">
          Remove
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Remove Guest</DialogTitle>
          <DialogDescription>
            Remove {guest.firstName} {guest.lastName} from this booking?
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {quoteLoading && (
            <p className="text-sm text-gray-500">Calculating price impact...</p>
          )}

          {error && (
            <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</div>
          )}

          {quote && (
            <div className="rounded-md bg-gray-50 p-3 space-y-1 text-sm">
              <div className="flex justify-between">
                <span>New total</span>
                <span className="font-medium">{formatCents(quote.newFinalPriceCents)}</span>
              </div>
              {quote.priceDiffCents < 0 && (
                <div className="flex justify-between text-green-600">
                  <span>Refund</span>
                  <span className="font-medium">{formatCents(Math.abs(quote.priceDiffCents))}</span>
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={handleRemove}
            disabled={quoteLoading || removing}
          >
            {removing ? "Removing..." : "Remove Guest"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
