import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { isEffectiveModuleEnabled } from "@/lib/admin-modules";
import { BedAllocationAdminError } from "@/lib/admin-bed-allocation";
import { BedAllocationSettingsValidationError } from "@/lib/bed-allocation-settings";
import { requireAdmin } from "@/lib/session-guards";

async function requireBedAllocationPermission(
  level: "view" | "edit",
) {
  const guard = await requireAdmin({ permission: { area: "bookings", level } });
  if (!guard.ok) {
    return { ok: false as const, response: guard.response };
  }

  if (!(await isEffectiveModuleEnabled("bedAllocation"))) {
    return {
      ok: false as const,
      response: NextResponse.json({ error: "Not found" }, { status: 404 }),
    };
  }

  return { ok: true as const, session: guard.session };
}

/** Bed-board/settings reads require the explicit bookings:view contract. */
export function requireBedAllocationRead() {
  return requireBedAllocationPermission("view");
}

/** Every allocation/settings/approval mutation requires bookings:edit. */
export function requireBedAllocationWrite() {
  return requireBedAllocationPermission("edit");
}

/** Semantic inventory read helper; D-R17 preserves bookings:view. */
export function requireBedInventoryRead() {
  return requireBedAllocationPermission("view");
}

/** Semantic inventory write helper; D-R17 preserves bookings:edit. */
export function requireBedInventoryWrite() {
  return requireBedAllocationPermission("edit");
}

export function bedAllocationErrorResponse(error: unknown) {
  if (error instanceof BedAllocationSettingsValidationError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  if (error instanceof BedAllocationAdminError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2002") {
      return NextResponse.json(
        { error: "A room or bed with that name already exists." },
        { status: 409 },
      );
    }
    if (error.code === "P2025") {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if (error.code === "P2003") {
      // #2286: a HutLeaderAssignment_bedId_fkey violation means the bed is held
      // for a custodian, not that it has allocation history — the generic
      // message would steer the admin to "deactivate it instead", which the
      // custodian guard also refuses, leaving them with no way forward. Tested
      // first because the raw pg message names both tables.
      const meta = error.meta as
        | { field_name?: unknown; constraint?: unknown }
        | undefined;
      const text = [
        error.message,
        typeof meta?.field_name === "string" ? meta.field_name : "",
        typeof meta?.constraint === "string" ? meta.constraint : "",
      ]
        .join(" ")
        .toLowerCase();
      if (text.includes("hutleaderassignment")) {
        return NextResponse.json(
          {
            error:
              "This bed is held by a hut-leader assignment and cannot be deleted. Clear the bed on the Hut Leaders page first.",
          },
          { status: 409 },
        );
      }
      return NextResponse.json(
        { error: "Cannot delete a bed with allocation history; deactivate it instead." },
        { status: 409 },
      );
    }
    // Write conflict / deadlock the database resolved by aborting us. Nothing
    // was written, and trying again usually succeeds — so say that, rather than
    // letting it fall through to a generic 500 (#2251 review A3). The range path
    // already retries this once itself before it can reach here.
    if (error.code === "P2034") {
      return NextResponse.json(
        {
          error:
            "That change collided with another one being saved at the same moment. Nothing was written — reload and try again.",
        },
        { status: 409 },
      );
    }
    // The transaction ran out of time (or was already closed). Again nothing was
    // committed, and the actionable advice is specific: ask for less at once.
    if (error.code === "P2028") {
      return NextResponse.json(
        {
          error:
            "That took too long to save and was rolled back — nothing was written. Try a shorter date range.",
        },
        { status: 503 },
      );
    }
  }

  return NextResponse.json(
    { error: "Bed allocation request failed" },
    { status: 500 },
  );
}
