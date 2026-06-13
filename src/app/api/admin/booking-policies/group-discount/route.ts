import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import { logAudit } from "@/lib/audit";
import { getLodgeCapacity } from "@/lib/lodge-capacity";

const groupDiscountSchema = z.object({
  minGroupSize: z.number().int().min(2).max(200),
  summerOnly: z.boolean(),
  enabled: z.boolean(),
});

export async function GET() {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const setting = await prisma.groupDiscountSetting.findUnique({
    where: { id: "default" },
  });

  return NextResponse.json(
    setting || { id: "default", minGroupSize: 5, summerOnly: true, enabled: false }
  );
}

export async function PUT(req: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const session = guard.session;
  const body = await req.json();
  const parsed = groupDiscountSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const lodgeCapacity = await getLodgeCapacity();
  if (parsed.data.minGroupSize > lodgeCapacity) {
    return NextResponse.json(
      { error: `Minimum group size cannot exceed lodge capacity (${lodgeCapacity}).` },
      { status: 400 },
    );
  }

  const result = await prisma.groupDiscountSetting.upsert({
    where: { id: "default" },
    update: parsed.data,
    create: { id: "default", ...parsed.data },
  });

  logAudit({
    action: "group-discount.update",
    memberId: session.user.id,
    details: `Group discount: minSize=${parsed.data.minGroupSize}, summerOnly=${parsed.data.summerOnly}, enabled=${parsed.data.enabled}`,
  });

  return NextResponse.json(result);
}
