import { NextResponse } from "next/server";
import { z } from "zod";
import { createBedAllocationBed } from "@/lib/admin-bed-allocation";
import {
  bedAllocationErrorResponse,
  requireBedAllocationAdmin,
} from "@/lib/admin-bed-allocation-routes";
import { logAudit } from "@/lib/audit";

// requireAdmin() is enforced by requireBedAllocationAdmin().
const bedSchema = z
  .object({
    roomId: z.string().min(1),
    name: z.string().trim().min(1).max(100),
    sortOrder: z.coerce.number().int().min(0).max(10000).default(0),
    active: z.boolean().default(true),
  })
  .strict();

export async function POST(request: Request) {
  const guard = await requireBedAllocationAdmin();
  if (!guard.ok) return guard.response;

  try {
    const body = bedSchema.safeParse(await request.json());
    if (!body.success) {
      return NextResponse.json(
        { error: "Invalid input", details: body.error.flatten() },
        { status: 400 },
      );
    }

    const bed = await createBedAllocationBed(body.data);
    logAudit({
      action: "BED_ALLOCATION_BED_CREATED",
      memberId: guard.session.user.id,
      entityType: "LodgeBed",
      entityId: bed.id,
      category: "admin",
      outcome: "success",
      summary: "Bed allocation bed created",
      metadata: { bedId: bed.id, roomId: bed.roomId, name: bed.name },
    });

    return NextResponse.json({ bed }, { status: 201 });
  } catch (error) {
    return bedAllocationErrorResponse(error);
  }
}
