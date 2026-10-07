"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { MemberDietaryRequirementsField } from "@/components/member-dietary-requirements-field";
import { DIETARY_REQUIREMENTS_LABEL } from "@/lib/member-dietary-field";
import type { AgeTier } from "@prisma/client";

/** One guest row as the page's booking-admin loader hands it over. */
export type BookingGuestDietaryRow = {
  id: string;
  firstName: string;
  lastName: string;
  isMember: boolean;
  memberId: string | null;
  ageTier: AgeTier;
  dietaryRequirements: string | null;
};

/**
 * THE STAY'S DIETARY/ALLERGY INFORMATION, for booking administrators only
 * (#3029, `INV-PRIV-022`, `INV-MOD-059`).
 *
 * The page renders this ONLY when it holds a booking-admin dietary grant — the
 * field is ON and the viewer holds `bookings:view`, re-read from the database —
 * so the values below never reach an owner's, a linked guest's or any other
 * viewer's payload at all. `canEdit` is `bookings:edit` on a live booking,
 * decided on the server the same way; the save route re-checks it. Every guest
 * is listed, members and non-members alike, because a non-member guest's value
 * lives here and nowhere else.
 */
export function BookingGuestDietaryCard({
  bookingId,
  guests,
  canEdit,
}: {
  bookingId: string;
  guests: BookingGuestDietaryRow[];
  canEdit: boolean;
}) {
  return (
    <Card id="dietary" className="scroll-mt-20">
      <CardHeader>
        <CardTitle>{DIETARY_REQUIREMENTS_LABEL}</CardTitle>
        <CardDescription>
          Copied from each member&apos;s profile when they were added to this
          booking, then kept for this stay only. Changing it here does not change
          anyone&apos;s profile, and a later profile change does not change it here.
          Booking officers and the hut leader running the stay can see it.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {guests.length === 0 ? (
          <p className="text-sm text-muted-foreground">No guests on this booking.</p>
        ) : (
          <ul className="space-y-4">
            {guests.map((guest) => (
              <GuestDietaryRow
                key={guest.id}
                bookingId={bookingId}
                guest={guest}
                canEdit={canEdit}
              />
            ))}
          </ul>
        )}
        {!canEdit && (
          <p className="text-xs text-muted-foreground">
            You can view these notes. Changing them needs booking edit access.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function GuestDietaryRow({
  bookingId,
  guest,
  canEdit,
}: {
  bookingId: string;
  guest: BookingGuestDietaryRow;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(guest.dietaryRequirements ?? "");
  const [saving, setSaving] = useState(false);
  const name = `${guest.firstName} ${guest.lastName}`;
  const fieldId = `guest-dietary-${guest.id}`;
  const dirty = draft.trim() !== (guest.dietaryRequirements ?? "");

  async function save() {
    setSaving(true);
    try {
      const res = await fetch(`/api/admin/bookings/${bookingId}/guest-dietary`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          guestId: guest.id,
          // C2: who this row showed; the server refuses if it is somebody else now.
          occupant: {
            memberId: guest.memberId,
            firstName: guest.firstName,
            lastName: guest.lastName,
            ageTier: guest.ageTier,
          },
          dietaryRequirements: draft,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        toast.error(body?.error ?? "Could not save the dietary/allergy information.");
        return;
      }
      toast.success(`Saved for ${name}.`);
      setEditing(false);
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  return (
    <li className="space-y-2 border-b pb-4 last:border-b-0 last:pb-0">
      <div className="flex items-center justify-between gap-2">
        <p className="font-medium">
          {name}
          {!guest.isMember && (
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              Non-member
            </span>
          )}
        </p>
        {canEdit && !editing && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label={`Edit dietary/allergy information for ${name}`}
            onClick={() => {
              setDraft(guest.dietaryRequirements ?? "");
              setEditing(true);
            }}
          >
            Edit
          </Button>
        )}
      </div>
      {editing ? (
        <div className="space-y-2">
          <MemberDietaryRequirementsField
            id={fieldId}
            value={draft}
            onChange={setDraft}
            audience="booking"
            disabled={saving}
          />
          <div className="flex gap-2">
            <Button type="button" size="sm" onClick={save} disabled={saving || !dirty}>
              {saving ? "Saving…" : "Save"}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={saving}
              onClick={() => {
                setDraft(guest.dietaryRequirements ?? "");
                setEditing(false);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <p className="whitespace-pre-wrap text-sm">
          {guest.dietaryRequirements ?? (
            <span className="text-muted-foreground">None recorded</span>
          )}
        </p>
      )}
    </li>
  );
}
