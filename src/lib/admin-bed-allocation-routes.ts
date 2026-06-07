import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { isEffectiveModuleEnabled } from "@/lib/admin-modules";
import { BedAllocationAdminError } from "@/lib/admin-bed-allocation";
import { requireAdmin } from "@/lib/session-guards";

export async function requireBedAllocationAdmin() {
  const guard = await requireAdmin();
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

export function bedAllocationErrorResponse(error: unknown) {
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
  }

  return NextResponse.json(
    { error: "Bed allocation request failed" },
    { status: 500 },
  );
}
