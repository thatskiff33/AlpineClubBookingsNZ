"use client";

import { Copy } from "lucide-react";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  ADMIN_VIEW_ONLY_ACTION_REASON,
  useAdminAreaEditAccess,
} from "@/hooks/use-admin-area-edit-access";
import {
  saveErrorMessage,
  saveRefusalFromResponse,
} from "@/hooks/use-section-edit-state";
import { formatDateOnly } from "@/lib/date-only";

const COPY_FALLBACK = "Failed to copy booking";
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function parseDateOnly(date: string) {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function addDaysDateOnly(date: string, days: number) {
  const parsed = parseDateOnly(date);
  if (!parsed) return "";
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return formatDateOnly(parsed);
}

function getNights(checkIn: string, checkOut: string) {
  const start = parseDateOnly(checkIn);
  const end = parseDateOnly(checkOut);
  if (!start || !end) return 0;
  return Math.max(0, Math.round((end.getTime() - start.getTime()) / MS_PER_DAY));
}

export function CopyBookingButton({
  bookingId,
  sourceCheckIn,
  sourceCheckOut,
  minCheckIn,
}: {
  bookingId: string;
  sourceCheckIn: string;
  sourceCheckOut: string;
  minCheckIn: string;
}) {
  const router = useRouter();
  // Copy writes /api/admin/bookings/[id]/copy (bookings area). A view-only
  // bookings admin can see the button but cannot open the dialog (#1997).
  const canEdit = useAdminAreaEditAccess("bookings");
  const [open, setOpen] = useState(false);
  const [checkIn, setCheckIn] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const nights = useMemo(
    () => getNights(sourceCheckIn, sourceCheckOut),
    [sourceCheckIn, sourceCheckOut],
  );
  const checkOut = checkIn ? addDaysDateOnly(checkIn, nights) : "";

  async function handleCopy() {
    if (!canEdit || !checkIn || submitting) return;

    setError("");
    setSubmitting(true);
    try {
      const response = await fetch(`/api/admin/bookings/${bookingId}/copy`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ checkIn }),
      });
      if (!response.ok) throw await saveRefusalFromResponse(response, COPY_FALLBACK);
      const data = await response.json();

      setOpen(false);
      router.push(`/bookings/${data.bookingId}`);
      router.refresh();
    } catch (err) {
      setError(saveErrorMessage(err, COPY_FALLBACK));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !submitting && setOpen(nextOpen)}>
      <DialogTrigger asChild>
        <Button
          variant="outline"
          disabled={!canEdit}
          title={canEdit === false ? ADMIN_VIEW_ONLY_ACTION_REASON : undefined}
        >
          <Copy className="mr-2 h-4 w-4" />
          Copy Booking
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Copy Booking</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1">
            <Label htmlFor="copy-booking-check-in">New Check-in</Label>
            <Input
              id="copy-booking-check-in"
              type="date"
              value={checkIn}
              min={minCheckIn}
              onChange={(event) => setCheckIn(event.target.value)}
            />
          </div>
          {checkOut ? (
            <div className="rounded-md border p-3 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">New Check-out</span>
                <span className="font-medium">{checkOut}</span>
              </div>
              <div className="mt-1 flex justify-between">
                <span className="text-muted-foreground">Nights</span>
                <span className="font-medium">{nights}</span>
              </div>
            </div>
          ) : null}
          {error ? (
            <div className="rounded-md bg-danger-3 p-3 text-sm text-danger-11">
              {error}
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => setOpen(false)}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button type="button" onClick={handleCopy} disabled={!checkIn || submitting}>
            {submitting ? "Copying..." : "Create Draft"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
