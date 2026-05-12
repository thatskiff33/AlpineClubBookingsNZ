"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { buildHrefWithReturnTo } from "@/lib/internal-return-path";

interface SourceBooking {
  id: string;
  checkIn: string;
  checkOut: string;
}

interface CreditTransaction {
  id: string;
  amountCents: number;
  type: "CANCELLATION_REFUND" | "ADMIN_ADJUSTMENT" | "BOOKING_APPLIED";
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
  ADMIN_ADJUSTMENT: "Admin Adjustment",
  BOOKING_APPLIED: "Booking Applied",
};

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString("en-NZ", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function formatDateRange(checkIn: string, checkOut: string): string {
  const inDate = new Date(checkIn).toLocaleDateString("en-NZ", {
    day: "numeric",
    month: "short",
  });
  const outDate = new Date(checkOut).toLocaleDateString("en-NZ", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  return `${inDate} - ${outDate}`;
}

export function AccountCreditSection() {
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
      <div className="text-sm text-red-500 py-4">
        Failed to load account credit.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="text-center py-3 bg-slate-50 rounded-lg">
        <p className="text-sm text-muted-foreground">Current Balance</p>
        <p className="text-2xl font-bold text-slate-900">
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
                        tx.amountCents >= 0 ? "text-green-600" : "text-red-600"
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
                          className="text-blue-600 hover:underline"
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
