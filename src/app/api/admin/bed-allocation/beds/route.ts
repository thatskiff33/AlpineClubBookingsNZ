import { NextResponse } from "next/server";
import { BedType } from "@prisma/client";
import { z } from "zod";
import { createBedAllocationBed } from "@/lib/admin-bed-allocation";
import {
  bedAllocationErrorResponse,
  requireBedInventoryWrite,
} from "@/lib/admin-bed-allocation-routes";
import { parseJsonRequestBody } from "@/lib/api-json";
import { logAudit } from "@/lib/audit";
import { revalidatePublicSite } from "@/lib/public-content-revalidation";

// requireAdmin() is enforced by requireBedAllocationAdmin().
const bedSchema = z
  .object({
    roomId: z.string().min(1),
    name: z.string().trim().min(1).max(100),
    sortOrder: z.coerce.number().int().min(0).max(10000).default(0),
    active: z.boolean().default(true),
    // Descriptive bed type (#1675); mirrors the Prisma BedType enum.
    bedType: z.nativeEnum(BedType).default(BedType.SINGLE),
    // Bunk-pairing label; validated server-side in createBedAllocationBed.
    bunkGroup: z.string().trim().max(50).nullable().optional(),
  })
  .strict();

export async function POST(request: Request) {
  const guard = await requireBedInventoryWrite();
  if (!guard.ok) return guard.response;

  try {
    const json = await parseJsonRequestBody(request);
    if (!json.ok) return json.response;

    const body = bedSchema.safeParse(json.body);
    if (!body.success) {
      return NextResponse.json(
        { error: "Invalid input", details: body.error.flatten() },
        { status: 400 },
      );
    }

    const bed = await createBedAllocationBed(body.data);
    revalidatePublicSite();
    logAudit({
      action: "BED_ALLOCATION_BED_CREATED",
      memberId: guard.session.user.id,
      entityType: "LodgeBed",
      entityId: bed.id,
      category: "admin",
      outcome: "success",
      summary: "Bed allocation bed created",
      metadata: {
        bedId: bed.id,
        roomId: bed.roomId,
        name: bed.name,
        bedType: bed.bedType,
        bunkGroup: bed.bunkGroup,
      },
    });

    return NextResponse.json({ bed }, { status: 201 });
  } catch (error) {
    return bedAllocationErrorResponse(error);
  }
}
