import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import { logAudit } from "@/lib/audit";
import { LODGE_CAPACITY } from "@/lib/lodge-capacity";

const groupDiscountSchema = z.object({
  minGroupSize: z.number().int().min(2).max(LODGE_CAPACITY),
  summerOnly: z.boolean(),
  enabled: z.boolean(),
});

export async function GET() {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) return inactiveResponse;

  const setting = await prisma.groupDiscountSetting.findUnique({
    where: { id: "default" },
  });

  return NextResponse.json(
    setting || { id: "default", minGroupSize: 5, summerOnly: true, enabled: false }
  );
}

export async function PUT(req: NextRequest) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) return inactiveResponse;

  const body = await req.json();
  const parsed = groupDiscountSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 400 }
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
