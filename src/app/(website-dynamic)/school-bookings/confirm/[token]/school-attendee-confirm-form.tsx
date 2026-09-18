"use client";

import { useState } from "react";
import { Check, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface AttendeeGuest {
  id: string;
  firstName: string;
  lastName: string;
  ageTier: string;
  isMember: boolean;
}

export function SchoolAttendeeConfirmForm({
  token,
  guests,
}: {
  token: string;
  guests: AttendeeGuest[];
}) {
  const [names, setNames] = useState(() =>
    Object.fromEntries(
      guests.map((guest) => [
        guest.id,
        { firstName: guest.firstName, lastName: guest.lastName },
      ]),
    ),
  );
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  function setName(guestId: string, field: "firstName" | "lastName", value: string) {
    setNames((current) => {
      const existing = current[guestId];
      // The map is seeded with every guest, so an id that is not in it belongs
      // to nobody on this booking. Spreading the absent entry would have
      // written a HALF row — one name set, the other missing — which
      // `changedUpdates` then silently reads back as the stored name. Leaving
      // the state alone is the only answer that cannot half-rename a guest
      // (#2801).
      if (!existing) return current;
      return {
        ...current,
        [guestId]: { ...existing, [field]: value },
      };
    });
  }

  function changedUpdates() {
    return guests
      .filter((guest) => !guest.isMember)
      .map((guest) => ({
        guestId: guest.id,
        firstName: names[guest.id]?.firstName?.trim() ?? guest.firstName,
        lastName: names[guest.id]?.lastName?.trim() ?? guest.lastName,
      }))
      .filter(
        (update) =>
          update.firstName !==
            guests.find((guest) => guest.id === update.guestId)?.firstName ||
          update.lastName !==
            guests.find((guest) => guest.id === update.guestId)?.lastName,
      );
  }

  async function submit(confirm: boolean) {
    const setBusy = confirm ? setConfirming : setSaving;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch("/api/school-bookings/confirm-attendees", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
          guestUpdates: changedUpdates(),
          confirm,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        setError(data.error || "Could not save the attendee list.");
        return;
      }
      if (confirm) {
        setConfirmed(true);
        setMessage(
          "Thank you — the attendee list is confirmed. Contact the club if anything changes.",
        );
      } else {
        setMessage("Names saved. You can keep editing until you confirm the list.");
      }
    } catch {
      setError("Could not save the attendee list.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {message ? (
        <div className="rounded-md border border-success-6 bg-success-3 px-4 py-3 text-sm text-success-11">
          {message}
        </div>
      ) : null}
      {error ? (
        <div className="rounded-md border border-danger-6 bg-danger-3 px-4 py-3 text-sm text-danger-11">
          {error}
        </div>
      ) : null}

      {!confirmed ? (
        <>
          <div className="space-y-3">
            {guests.map((guest, index) => (
              <div
                className="grid gap-2 rounded-md border border-border p-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
                key={guest.id}
              >
                <div className="space-y-1">
                  <Label htmlFor={`attendee-${guest.id}-first`}>
                    Attendee {index + 1} first name
                  </Label>
                  <Input
                    id={`attendee-${guest.id}-first`}
                    value={names[guest.id]?.firstName ?? ""}
                    onChange={(event) => setName(guest.id, "firstName", event.target.value)}
                    disabled={guest.isMember || saving || confirming}
                    maxLength={100}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`attendee-${guest.id}-last`}>
                    Attendee {index + 1} last name
                  </Label>
                  <Input
                    id={`attendee-${guest.id}-last`}
                    value={names[guest.id]?.lastName ?? ""}
                    onChange={(event) => setName(guest.id, "lastName", event.target.value)}
                    disabled={guest.isMember || saving || confirming}
                    maxLength={100}
                  />
                </div>
                <span className="pb-2 text-xs text-muted-foreground">
                  {guest.ageTier}
                  {guest.isMember ? " · club member (not editable)" : ""}
                </span>
              </div>
            ))}
          </div>

          <p className="text-sm text-muted-foreground">
            Need to change how many people are coming, or their age groups?
            Contact the club — headcount changes go through a revised quote.
          </p>

          <div className="flex flex-col gap-2 sm:flex-row">
            <Button
              disabled={saving || confirming}
              onClick={() => submit(false)}
              variant="outline"
            >
              <Save className="mr-2 h-4 w-4" />
              {saving ? "Saving..." : "Save Names"}
            </Button>
            <Button disabled={saving || confirming} onClick={() => submit(true)}>
              <Check className="mr-2 h-4 w-4" />
              {confirming ? "Confirming..." : "Confirm Attendee List"}
            </Button>
          </div>
        </>
      ) : null}
    </div>
  );
}
