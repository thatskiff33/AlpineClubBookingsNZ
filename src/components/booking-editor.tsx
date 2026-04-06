"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EditBookingPanel } from "@/components/edit-booking-panel";
import { formatCents } from "@/lib/utils";

interface Guest {
  id: string;
  firstName: string;
  lastName: string;
  ageTier: string;
  isMember: boolean;
  priceCents: number;
}

interface PromoInfo {
  code: string;
  type: string;
  description: string | null;
}

export interface BookingEditorData {
  id: string;
  checkIn: string;
  checkOut: string;
  nights: number;
  status: string;
  guests: Guest[];
  totalPriceCents: number;
  discountCents: number;
  finalPriceCents: number;
  promo: PromoInfo | null;
  hasNonMembers: boolean;
  nonMemberHoldUntil: string | null;
}

function statusColor(status: string) {
  switch (status) {
    case "CONFIRMED":
    case "PAID":
      return "success" as const;
    case "PENDING":
      return "warning" as const;
    case "CANCELLED":
    case "BUMPED":
      return "destructive" as const;
    default:
      return "secondary" as const;
  }
}

export function BookingEditor({
  booking,
  canModify,
}: {
  booking: BookingEditorData;
  canModify: boolean;
}) {
  const [editing, setEditing] = useState(false);

  if (editing && canModify) {
    return (
      <EditBookingPanel
        booking={{
          id: booking.id,
          checkIn: booking.checkIn,
          checkOut: booking.checkOut,
          guests: booking.guests,
          finalPriceCents: booking.finalPriceCents,
          totalPriceCents: booking.totalPriceCents,
          discountCents: booking.discountCents,
          promo: booking.promo,
        }}
        onDone={() => setEditing(false)}
      />
    );
  }

  return (
    <div className="space-y-6">
      {/* Stay Details */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <CardTitle>Stay Details</CardTitle>
              {canModify && (
                <Button variant="outline" onClick={() => setEditing(true)}>
                  Edit Booking
                </Button>
              )}
            </div>
            <Badge variant={statusColor(booking.status)}>{booking.status}</Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-sm text-gray-500">Check-in</p>
              <p className="font-medium">
                {new Date(booking.checkIn + "T00:00:00").toLocaleDateString("en-NZ", {
                  weekday: "long",
                  day: "numeric",
                  month: "long",
                  year: "numeric",
                })}
              </p>
            </div>
            <div>
              <p className="text-sm text-gray-500">Check-out</p>
              <p className="font-medium">
                {new Date(booking.checkOut + "T00:00:00").toLocaleDateString("en-NZ", {
                  weekday: "long",
                  day: "numeric",
                  month: "long",
                  year: "numeric",
                })}
              </p>
            </div>
            <div>
              <p className="text-sm text-gray-500">Nights</p>
              <p className="font-medium">{booking.nights}</p>
            </div>
            <div>
              <p className="text-sm text-gray-500">Guests</p>
              <p className="font-medium">{booking.guests.length}</p>
            </div>
          </div>

          {booking.status === "PENDING" && booking.nonMemberHoldUntil && (
            <div className="rounded-md bg-yellow-50 p-3 text-sm text-yellow-800">
              This booking includes non-members. It will be auto-confirmed on{" "}
              {new Date(booking.nonMemberHoldUntil).toLocaleDateString("en-NZ")},
              subject to availability. Members have priority.
            </div>
          )}
        </CardContent>
      </Card>

      {/* Guests */}
      <Card>
        <CardHeader>
          <CardTitle>Guests</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="divide-y">
            {booking.guests.map((guest) => (
              <div key={guest.id} className="flex items-center justify-between py-3">
                <div>
                  <p className="font-medium">
                    {guest.firstName} {guest.lastName}
                  </p>
                  <p className="text-sm text-gray-500">
                    {guest.ageTier} &middot; {guest.isMember ? "Member" : "Non-member"}
                  </p>
                </div>
                <p className="font-medium">{formatCents(guest.priceCents)}</p>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Payment */}
      <Card>
        <CardHeader>
          <CardTitle>Payment</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="flex justify-between">
            <span>Subtotal</span>
            <span>{formatCents(booking.totalPriceCents)}</span>
          </div>
          {booking.discountCents > 0 && (
            <div className="flex justify-between text-green-600">
              <span>
                Discount
                {booking.promo?.code && (
                  <span className="ml-1 text-xs">({booking.promo.code})</span>
                )}
              </span>
              <span>-{formatCents(booking.discountCents)}</span>
            </div>
          )}
          <div className="flex justify-between border-t pt-2 font-bold">
            <span>Total</span>
            <span>{formatCents(booking.finalPriceCents)}</span>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
