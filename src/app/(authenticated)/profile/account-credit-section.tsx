"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { buildHrefWithReturnTo } from "@/lib/internal-return-path";
import { useClubTime } from "@/components/club-time-provider";
import { calendarDateOfSerialisedDbDate, formatClubDate } from "@/lib/club-time";

interface SourceBooking {
  id: string;
  checkIn: string;
  checkOut: string;
}

interface CreditTransaction {
  id: string;
  amountCents: number;
  type:
    | "CANCELLATION_REFUND"
    | "BOOKING_MODIFICATION_REFUND"
    | "ADMIN_ADJUSTMENT"
    | "BOOKING_APPLIED";
  description: string;
  createdAt: string;
  sourceBooking: SourceBooking | null;
  appliedToBooking: SourceBooking | null;
}

interface CreditData {
  balanceCents: number;
  history: CreditTransaction[];
}

const TYPE_LABELS: Record<string, string> = {
  CANCELLATION_REFUND: "Cancellation Refund",
  BOOKING_MODIFICATION_REFUND: "Booking Change Credit",
  ADMIN_ADJUSTMENT: "Admin Adjustment",
  BOOKING_APPLIED: "Booking Applied",
};

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * When the credit was recorded — a real INSTANT, so it has no civil date until a
 * zone is chosen (CT-4, #2870; epic #2988; INV-CONFIG-002).
 *
 * The zone is the club's PERSISTED setting, reaching this browser as data
 * through `ClubTimeProvider`. It used to be `APP_TIME_ZONE`, the container's
 * `TZ`. Same shape; only the authority moved.
 */
function useTransactionDateFormatter() {
  const clubTime = useClubTime();
  return (dateStr: string): string => clubTime.instantDate(new Date(dateStr));
}

/**
 * The source booking's stay — two CALENDAR DAYS, which take no timezone at all.
 *
 * `checkIn`/`checkOut` are `@db.Date` lodge nights serialised to ISO, so the
 * kernel reads the day out of the value's first ten characters and formats it
 * pinned to `UTC`: provably the identity for every club, and
 * deliberately NOT routed through the hook above. Sitting one line from a real
 * instant is exactly where the two concepts get merged, which is the defect
 * class this epic exists to end.
 */
function formatDateRange(checkIn: string, checkOut: string): string {
  const inDate = formatClubDate(calendarDateOfSerialisedDbDate(checkIn));
  const outDate = formatClubDate(calendarDateOfSerialisedDbDate(checkOut));
  return `${inDate} - ${outDate}`;
}

export function AccountCreditSection() {
  const formatDate = useTransactionDateFormatter();
  const [data, setData] = useState<CreditData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    fetch("/api/member/credit-balance")
      .then((res) => {
        if (!res.ok) throw new Error("Failed to fetch");
        return res.json();
      })
      .then((json) => {
        setData(json);
        setLoading(false);
      })
      .catch(() => {
        setError(true);
        setLoading(false);
      });
  }, []);

  if (loading) {
    return (
      <div className="text-sm text-muted-foreground py-4">
        Loading credit balance...
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="text-sm text-danger-11 py-4">
        Failed to load account credit.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="text-center py-3 bg-muted rounded-lg">
        <p className="text-sm text-muted-foreground">Current Balance</p>
        <p className="text-2xl font-bold text-foreground">
          {formatCents(data.balanceCents)}
        </p>
      </div>

      {data.history.length === 0 ? (
        <p className="text-sm text-muted-foreground">No credit history</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="py-2 pr-2 font-medium">Date</th>
                <th className="py-2 pr-2 font-medium">Type</th>
                <th className="py-2 pr-2 font-medium text-right">Amount</th>
                <th className="py-2 pr-2 font-medium">Description</th>
                <th className="py-2 font-medium">Booking</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {data.history.map((tx) => {
                const booking = tx.sourceBooking || tx.appliedToBooking;
                return (
                  <tr key={tx.id}>
                    <td className="py-2 pr-2 whitespace-nowrap">
                      {formatDate(tx.createdAt)}
                    </td>
                    <td className="py-2 pr-2 whitespace-nowrap">
                      {TYPE_LABELS[tx.type] ?? tx.type}
                    </td>
                    <td
                      className={`py-2 pr-2 text-right font-medium whitespace-nowrap ${
                        tx.amountCents >= 0 ? "text-success-11" : "text-danger-11"
                      }`}
                    >
                      {tx.amountCents >= 0 ? "+" : ""}
                      {formatCents(tx.amountCents)}
                    </td>
                    <td className="py-2 pr-2">{tx.description}</td>
                    <td className="py-2 whitespace-nowrap">
                      {booking ? (
                        <Link
                          href={buildHrefWithReturnTo(`/bookings/${booking.id}`, "/profile")}
                          className="text-info-11 hover:underline"
                        >
                          {formatDateRange(booking.checkIn, booking.checkOut)}
                        </Link>
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
