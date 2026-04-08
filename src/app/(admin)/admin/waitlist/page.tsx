"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { bookingStatusClass } from "@/lib/status-colors";

interface WaitlistEntry {
  id: string;
  memberName: string;
  memberEmail: string;
  memberId: string;
  checkIn: string;
  checkOut: string;
  guestCount: number;
  status: string;
  waitlistPosition: number | null;
  waitlistOfferExpiresAt: string | null;
  finalPriceCents: number;
  createdAt: string;
}

export default function AdminWaitlistPage() {
  const [entries, setEntries] = useState<WaitlistEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [forceConfirming, setForceConfirming] = useState<string | null>(null);
  const [overbookDialog, setOverbookDialog] = useState<{
    bookingId: string;
    dates: string[];
  } | null>(null);
  const [error, setError] = useState("");

  const loadEntries = useCallback(async () => {
    const res = await fetch("/api/admin/waitlist");
    if (res.ok) {
      const data = await res.json();
      setEntries(data.entries);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    loadEntries();
  }, [loadEntries]);

  async function handleForceConfirm(bookingId: string, allowOverbook = false) {
    setForceConfirming(bookingId);
    setError("");

    const res = await fetch(`/api/admin/bookings/${bookingId}/force-confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ allowOverbook }),
    });

    const data = await res.json();

    if (res.ok && data.success) {
      setOverbookDialog(null);
      await loadEntries();
    } else if (data.error === "CAPACITY_EXCEEDED" && data.overbookDates) {
      setOverbookDialog({ bookingId, dates: data.overbookDates });
    } else {
      setError(data.error || "Failed to force-confirm booking");
    }

    setForceConfirming(null);
  }

  if (loading) {
    return <div className="p-6">Loading waitlist...</div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Waitlist</h1>
        <Badge variant="secondary">{entries.length} entries</Badge>
      </div>

      {error && (
        <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</div>
      )}

      {overbookDialog && (
        <Card className="border-amber-200 bg-amber-50">
          <CardContent className="pt-6 space-y-3">
            <p className="font-medium text-amber-900">
              This will overbook the lodge on the following dates:
            </p>
            <ul className="list-disc list-inside text-sm text-amber-800">
              {overbookDialog.dates.map((d) => (
                <li key={d}>{d}</li>
              ))}
            </ul>
            <div className="flex gap-3">
              <Button
                variant="outline"
                onClick={() => setOverbookDialog(null)}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={() => handleForceConfirm(overbookDialog.bookingId, true)}
                disabled={forceConfirming === overbookDialog.bookingId}
              >
                {forceConfirming === overbookDialog.bookingId
                  ? "Confirming..."
                  : "Confirm Anyway (Overbook)"}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {entries.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-gray-500">
            No waitlisted bookings
          </CardContent>
        </Card>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b bg-gray-50 text-left">
                <th className="px-3 py-2 font-medium">#</th>
                <th className="px-3 py-2 font-medium">Member</th>
                <th className="px-3 py-2 font-medium">Check-in</th>
                <th className="px-3 py-2 font-medium">Check-out</th>
                <th className="px-3 py-2 font-medium">Guests</th>
                <th className="px-3 py-2 font-medium">Price</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Offer Expires</th>
                <th className="px-3 py-2 font-medium">Created</th>
                <th className="px-3 py-2 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id} className="border-b hover:bg-gray-50">
                  <td className="px-3 py-2">{entry.waitlistPosition ?? "-"}</td>
                  <td className="px-3 py-2">
                    <div className="font-medium">{entry.memberName}</div>
                    <div className="text-xs text-gray-500">{entry.memberEmail}</div>
                  </td>
                  <td className="px-3 py-2">{entry.checkIn}</td>
                  <td className="px-3 py-2">{entry.checkOut}</td>
                  <td className="px-3 py-2">{entry.guestCount}</td>
                  <td className="px-3 py-2">
                    ${(entry.finalPriceCents / 100).toFixed(2)}
                  </td>
                  <td className="px-3 py-2">
                    <Badge variant="secondary" className={bookingStatusClass(entry.status)}>
                      {entry.status.replace("_", " ")}
                    </Badge>
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {entry.waitlistOfferExpiresAt
                      ? new Date(entry.waitlistOfferExpiresAt).toLocaleString("en-NZ", {
                          dateStyle: "short",
                          timeStyle: "short",
                        })
                      : "-"}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {new Date(entry.createdAt).toLocaleString("en-NZ", {
                      dateStyle: "short",
                      timeStyle: "short",
                    })}
                  </td>
                  <td className="px-3 py-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handleForceConfirm(entry.id)}
                      disabled={forceConfirming === entry.id}
                    >
                      {forceConfirming === entry.id ? "..." : "Force Confirm"}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
