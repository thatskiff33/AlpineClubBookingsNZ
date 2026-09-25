import { NextRequest, NextResponse } from "next/server";
import { AgeTier } from "@prisma/client";
import { z } from "zod";
import { createAuditLog } from "@/lib/audit";
import {
  DIETARY_REQUIREMENTS_TOO_LONG_MESSAGE,
  isDietaryRequirementsWithinLimit,
} from "@/lib/member-dietary-field";
import {
  grantBookingAdminDietaryAccess,
  isDietaryFieldEnabled,
  updateBookingGuestDietaryRequirements,
} from "@/lib/member-dietary";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";

/**
 * The body: exactly one guest and its new value. `dietaryRequirements` is
 * REQUIRED here — a string, or null / a blank string to clear it — because the
 * shared JSON schema treats an absent key as "leave it alone", and on this route
 * an absent key would otherwise arrive as a clear. The limit is the shared one.
 */
const guestDietarySchema = z
  .object({
    guestId: z.string().min(1),
    // C2: the occupant the editor was shown. The write matches it, so a row
    // rewritten in place since the page loaded is refused, not overwritten.
    occupant: z
      .object({
        memberId: z.string().min(1).nullable(),
        firstName: z.string(),
        lastName: z.string(),
        ageTier: z.nativeEnum(AgeTier),
      })
      .strict(),
    dietaryRequirements: z
      .string()
      .nullable()
      .refine(isDietaryRequirementsWithinLimit, {
        message: DIETARY_REQUIREMENTS_TOO_LONG_MESSAGE,
      }),
  })
  .strict();

/**
 * PATCH /api/admin/bookings/[id]/guest-dietary (#3029, `INV-PRIV-022`,
 * `INV-MOD-059`).
 *
 * Changes ONE guest's dietary/allergy information for THIS stay. It is the
 * only write of a stored booking value, and it is deliberately narrow:
 *  - `bookings:edit`, checked by `requireAdmin` and again, from the database,
 *    by the edit grant;
 *  - refused while the club has the field OFF (OFF hides and never clears, so
 *    it cannot be edited either);
 *  - one row, matched on BOTH the booking id and the guest id, on a booking that
 *    is not deleted — a guest id from another booking is a 404;
 *  - never the member's profile, and not a booking modification: no reprice, no
 *    email, no Xero (`INV-MOD-001`);
 *  - audited under `booking` as "changed" or "cleared", never with the value.
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireAdmin({
    permission: { area: "bookings", level: "edit" },
  });
  if (!guard.ok) return guard.response;

  const enabled = await isDietaryFieldEnabled();
  if (!enabled) {
    return NextResponse.json(
      { error: "Dietary/allergy information is switched off for this club." },
      { status: 409 },
    );
  }
  const grant = await grantBookingAdminDietaryAccess(guard, "edit", { enabled });
  if (!grant) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = guestDietarySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { id: bookingId } = await params;
  const { guestId } = parsed.data;
  const result = await prisma.$transaction(async (tx) => {
    const edited = await updateBookingGuestDietaryRequirements(
      grant,
      {
        bookingId,
        guestId,
        value: parsed.data.dietaryRequirements,
        occupant: parsed.data.occupant,
      },
      tx,
    );
    if (edited.status === "updated" && edited.changed) {
      await createAuditLog(
        {
          action: edited.cleared
            ? "booking.guest_dietary.cleared"
            : "booking.guest_dietary.updated",
          memberId: guard.session.user.id,
          targetId: bookingId,
          details: edited.cleared
            ? "Admin cleared a guest's dietary/allergy information for this stay"
            : "Admin changed a guest's dietary/allergy information for this stay",
          category: "booking",
          outcome: "success",
          // Evidence of WHICH row changed and that the field did — never the
          // value (`INV-PRIV-022`; the audit sanitizer would redact a string
          // under this key anyway).
          metadata: { bookingGuestId: guestId, dietaryRequirementsChanged: true },
        },
        tx,
      );
    }
    return edited;
  });

  if (result.status === "occupant-changed") {
    return NextResponse.json(
      { error: "This guest has changed since the page loaded. Reload and try again." },
      { status: 409 },
    );
  }
  if (result.status === "not-found") {
    return NextResponse.json({ error: "Guest not found on this booking" }, { status: 404 });
  }
  return NextResponse.json({
    guestId,
    dietaryRequirements: result.value,
  });
}
